"""fetch_historical_footprint: real burned-area geometry for
pipeline/notable_scars.json's curated fires, from EFFIS's per-year WFS
(maps.effis.emergency.copernicus.eu/effis, ms:modis.ba.poly.<year> layers —
a separate, live service from the current-season-only REST API in
fetch_effis.py). Confirmed live via manual probe: a 2022 bbox near La
Teste-de-Buch returned real per-detection polygons dated mid-July 2022.

Each WFS layer holds unclustered per-detection polygons (not one row per
named fire event, unlike the current REST API), so a real fire is usually
several of them — fetch_historical_footprint unions every polygon inside the
scar's date window into one footprint.
"""
import json
import time

from pipeline.fetch_effis_historical import fetch_historical_footprint, fetch_historical_footprints

GIRONDE_SCAR = {
    "id": "la-teste-2022", "lon": -1.17, "lat": 44.545, "area_km2": 70.0,
    "before": "2022-07-05", "after": "2022-08-20",
}


def _polygon(coords):
    return {"type": "Polygon", "coordinates": [coords]}


SQUARE_A = _polygon([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])
SQUARE_B = _polygon([[0.5, 0], [0.5, 1], [1.5, 1], [1.5, 0], [0.5, 0]])


def _fc(features):
    return json.dumps({"type": "FeatureCollection", "features": features})


def _feature(geometry, firedate):
    return {"type": "Feature", "geometry": geometry, "properties": {"FIREDATE": firedate}}


def test_unions_multiple_in_window_features_into_one_footprint():
    def http_get(url):
        return _fc([
            _feature(SQUARE_A, "2022-07-12 21:04:00"),
            _feature(SQUARE_B, "2022-07-15 10:28:00"),
        ])

    geometry = fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get)

    assert geometry is not None
    assert geometry["type"] == "Polygon"
    # Two overlapping unit-ish squares union into a wider single ring, not
    # two separate shapes — proves ST_Union_Agg actually ran, not a passthrough.
    xs = [pt[0] for pt in geometry["coordinates"][0]]
    assert min(xs) <= 0.0 and max(xs) >= 1.5


def test_drops_a_feature_outside_the_date_window():
    def http_get(url):
        return _fc([
            _feature(SQUARE_A, "2022-07-12 21:04:00"),
            _feature(SQUARE_B, "2019-01-01 00:00:00"),  # unrelated fire, wrong year's data
        ])

    geometry = fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get)

    xs = [pt[0] for pt in geometry["coordinates"][0]]
    assert max(xs) <= 1.01  # SQUARE_A alone, not unioned with SQUARE_B


def test_no_features_in_window_returns_none():
    def http_get(url):
        return _fc([_feature(SQUARE_A, "2019-01-01 00:00:00")])

    assert fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get) is None


def test_empty_feature_collection_returns_none():
    def http_get(url):
        return _fc([])

    assert fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get) is None


def test_malformed_response_returns_none_not_raise():
    def http_get(url):
        return "not json"

    assert fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get) is None


def test_network_error_returns_none_not_raise():
    def http_get(url):
        raise ConnectionError("effis is down")

    assert fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get) is None


def test_requests_the_year_derived_from_the_before_date():
    seen_urls = []

    def http_get(url):
        seen_urls.append(url)
        return _fc([])

    fetch_historical_footprint(GIRONDE_SCAR, http_get=http_get)

    assert len(seen_urls) == 1
    assert "modis.ba.poly.2022" in seen_urls[0]


def test_a_window_spanning_a_year_boundary_queries_both_years():
    spanning_scar = {**GIRONDE_SCAR, "before": "2022-12-28", "after": "2023-01-05"}
    seen_urls = []

    def http_get(url):
        seen_urls.append(url)
        return _fc([])

    fetch_historical_footprint(spanning_scar, http_get=http_get)

    assert any("modis.ba.poly.2022" in u for u in seen_urls)
    assert any("modis.ba.poly.2023" in u for u in seen_urls)


def test_bbox_is_generous_for_a_large_curated_fire():
    """A ~372 km2 fire's real detections can land several km from the curated
    centroid — the search bbox must not be pinned tight to the point."""
    big_scar = {**GIRONDE_SCAR, "area_km2": 372.0}
    seen_urls = []

    def http_get(url):
        seen_urls.append(url)
        return _fc([])

    fetch_historical_footprint(big_scar, http_get=http_get)

    url = seen_urls[0]
    bbox = url.split("bbox=")[1].split("&")[0]
    minx, _miny, maxx, _maxy = (float(v) for v in bbox.split(","))
    assert (maxx - minx) > 0.1  # well over a ~11 km box in degrees at this latitude


LANDIRAS_SCAR = {
    "id": "landiras-2022", "lon": -0.57, "lat": 44.52, "area_km2": 140.0,
    "before": "2022-07-05", "after": "2022-08-28",
}


def test_fetch_historical_footprints_fetches_all_scars_concurrently():
    """Sequential N-fires-in-a-row round trips is the exact shape
    fetch_effis_stats.py already hit and fixed with a thread pool (see
    COUNTRY_FETCH_WORKERS there) — this must not reintroduce it."""
    in_flight = []
    max_concurrent = [0]

    def http_get(url):
        in_flight.append(1)
        max_concurrent[0] = max(max_concurrent[0], len(in_flight))
        time.sleep(0.05)
        in_flight.pop()
        return _fc([_feature(SQUARE_A, "2022-07-12 00:00:00")])

    fetch_historical_footprints([GIRONDE_SCAR, LANDIRAS_SCAR], http_get=http_get)

    assert max_concurrent[0] > 1


def _bbox_contains_lon(url: str, lon: float) -> bool:
    bbox = url.split("bbox=")[1].split("&")[0]
    minx, _miny, maxx, _maxy = (float(v) for v in bbox.split(","))
    return minx <= lon <= maxx


def test_fetch_historical_footprints_maps_each_result_to_its_own_id():
    def http_get(url):
        if _bbox_contains_lon(url, LANDIRAS_SCAR["lon"]):
            return _fc([])  # no footprint for Landiras
        return _fc([_feature(SQUARE_A, "2022-07-12 00:00:00")])

    results = fetch_historical_footprints([GIRONDE_SCAR, LANDIRAS_SCAR], http_get=http_get)

    assert "la-teste-2022" in results
    assert "landiras-2022" not in results


def test_fetch_historical_footprints_empty_input_makes_no_calls():
    calls = []

    def http_get(url):
        calls.append(url)
        return _fc([])

    assert fetch_historical_footprints([], http_get=http_get) == {}
    assert calls == []


def test_fetch_historical_footprints_one_failure_does_not_drop_the_other():
    def http_get(url):
        if _bbox_contains_lon(url, LANDIRAS_SCAR["lon"]):
            raise ConnectionError("effis is down")
        return _fc([_feature(SQUARE_A, "2022-07-12 00:00:00")])

    results = fetch_historical_footprints([GIRONDE_SCAR, LANDIRAS_SCAR], http_get=http_get)

    assert "la-teste-2022" in results
    assert "landiras-2022" not in results
