import pytest

from pipeline import run
from pipeline.config import load_settings
from pipeline.fetch_firms import append_hotspots
from pipeline.run import process
from tests.synth import T, hs


def test_process_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.run.fetch_gdacs", lambda: [])
    # No snapshot under a fresh tmp_path means should_fetch() says yes and the
    # real EFFIS WFS request fires (timeout=120). Stub it: this test must not
    # depend on the network, and offline it would hang for minutes.
    monkeypatch.setattr("pipeline.run.fetch_season_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr("pipeline.run.mtg_frp_extent", lambda: None)
    monkeypatch.setattr("pipeline.run.fetch_frp_points", lambda bbox: [])
    monkeypatch.setattr("pipeline.run.fetch_wind", lambda pts: [])
    monkeypatch.setattr("pipeline.run.fetch_aircraft", lambda: [])
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    rows = [
        hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6)),
        hs(45.0, 8.0, T(20, 5), tier="meteosat", frp=200),
    ]
    append_hotspots(rows, s.data_dir / "raw" / "hotspots.parquet")
    gen = process(s, now=T(20, 12))
    assert (s.out_dir / "manifest.json").exists()
    assert (gen / "events.geojson").exists()


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
    monkeypatch.setattr(run_mod, "fetch_aircraft", lambda *a, **k: [])
    monkeypatch.setattr(run_mod, "mtg_frp_extent", lambda *a, **k: None)
    monkeypatch.setattr(run_mod, "build_imagery", lambda *a, **k: None)
    # See test_process_end_to_end: unpatched, this reaches the live EFFIS WFS.
    monkeypatch.setattr(run_mod, "fetch_season_snapshot", lambda *a, **k: "stale")

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
