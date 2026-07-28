import math

from pipeline.isochrones import (
    arrival_min,
    build_isochrones,
    cluster_points,
    isochrone_features,
)


def pt(lon, lat, age):
    """A pixel whose fire arrived `age` minutes ago and is still active."""
    return {"lon": lon, "lat": lat, "age_min": 5, "first_min": age}


def test_arrival_prefers_first_seen_over_last_active():
    # Meteosat refreshes a burning pixel every 10 min, so age_min says only
    # "still burning" — arrival must come from first_min.
    assert arrival_min({"age_min": 5, "first_min": 600}) == 600
    assert arrival_min({"age_min": 42}) == 42  # fallback when never deduped
    assert arrival_min({}) is None


def _ring_area_deg2(ring):
    """Shoelace area, only used to compare band sizes."""
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(a) / 2


def _band_area(band):
    return sum(_ring_area_deg2(poly[0]) for poly in band["geometry"]["coordinates"])


def _line(n=12, lon0=8.0, lat=45.0, step=0.02, age_head=10, age_tail=600):
    """A fire that ran west→east: oldest at the tail, freshest at the head."""
    return [
        pt(lon0 + i * step, lat, age_tail - (age_tail - age_head) * i / (n - 1))
        for i in range(n)
    ]


def test_bands_ordered_oldest_first():
    bands = build_isochrones(_line(), bands=[60, 180, 720])
    assert [b["max_age"] for b in bands] == [720, 180, 60]


def test_newer_bands_are_strictly_smaller():
    """The point of an isochrone: each shorter time encloses less area."""
    bands = {b["max_age"]: _band_area(b) for b in build_isochrones(_line(), bands=[60, 180, 720])}
    assert bands[60] < bands[180] < bands[720]


def test_newest_band_sits_at_the_fire_head():
    bands = {b["max_age"]: b for b in build_isochrones(_line(), bands=[60, 720])}
    head_lon = max(
        x for poly in bands[60]["geometry"]["coordinates"] for x, _ in poly[0]
    )
    tail_lon = min(
        x for poly in bands[720]["geometry"]["coordinates"] for x, _ in poly[0]
    )
    # Fresh activity is at the eastern head, not spread over the whole scar.
    assert head_lon > tail_lon + 0.1


def test_contour_is_not_a_buffer_blob():
    """A dilation of 2 points would be two fat circles; a contour is tighter."""
    bands = build_isochrones(_line(n=6, step=0.03), bands=[720])
    area = _band_area(bands[0])
    # Bounding box of the detections is ~0.15 x 0 deg; a 3 km dilation blob
    # would exceed this generous ceiling.
    assert area < 0.02


def test_bands_are_contours_not_discs_around_each_pixel():
    """Regression: a hard-cutoff minimum makes every level set a union of
    discs — mathematically identical to buffering, just drawn on a grid.

    Along a line of detections whose arrival sweeps west→east, a young band
    must be ONE elongated region near the head, not one disc per pixel.
    """
    pts = _line(n=10, lon0=8.0, step=0.02, age_head=30, age_tail=600)
    band = build_isochrones(pts, bands=[180])[0]
    polys = band["geometry"]["coordinates"]
    assert len(polys) == 1, f"expected a single contour, got {len(polys)} discs"
    xs = [x for x, _ in polys[0][0]]
    ys = [y for _, y in polys[0][0]]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    # A disc would be near-circular in the cos(lat)-corrected sense; the real
    # contour is stretched along the fire's axis.
    assert width > height * 1.5, f"contour looks circular: {width:.4f} x {height:.4f}"


def test_every_detection_falls_inside_some_band():
    """Regression: bands stopped at 12 h, so the bulk of a real fire — which
    arrived longer ago than that — was drawn nowhere at all.
    """
    from pipeline.isochrones import DEFAULT_BANDS

    # Ages spanning well past the 12 h threshold, as on a multi-day fire.
    pts = [pt(8.0 + i * 0.02, 45.0, 30 + i * 400) for i in range(8)]
    oldest = max(p["first_min"] for p in pts)
    assert oldest > 720, "fixture must exercise the open-ended band"

    bands = build_isochrones(pts)
    assert max(b["max_age"] for b in bands) >= oldest, (
        "no band covers the oldest arrival; part of the fire renders nowhere"
    )
    assert DEFAULT_BANDS[-1] >= oldest


def test_bands_mirror_the_frontend_legend_classes():
    from pipeline.isochrones import DEFAULT_BANDS

    # AGE_STOPS in web/src/map.ts
    assert DEFAULT_BANDS == [20, 60, 180, 360, 720, 9999]


def test_separate_fires_do_not_merge():
    far = _line(lon0=8.0) + _line(lon0=20.0)
    bands = build_isochrones(far, bands=[720])
    assert len(bands[0]["geometry"]["coordinates"]) >= 2


def test_clustering_splits_distant_groups():
    groups = cluster_points(_line(lon0=8.0) + _line(lon0=20.0))
    assert len(groups) == 2


def test_high_latitude_still_produces_bands():
    """Longitude spacing must be cos(lat)-corrected or northern fires vanish."""
    lat = 69.0
    step = 0.02 / math.cos(math.radians(lat))
    bands = build_isochrones(_line(lat=lat, step=step), bands=[720])
    assert bands and bands[0]["geometry"]["coordinates"]


def test_no_ages_no_bands():
    assert build_isochrones([{"lon": 8.0, "lat": 45.0}]) == []
    assert build_isochrones([]) == []


def test_flat_last_active_still_yields_progression():
    """Regression: every pixel still burning must not collapse to one band.

    All pixels share age_min=5 (all currently active) but arrived at different
    times. Using last-active would give a single blob.
    """
    bands = build_isochrones(_line(), bands=[60, 180, 720])
    assert len(bands) >= 2


def test_lone_pixel_makes_no_surface():
    assert build_isochrones([pt(8.0, 45.0, 10)]) == []


def test_features_carry_max_age():
    feats = isochrone_features(_line(), bands=[720])
    assert feats[0]["properties"]["max_age"] == 720
    assert feats[0]["geometry"]["type"] == "MultiPolygon"
