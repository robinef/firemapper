"""What export writes for the season layer.

Three things here are the point and each one is a defect that has already been
drafted at least once:

1. `observed_at` is NULL. `fetch_result.py` reserves that field for the newest
   observation INSIDE a payload, and EFFIS publishes no such timestamp, so the
   page's "as of" date can only come from `fetched_at`. An early spec had the
   two inverted, which would have dated the archive by when we polled it.
2. `min_fire_ha` travels as DATA. The page's "fires larger than 30 ha only"
   caveat must be able to drift only when the source's mapping unit does.
3. A missing `season.json` never blocks publication. The season page is
   educational; the map carries live fire data. See `freshness.py` for the run
   where one upstream 400 froze the whole map.
"""
import json
from datetime import datetime, timedelta, timezone

SEASON = {
    "season_year": 2026, "total_km2": 10240.3, "area_count": 1184,
    "unassigned_count": 3, "undated_count": 0,
    "unit": {"name": "Greater London", "km2": 1572.0, "count": 6.5},
    "countries": [
        {"name": "Spain", "km2": 2940.1, "areas": 402,
         "unit": {"name": "Paris", "km2": 105.4, "count": 27.9}},
    ],
}
NOW = datetime(2026, 7, 12, 4, 11, tzinfo=timezone.utc)


def test_season_json_is_written(export_gen):
    gen = export_gen(season=SEASON, season_status="fresh", now=NOW)
    payload = json.loads((gen / "season.json").read_text())
    assert payload["total_km2"] == 10240.3
    assert payload["area_count"] == 1184
    assert payload["season_year"] == 2026
    assert payload["unassigned_count"] == 3
    assert payload["undated_count"] == 0
    assert payload["status"] == "fresh"
    assert payload["unit"]["name"] == "Greater London"
    assert payload["countries"][0]["unit"]["name"] == "Paris"


def test_the_mapping_unit_travels_as_data_not_as_page_copy(export_gen):
    """EFFIS maps burns above 30 ha. The caveat on the page renders from this
    field, so it cannot drift away from the source it describes."""
    from pipeline.export import EFFIS_MIN_FIRE_HA

    gen = export_gen(season=SEASON, season_status="fresh", now=NOW)
    payload = json.loads((gen / "season.json").read_text())
    assert payload["min_fire_ha"] == 30
    assert payload["min_fire_ha"] == EFFIS_MIN_FIRE_HA


def test_observed_at_is_null_and_fetched_at_carries_the_date(export_gen):
    gen = export_gen(season=SEASON, season_status="fresh", now=NOW)
    payload = json.loads((gen / "season.json").read_text())
    assert payload["observed_at"] is None
    assert payload["fetched_at"] == "2026-07-12T04:11:00+00:00"


def test_status_travels_into_the_manifest(export_gen):
    gen = export_gen(season=SEASON, season_status="stale", now=NOW)
    manifest = json.loads((gen.parent / "manifest.json").read_text())
    assert manifest["layers"]["season"]["status"] == "stale"
    assert manifest["layers"]["season"]["fetched_at"] == "2026-07-12T04:11:00+00:00"


def test_the_manifest_states_the_null_observed_at_rather_than_omitting_it(export_gen):
    """Same reason the artifact states it: EFFIS has no currency timestamp, so
    this layer HAS no observation time. Absent would read as an export gap."""
    # Distinct `now` per case: the generation dir is named from it, so reusing
    # one would leave the first case's season.json sitting in the second's.
    for offset, (season, status) in enumerate(((SEASON, "fresh"), (None, "unavailable"))):
        gen = export_gen(
            season=season, season_status=status, now=NOW + timedelta(hours=offset)
        )
        entry = json.loads((gen.parent / "manifest.json").read_text())["layers"]["season"]
        assert "observed_at" in entry and entry["observed_at"] is None


def test_no_season_means_no_file_and_unavailable_status(export_gen):
    gen = export_gen(season=None, season_status="unavailable", now=NOW)
    assert not (gen / "season.json").exists()
    manifest = json.loads((gen.parent / "manifest.json").read_text())
    assert manifest["layers"]["season"]["status"] == "unavailable"
    # No payload, so no moment at which we held one. Never `now`: that would
    # date an artifact that does not exist.
    assert manifest["layers"]["season"]["fetched_at"] is None


def test_a_status_without_a_payload_still_reports_the_null_fetch(export_gen):
    """The snapshot can be fresh while the aggregation over it fails. The status
    is the orchestrator's to report and travels unaltered; `fetched_at: null` is
    what tells a client there is no season.json to go and read."""
    gen = export_gen(season=None, season_status="fresh", now=NOW)
    manifest = json.loads((gen.parent / "manifest.json").read_text())
    assert not (gen / "season.json").exists()
    assert manifest["layers"]["season"]["status"] == "fresh"
    assert manifest["layers"]["season"]["fetched_at"] is None


def test_zero_total_is_written_without_a_unit(export_gen):
    """A season that burned nothing is a real state, distinct from no data at
    all: the file is written, and `unit` is null because `pick_unit` refuses a
    non-positive total rather than drawing a grid of no tiles."""
    zero = {**SEASON, "total_km2": 0.0, "area_count": 0, "countries": []}
    zero.pop("unit")
    gen = export_gen(season=zero, season_status="fresh", now=NOW)
    payload = json.loads((gen / "season.json").read_text())
    assert payload["total_km2"] == 0.0
    assert payload["area_count"] == 0
    assert "unit" in payload and payload["unit"] is None
    assert payload["countries"] == []


def test_a_country_without_an_honest_unit_keeps_a_null(export_gen):
    """Country km2 rounds independently of the season total, so a 4 ha
    perimeter is 0.0 km2 under a healthy total and gets no unit key. The
    artifact must still carry the country."""
    season = {**SEASON, "countries": [{"name": "Malta", "km2": 0.0, "areas": 1}]}
    gen = export_gen(season=season, season_status="fresh", now=NOW)
    payload = json.loads((gen / "season.json").read_text())
    assert payload["countries"] == [{"name": "Malta", "km2": 0.0, "areas": 1}]


def test_validate_generation_passes_without_season_json(export_gen):
    """The guard on requirement 3. A generation carrying live fire data must
    publish whether or not the educational season page has anything to say."""
    from pipeline.export import validate_generation

    gen = export_gen(season=None, season_status="unavailable", now=NOW)
    assert not (gen / "season.json").exists()
    assert validate_generation(gen) == []
