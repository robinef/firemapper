import pytest

from pipeline import run
from pipeline.config import load_settings
from pipeline.fetch_firms import append_hotspots
from pipeline.run import process
from tests.synth import T, hs


def test_process_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.run.fetch_gdacs", lambda: [])
    # No snapshot under a fresh tmp_path means should_fetch() says yes and the
    # real EFFIS WFS/stats requests fire. Stub both: this test must not depend
    # on the network, and offline it would hang for minutes.
    monkeypatch.setattr("pipeline.run.fetch_season_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr("pipeline.run.fetch_stats_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr("pipeline.run.mtg_frp_extent", lambda: None)
    monkeypatch.setattr("pipeline.run.fetch_frp_points", lambda bbox: [])
    monkeypatch.setattr("pipeline.run.fetch_wind", lambda pts: [])
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    rows = [
        hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6)),
        hs(45.0, 8.0, T(20, 5), tier="meteosat", frp=200),
    ]
    append_hotspots(rows, s.data_dir / "raw" / "hotspots.parquet")
    gen = process(s, now=T(20, 12))
    assert (s.out_dir / "manifest.json").exists()
    assert (gen / "events.geojson").exists()


def test_static_source_dropped_from_events_but_kept_in_the_live_frp_heatmap(tmp_path, monkeypatch):
    """A static heat source disappears from events/timeline/day-slices but
    the live FRP heatmap stays the raw sensor layer — a flare shows as a hot
    pixel, not as a fire event (design spec, 2026-09-07)."""
    from pipeline.config import STATIC_CELL_DAYS
    import h3
    import json

    monkeypatch.setattr("pipeline.run.fetch_gdacs", lambda: [])
    monkeypatch.setattr("pipeline.run.fetch_season_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr("pipeline.run.fetch_stats_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr("pipeline.run.mtg_frp_extent", lambda: None)
    monkeypatch.setattr("pipeline.run.fetch_wind", lambda pts: [])
    now = T(31, 23)
    flare_lat, flare_lon = 45.0, 8.0
    monkeypatch.setattr(
        "pipeline.run.fetch_frp_points",
        lambda bbox, now: [{"lat": flare_lat, "lon": flare_lon, "frp": 12.0, "time": now.isoformat()}],
    )
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    real_lat, real_lon = 50.0, 10.0  # a genuine one-off detection, far from the flare
    rows = [hs(flare_lat, flare_lon, T(d, 12)) for d in range(1, STATIC_CELL_DAYS + 1)]
    rows.append(hs(real_lat, real_lon, T(31, 6)))
    append_hotspots(rows, s.data_dir / "raw" / "hotspots.parquet")

    gen = process(s, now=now)

    events = json.loads((gen / "events.geojson").read_text())["features"]
    static_cell = h3.latlng_to_cell(flare_lat, flare_lon, 8)
    assert not any(
        h3.latlng_to_cell(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0], 8) == static_cell
        for f in events
    ), "static source must not appear as a live event"

    frp = json.loads((gen / "frp.geojson").read_text())["features"]
    assert len(frp) == 1, "the flare pixel must still render on the raw FRP heatmap"

    manifest = json.loads((s.out_dir / "manifest.json").read_text())
    by_date = {d["date"]: d["count"] for d in manifest["timeline"]}
    assert by_date["2026-07-31"] == 1, "timeline must count the real detection, not the flare"
    assert by_date["2026-07-10"] == 0, "the flare's own days must be excluded from the timeline"
    assert not (gen / "days" / "2026-07-01.json").exists(), \
        "the flare's day-slice must not be published at all (no other detections that day)"


def test_full_refresh_without_key_raises(tmp_path):
    """A missing FIRMS key must stop the run. Degrading silently is what
    published a 30-day timeline of zeroes to production."""
    settings = load_settings(env={
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })
    with pytest.raises(RuntimeError, match="FIRMS_MAP_KEY"):
        run.refresh(settings, tier="full")


def test_fast_refresh_skips_the_polar_archive(tmp_path, monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(run, "fetch_firms", lambda *a, **k: called.append("firms"))
    monkeypatch.setattr(run, "fetch_firms_history", lambda *a, **k: called.append("history"))
    monkeypatch.setattr(run, "fetch_meteosat", lambda *a, **k: called.append("meteosat"))
    monkeypatch.setattr(run, "process", lambda *a, **k: called.append("process"))
    settings = load_settings(env={
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })

    run.refresh(settings, tier="fast")

    assert called == ["process"]


def test_full_refresh_with_key_fetches_everything(tmp_path, monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(run, "fetch_firms", lambda *a, **k: called.append("firms"))
    monkeypatch.setattr(run, "fetch_firms_history", lambda *a, **k: called.append("history"))
    monkeypatch.setattr(run, "fetch_meteosat", lambda *a, **k: called.append("meteosat"))
    monkeypatch.setattr(run, "process", lambda *a, **k: called.append("process"))
    settings = load_settings(env={
        "FIRMS_MAP_KEY": "k",
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })

    run.refresh(settings, tier="full")

    # history BEFORE firms: the NRT poll stamps the store with today, and
    # fetch_firms_history skips every window ending at or below the latest
    # stored day — reversing these silently reduces a 30-day seed to 2 days.
    assert called == ["history", "firms", "meteosat", "process"]


def test_unknown_tier_is_rejected(tmp_path):
    settings = load_settings(env={
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })
    with pytest.raises(ValueError, match="unknown tier"):
        run.refresh(settings, tier="medium")


def test_failed_frp_does_not_publish_wind_as_empty(tmp_path, monkeypatch):
    """Observed in CI 2026-07-30: the MTG fetch returned nothing, wind samples
    are taken AT the fire pixels, so wind became 0 too - and both were published
    as `empty`, replacing good data on the live map. Wind must inherit the
    upstream failure so it is carried instead."""
    from pipeline import run as run_mod

    def boom(*a, **k):
        raise RuntimeError("EUMETView unreachable")

    monkeypatch.setattr(run_mod, "fetch_frp_points", boom)
    monkeypatch.setattr(run_mod, "fetch_wind", lambda *a, **k: [{"lon": 1, "lat": 1}])
    monkeypatch.setattr(run_mod, "mtg_frp_extent", lambda *a, **k: None)
    monkeypatch.setattr(run_mod, "build_imagery", lambda *a, **k: None)
    # See test_process_end_to_end: unpatched, this reaches live EFFIS backends.
    monkeypatch.setattr(run_mod, "fetch_season_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr(run_mod, "fetch_stats_snapshot", lambda *a, **k: "stale")

    captured = {}

    def fake_export(*args, **kwargs):
        captured.update(kwargs.get("results") or {})
        return tmp_path / "gen-x"

    monkeypatch.setattr(run_mod, "export", fake_export)
    settings = load_settings(env={
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })

    run_mod.process(settings, now=T(20, 12))

    assert captured["frp"].status == "failed"
    assert captured["wind"].status == "failed", "wind must not claim it looked and found nothing"
