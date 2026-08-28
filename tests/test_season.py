"""Season totals aggregated from the api2 JSON snapshot.

No per-fire polygons anymore — the country-alias/fold table this file used
to carry (season.py used to normalize whatever spelling a WFS feature's
`country` property happened to use) is dead: api2's per-country calls are
keyed by ISO3 and already carry the canonical English name.
"""
import json

from pipeline.season import season_totals


def write_snapshot(path, **overrides):
    path.parent.mkdir(parents=True, exist_ok=True)
    snapshot = {
        "fetched_at": "2026-07-12T04:00:00+00:00",
        "season_year": 2026,
        "eu": {"mddate": "20260709", "events": 40, "area_ha": 12345},
        "countries": {
            "FRA": {"name": "France", "mddate": "20260709", "events": 10, "area_ha": 5000},
            "ESP": {"name": "Spain", "mddate": "20260709", "events": 20, "area_ha": 7000},
            "MLT": {"name": "Malta", "mddate": "20260709", "events": 0, "area_ha": 0},
        },
    }
    snapshot.update(overrides)
    path.write_text(json.dumps(snapshot))
    return path


def test_returns_none_when_snapshot_file_is_missing(tmp_path):
    assert season_totals(tmp_path / "missing.json", 2026) is None


def test_totals_come_from_the_eu_entry(tmp_path):
    path = write_snapshot(tmp_path / "snap.json")
    season = season_totals(path, 2026)
    assert season["total_km2"] == 123.5  # 12345 ha / 100
    assert season["event_count"] == 40
    assert season["season_year"] == 2026
    assert season["fetched_at"] == "2026-07-12T04:00:00+00:00"


def test_countries_are_ranked_by_km2_descending(tmp_path):
    path = write_snapshot(tmp_path / "snap.json")
    season = season_totals(path, 2026)
    names = [c["name"] for c in season["countries"]]
    assert names[:2] == ["Spain", "France"]
    assert season["countries"][0] == {"name": "Spain", "km2": 70.0, "events": 20}


def test_zero_km2_countries_are_dropped_from_the_ranking(tmp_path):
    """A country whose season is genuinely zero so far shouldn't crowd the
    top_n ranking or claim a non-existent scale unit downstream."""
    path = write_snapshot(tmp_path / "snap.json")
    season = season_totals(path, 2026)
    assert "Malta" not in [c["name"] for c in season["countries"]]


def test_top_n_slices_the_country_list(tmp_path):
    countries = {
        f"C{i}": {"name": f"Country{i}", "mddate": "20260709", "events": i, "area_ha": (i + 1) * 100}
        for i in range(8)
    }
    path = write_snapshot(tmp_path / "snap.json", countries=countries)
    season = season_totals(path, 2026, top_n=3)
    assert len(season["countries"]) == 3


def test_returns_none_when_snapshot_has_no_eu_data(tmp_path):
    path = write_snapshot(tmp_path / "snap.json", eu=None)
    assert season_totals(path, 2026) is None


def test_returns_none_when_requested_year_does_not_match_snapshots_year(tmp_path):
    """A stale snapshot fetched for 2025 must never be silently relabeled
    2026 after a year rollover — that would print last year's total under
    this year's headline."""
    path = write_snapshot(tmp_path / "snap.json", season_year=2025)
    assert season_totals(path, 2026) is None


def test_returns_none_when_snapshot_is_malformed_json(tmp_path):
    path = tmp_path / "snap.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not json")
    assert season_totals(path, 2026) is None


def test_event_count_defaults_to_zero_never_null(tmp_path):
    """scale_render.ts calls `.toLocaleString()` on event_count with no null
    guard — a None here crashes the page render. fetch_effis_stats.py already
    guarantees a non-null `events` in a fresh snapshot; this is defense in
    depth against an old or hand-edited snapshot that lacks the key."""
    path = write_snapshot(tmp_path / "snap.json", eu={"mddate": "20260709", "area_ha": 12345})
    season = season_totals(path, 2026)
    assert season["event_count"] == 0
