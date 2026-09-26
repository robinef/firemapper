"""The season export only runs in the full tier — the fast tier's 30-minute
job has no margin left for it (see scripts/refresh_remote.py)."""
from __future__ import annotations

from datetime import datetime, timezone

import scripts.refresh_remote as rr

SEPT = datetime(2026, 9, 25, 16, 0, tzinfo=timezone.utc)
JAN = datetime(2027, 1, 3, 1, 17, tzinfo=timezone.utc)
FEB = datetime(2027, 2, 1, 0, 17, tzinfo=timezone.utc)
MAR = datetime(2027, 3, 2, 0, 17, tzinfo=timezone.utc)


def _run(monkeypatch, tier: str, now: datetime = SEPT) -> list[str]:
    calls: list[str] = []
    settings = type("S", (), {"r2_configured": True, "r2_bucket": "b", "out_dir": None})()
    monkeypatch.setattr(rr, "load_settings", lambda: settings)
    monkeypatch.setattr(rr, "hydrate", lambda s, c, now: calls.append(f"hydrate:{now:%Y-%m}"))
    monkeypatch.setattr(rr, "refresh", lambda s, tier: calls.append(f"refresh:{tier}"))
    monkeypatch.setattr(rr, "run_export", lambda *a, **k: calls.append(f"scale_blob:{k['target_year']}"))
    monkeypatch.setattr(rr, "run_export_season", lambda *a, **k: calls.append(f"season:{k['target_year']}"))
    monkeypatch.setattr(rr, "season_static_zone", lambda s, year: None)
    monkeypatch.setattr(rr, "_latest_generation", lambda s: "gen-x")
    monkeypatch.setattr(rr, "publish", lambda s, g, c: calls.append("publish"))
    rr.main([tier], client=object(), now=now)
    return calls


def test_full_tier_runs_the_season_export_between_scale_blob_and_publish(monkeypatch):
    assert _run(monkeypatch, "full") == [
        "hydrate:2026-09", "refresh:full", "scale_blob:2026", "season:2026", "publish",
    ]


def test_fast_tier_skips_the_season_export(monkeypatch):
    assert _run(monkeypatch, "fast") == ["hydrate:2026-09", "refresh:fast", "scale_blob:2026", "publish"]


def test_january_full_tier_finishes_the_ended_season_before_the_new_one(monkeypatch):
    # A fire that burned on 30 Dec settles and is archived in January. If the
    # new year's export read it first it would record it as "2026" and skip
    # it — and nothing would ever publish it. So 2026 goes first, every time.
    assert _run(monkeypatch, "full", JAN) == [
        "hydrate:2027-01", "refresh:full",
        "scale_blob:2026", "scale_blob:2027",
        "season:2026", "season:2027",
        "publish",
    ]


def test_january_fast_tier_has_no_room_for_the_ended_season(monkeypatch):
    assert _run(monkeypatch, "fast", JAN) == ["hydrate:2027-01", "refresh:fast", "scale_blob:2027", "publish"]


def test_the_ended_season_is_still_finished_after_the_map_stops_showing_it(monkeypatch):
    # Shown until 1 Feb; its fires can still be re-archived for 45 days.
    assert _run(monkeypatch, "full", FEB) == [
        "hydrate:2027-02", "refresh:full",
        "scale_blob:2026", "scale_blob:2027",
        "season:2026", "season:2027",
        "publish",
    ]


def test_from_march_only_the_new_season_is_exported(monkeypatch):
    assert _run(monkeypatch, "full", MAR) == [
        "hydrate:2027-03", "refresh:full", "scale_blob:2027", "season:2027", "publish",
    ]


def test_each_season_export_gets_its_own_years_nasa_flagged_zone(monkeypatch):
    seen: dict[int, set] = {}
    settings = type("S", (), {"r2_configured": True, "r2_bucket": "b", "out_dir": None})()
    monkeypatch.setattr(rr, "load_settings", lambda: settings)
    monkeypatch.setattr(rr, "hydrate", lambda s, c, now: None)
    monkeypatch.setattr(rr, "refresh", lambda s, tier: None)
    monkeypatch.setattr(rr, "run_export", lambda *a, **k: None)
    monkeypatch.setattr(rr, "run_export_season", lambda *a, **k: seen.__setitem__(k["target_year"], k["extra_zone"]))
    monkeypatch.setattr(rr, "season_static_zone", lambda s, year: None)
    monkeypatch.setattr(rr, "extra_static_zone", lambda year: {f"sp-{year}"})
    monkeypatch.setattr(rr, "_latest_generation", lambda s: "gen-x")
    monkeypatch.setattr(rr, "publish", lambda s, g, c: None)
    rr.main(["full"], client=object(), now=JAN)
    assert seen == {2026: {"sp-2026"}, 2027: {"sp-2027"}}
