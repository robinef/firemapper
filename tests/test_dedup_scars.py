"""_dedup_scars drops a scar that is really the same fire as one already kept,
so an EFFIS-sourced polygon does not double up next to our own FIRMS-derived
scar for the same event. Was keyed on `(round(lon, 2), round(lat, 2))` — a
fixed 0.01 deg grid — which missed a real duplicate whose two independently
computed centroids (FIRMS cell-weighted vs EFFIS polygon centroid) landed
1.09 km apart, straddling a grid boundary: Ares (-1.0438, 44.8351) and
Gironde (-1.0326, 44.8408), the same ~372 km2 event, 20 Jul-3 Aug vs
22 Jul-5 Aug 2026."""
from pipeline.fetch_imagery import _dedup_scars


def _scar(sid, lon, lat, area_km2, before, after):
    return {
        "id": sid, "label": sid, "lon": lon, "lat": lat, "area_km2": area_km2,
        "before": before, "after": after,
    }


ARES = _scar("1be47439ca4d", -1.0438, 44.8351, 375.9, "2026-07-14", "2026-08-03")
GIRONDE = _scar("562583", -1.0326, 44.8408, 371.9, "2026-07-16", "2026-08-05")


def test_the_real_ares_gironde_duplicate_is_deduped():
    out = _dedup_scars([ARES, GIRONDE])
    assert [s["id"] for s in out] == ["1be47439ca4d"]  # first occurrence wins


def test_first_occurrence_wins_regardless_of_which_source_lists_it_first():
    out = _dedup_scars([GIRONDE, ARES])
    assert [s["id"] for s in out] == ["562583"]


def test_a_grid_rounding_boundary_no_longer_hides_the_duplicate():
    """The bug this replaces: round(lon, 2) put these in different buckets
    (-1.04 vs -1.03) even though they are 1.09 km apart, well inside the
    same ~372 km2 fire's own footprint."""
    out = _dedup_scars([ARES, GIRONDE])
    assert len(out) == 1


def test_two_small_fires_a_few_km_apart_stay_separate():
    a = _scar("a", -1.0, 44.8, 2.0, "2026-07-14", "2026-08-03")
    b = _scar("b", -1.05, 44.8, 2.0, "2026-07-14", "2026-08-03")  # ~4 km away

    out = _dedup_scars([a, b])

    assert [s["id"] for s in out] == ["a", "b"]


def test_same_location_different_years_stays_separate():
    """A real recurrence risk: the same spot burning again years apart must
    never be merged into one card just because it is geographically close."""
    a = _scar("2022-fire", -1.0, 44.8, 300.0, "2022-07-05", "2022-08-20")
    b = _scar("2026-fire", -1.0, 44.8, 300.0, "2026-07-14", "2026-08-03")

    out = _dedup_scars([a, b])

    assert [s["id"] for s in out] == ["2022-fire", "2026-fire"]


def test_exact_duplicate_at_the_same_point_is_still_deduped():
    a = _scar("a", -1.0, 44.8, 10.0, "2026-07-14", "2026-08-03")
    b = _scar("b", -1.0, 44.8, 10.0, "2026-07-14", "2026-08-03")

    out = _dedup_scars([a, b])

    assert [s["id"] for s in out] == ["a"]


def test_a_much_larger_second_fire_far_away_is_not_swallowed():
    """Guards against a threshold that scales with the SECOND scar's size
    dragging in something unrelated: distance here (500+ km) dwarfs even a
    huge fire's own radius."""
    small = _scar("small", -1.0, 44.8, 5.0, "2026-07-14", "2026-08-03")
    huge_far_away = _scar("huge", 20.0, 44.8, 900.0, "2026-07-14", "2026-08-03")

    out = _dedup_scars([small, huge_far_away])

    assert [s["id"] for s in out] == ["small", "huge"]
