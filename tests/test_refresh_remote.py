"""The CI entrypoint must hydrate before it refreshes and publish after.

Out of order, a run would cluster against an empty archive (publishing an empty
map) or publish a generation the bucket's manifest never points at.
"""
from __future__ import annotations

import os
import re

import pytest

from scripts import refresh_remote


@pytest.fixture
def r2_env(monkeypatch):
    for var, value in (
        ("R2_ACCOUNT_ID", "a"), ("R2_ACCESS_KEY_ID", "k"),
        ("R2_SECRET_ACCESS_KEY", "s"), ("R2_BUCKET", "b"),
    ):
        monkeypatch.setenv(var, value)


def test_hydrates_then_refreshes_then_publishes(tmp_path, monkeypatch, r2_env):
    order: list[str] = []
    monkeypatch.setattr(refresh_remote, "hydrate", lambda s, c: order.append("hydrate"))
    monkeypatch.setattr(refresh_remote, "refresh", lambda s, tier: order.append(f"refresh:{tier}"))
    monkeypatch.setattr(refresh_remote, "publish", lambda s, g, c: order.append("publish"))
    monkeypatch.setattr(refresh_remote, "_latest_generation", lambda s: tmp_path / "gen-x")

    assert refresh_remote.main(["fast"], client=object()) == 0
    assert order == ["hydrate", "refresh:fast", "publish"]


def test_defaults_to_the_full_tier(tmp_path, monkeypatch, r2_env):
    seen: list[str] = []
    monkeypatch.setattr(refresh_remote, "hydrate", lambda s, c: None)
    monkeypatch.setattr(refresh_remote, "refresh", lambda s, tier: seen.append(tier))
    monkeypatch.setattr(refresh_remote, "publish", lambda s, g, c: None)
    monkeypatch.setattr(refresh_remote, "_latest_generation", lambda s: tmp_path / "gen-x")

    refresh_remote.main([], client=object())
    assert seen == ["full"]


def test_refuses_to_run_without_r2_configured(monkeypatch):
    for var in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(var, raising=False)

    with pytest.raises(SystemExit):
        refresh_remote.main(["fast"], client=object())


def test_latest_generation_picks_the_newest(tmp_path):
    from pipeline.config import load_settings

    settings = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    for name in ("gen-20260101T000000Z", "gen-20260730T120000Z"):
        (settings.out_dir / name).mkdir(parents=True)

    assert refresh_remote._latest_generation(settings).name == "gen-20260730T120000Z"


def test_latest_generation_without_output_is_an_error(tmp_path):
    from pipeline.config import load_settings

    settings = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    settings.out_dir.mkdir(parents=True)

    with pytest.raises(RuntimeError, match="no generation"):
        refresh_remote._latest_generation(settings)


def test_each_stage_reports_how_long_it_took(tmp_path, capsys, monkeypatch):
    """A refresh that exceeds the job timeout is killed, and Python block-buffers
    stdout when it is not a terminal, so the 2026-08-04 timeouts left a
    20-minute run with literally no output to diagnose. Stage durations,
    flushed as they happen, are what make the next one readable.

    Asserts the COMPLETION line specifically. An earlier version matched only
    "[time] hydrate", which the "started" line satisfies on its own — deleting
    the entire finally block, i.e. the whole point of the change, left the
    suite green.
    """
    import re

    import scripts.refresh_remote as mod

    for k, v in {
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
        "R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "k",
        "R2_SECRET_ACCESS_KEY": "s", "R2_BUCKET": "b",
    }.items():
        monkeypatch.setenv(k, v)  # restored automatically; os.environ leaked
    (tmp_path / "o" / "gen-20260804T000000Z").mkdir(parents=True)

    calls: list[str] = []
    monkeypatch.setattr(mod, "hydrate", lambda s, c: calls.append("hydrate"))
    monkeypatch.setattr(mod, "refresh", lambda s, tier: calls.append(f"refresh:{tier}"))
    monkeypatch.setattr(mod, "publish", lambda s, g, c: calls.append("publish"))

    mod.main(["fast"], client=object())

    out = capsys.readouterr().out
    for stage in ("hydrate", "refresh(fast)", "publish"):
        assert re.search(rf"\[time\] {re.escape(stage)} took [\d.]+s", out), (
            f"no duration reported for {stage}:\n{out}"
        )
    assert calls == ["hydrate", "refresh:fast", "publish"]


def test_stage_timing_survives_a_failing_stage(tmp_path, capsys, monkeypatch):
    """The duration must be reported even when the stage raises — that is the
    case where knowing how long it ran actually matters."""
    import pytest

    import scripts.refresh_remote as mod

    for k, v in {
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
        "R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "k",
        "R2_SECRET_ACCESS_KEY": "s", "R2_BUCKET": "b",
    }.items():
        monkeypatch.setenv(k, v)

    def boom(*_a, **_k):
        raise RuntimeError("hydrate exploded")

    monkeypatch.setattr(mod, "hydrate", boom)
    with pytest.raises(RuntimeError, match="hydrate exploded"):
        mod.main(["fast"], client=object())

    assert re.search(r"\[time\] hydrate took [\d.]+s", capsys.readouterr().out)
