"""The season export only runs in the full tier — the fast tier's 30-minute
job has no margin left for it (see scripts/refresh_remote.py)."""
from __future__ import annotations

import scripts.refresh_remote as rr


def _run(monkeypatch, tier: str) -> list[str]:
    calls: list[str] = []
    settings = type("S", (), {"r2_configured": True, "r2_bucket": "b", "out_dir": None})()
    monkeypatch.setattr(rr, "load_settings", lambda: settings)
    monkeypatch.setattr(rr, "hydrate", lambda s, c: None)
    monkeypatch.setattr(rr, "refresh", lambda s, tier: calls.append(f"refresh:{tier}"))
    monkeypatch.setattr(rr, "run_export", lambda *a, **k: calls.append("scale_blob"))
    monkeypatch.setattr(rr, "run_export_season", lambda *a, **k: calls.append("season"))
    monkeypatch.setattr(rr, "_latest_generation", lambda s: "gen-x")
    monkeypatch.setattr(rr, "publish", lambda s, g, c: calls.append("publish"))
    rr.main([tier], client=object())
    return calls


def test_full_tier_runs_the_season_export_between_scale_blob_and_publish(monkeypatch):
    assert _run(monkeypatch, "full") == ["refresh:full", "scale_blob", "season", "publish"]


def test_fast_tier_skips_the_season_export(monkeypatch):
    assert _run(monkeypatch, "fast") == ["refresh:fast", "scale_blob", "publish"]
