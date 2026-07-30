"""Carry-forward at the export boundary.

The live site once published 30 days of zero-count timeline and zero FRP pixels
because a failed fetch and an empty world were indistinguishable. These tests
pin the difference.
"""
from __future__ import annotations

import json
from datetime import timedelta

from pipeline.config import load_settings
from pipeline.events import cluster
from pipeline.export import export
from pipeline.fetch_result import FetchResult
from tests.synth import T, hs


def _settings(tmp_path):
    return load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})


def _frp_point(lon=8.0, lat=45.0, when=None):
    return {"lon": lon, "lat": lat, "frp": 120.0, "time": (when or T(20, 0)).isoformat()}


# 30 minutes after the first export - inside the frp carry window (2 h).
LATER = T(20, 12) + timedelta(minutes=30)


def _manifest(settings) -> dict:
    return json.loads((settings.out_dir / "manifest.json").read_text())


def test_failed_frp_fetch_carries_the_previous_pixels(tmp_path):
    settings = _settings(tmp_path)
    events = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    points = [_frp_point()]

    first = export(
        settings, events, {}, [], [], now=T(20, 12), frp_points=points,
        results={"frp": FetchResult("ok", points, T(20, 12), T(20, 0))},
    )
    first_frp = (first / "frp.geojson").read_text()

    # ...and now the MTG endpoint dies.
    second = export(
        settings, events, {}, [], [], now=LATER, frp_points=[],
        results={"frp": FetchResult("failed", [], LATER)},
    )

    assert (second / "frp.geojson").read_text() == first_frp
    assert _manifest(settings)["layers"]["frp"]["status"] == "carried"


def test_confirmed_empty_frp_publishes_empty(tmp_path):
    """A quiet sky must not render as last hour's fires."""
    settings = _settings(tmp_path)
    events = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    points = [_frp_point()]

    export(
        settings, events, {}, [], [], now=T(20, 12), frp_points=points,
        results={"frp": FetchResult("ok", points, T(20, 12), T(20, 0))},
    )
    second = export(
        settings, events, {}, [], [], now=LATER, frp_points=[],
        results={"frp": FetchResult("empty", [], LATER)},
    )

    assert json.loads((second / "frp.geojson").read_text())["features"] == []
    assert _manifest(settings)["layers"]["frp"]["status"] == "empty"


def test_aircraft_is_never_carried(tmp_path):
    settings = _settings(tmp_path)
    events = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    planes = [{"lon": 8.0, "lat": 45.0, "callsign": "PELICAN 32", "pos_time": 1}]

    export(
        settings, events, {}, [], [], now=T(20, 12), aircraft=planes,
        results={"aircraft": FetchResult("ok", planes, T(20, 12))},
    )
    second = export(
        settings, events, {}, [], [], now=LATER, aircraft=[],
        results={"aircraft": FetchResult("failed", [], LATER)},
    )

    assert json.loads((second / "aircraft.geojson").read_text())["features"] == []
    assert _manifest(settings)["layers"]["aircraft"]["status"] == "failed"


def test_expired_carry_is_dropped(tmp_path):
    """Carried data expires at 2x its budget rather than living forever."""
    settings = _settings(tmp_path)
    events = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    points = [_frp_point()]

    export(
        settings, events, {}, [], [], now=T(20, 12), frp_points=points,
        results={"frp": FetchResult("ok", points, T(20, 12), T(20, 0))},
    )
    # frp budget is 1 h, so a carry is refused beyond 2 h
    late = T(20, 12) + timedelta(hours=3)
    second = export(
        settings, events, {}, [], [], now=late, frp_points=[],
        results={"frp": FetchResult("failed", [], late)},
    )

    assert json.loads((second / "frp.geojson").read_text())["features"] == []
    assert _manifest(settings)["layers"]["frp"]["status"] == "failed"


def test_events_layer_reports_the_newest_detection(tmp_path):
    settings = _settings(tmp_path)
    events = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))

    export(settings, events, {}, [], [], now=T(20, 12))

    entry = _manifest(settings)["layers"]["events"]
    assert entry["observed_at"] == T(20, 6).isoformat()
    assert entry["max_age_s"] == 3 * 3600


def test_tiers_report_what_actually_arrived(tmp_path):
    """The live manifest claimed viirs: true with zero VIIRS detections."""
    settings = _settings(tmp_path)
    meteosat_only = cluster(
        [hs(45.0, 8.0, T(20, 0), tier="meteosat"), hs(45.005, 8.0, T(20, 6), tier="meteosat")],
        now=T(20, 12),
    )

    export(settings, meteosat_only, {}, [], [], now=T(20, 12))

    assert _manifest(settings)["tiers"]["viirs"] is False


def test_publish_refused_when_a_carry_was_available_but_not_applied(tmp_path):
    """Belt and braces: carry-forward should have handled this, so reaching the
    validator with an empty critical layer and a live carry means a bug."""
    import pytest

    from pipeline.export import validate_generation

    settings = _settings(tmp_path)
    gen = settings.out_dir / "gen-20260730T120000Z"
    (gen / "tracks").mkdir(parents=True)
    (gen / "events.geojson").write_text('{"type":"FeatureCollection","features":[]}')
    (gen / "stats.json").write_text('{"detections":{}}')
    (gen / "lineage.json").write_text('{"merged":{},"reactivated":{}}')
    (gen / "frp.geojson").write_text('{"type":"FeatureCollection","features":[]}')

    layers = {"frp": {"status": "failed", "max_age_s": 3600}}
    problems = validate_generation(gen, layers=layers, carry_available={"frp"})

    assert any("frp" in p for p in problems)
    assert validate_generation(gen, layers=layers, carry_available=set()) == []
