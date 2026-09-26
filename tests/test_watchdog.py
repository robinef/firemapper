"""An alarm that survives the Worker dying.

Every existing check lives INSIDE worker/index.ts: it throws on a failed
dispatch, and on a manifest that has stopped advancing. Both are recorded as
cron-invocation errors, which is a real signal — but none of it runs if the
Worker itself is gone, the cron is disabled, or the Cloudflare account is
suspended. The map would simply stop and nothing would say so.

The GitHub-side fallback is weaker than it looks. refresh-full is `7 * * * *`,
meant to be hourly; measured on 2026-08-08 it actually fired at 02:15, 04:17,
05:51, 07:08, 08:54, 09:49 — gaps of 55 min to 2 h 02. That is GitHub's
documented scheduler throttling, the very thing #27 moved away from. So a dead
Worker degrades to a map hours behind, silently.

This watchdog runs on the other provider and checks what a VISITOR sees.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.watchdog import (
    FULL_STALE_AFTER_MIN,
    STALE_AFTER_MIN,
    Verdict,
    full_verdict_for,
    issue_action,
    manifest_age_min,
    season_url,
    verdict_for,
)

NOW = 1_800_000_000.0  # fixed epoch seconds; no wall-clock in tests


def _manifest(*ages_min: float) -> str:
    layers = {
        f"l{i}": {"attempted_at": _iso(NOW - a * 60)} for i, a in enumerate(ages_min)
    }
    return json.dumps({"generation": "gen-x", "layers": layers})


def _iso(epoch: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def test_age_is_the_newest_attempt_across_layers():
    """One run stamps every layer, so a layer that failed carries an older
    attempt. Reading an arbitrary one would report the pipeline dead while it
    is merely partially degraded."""
    assert manifest_age_min(_manifest(300, 12, 900), NOW) == pytest.approx(12, abs=0.1)


def test_fresh_data_is_quiet():
    assert verdict_for(_manifest(20), NOW) == Verdict.FRESH


def test_stale_data_alarms():
    assert verdict_for(_manifest(STALE_AFTER_MIN + 1), NOW) == Verdict.STALE
    # The boundary itself is not yet an alarm.
    assert verdict_for(_manifest(STALE_AFTER_MIN - 1), NOW) == Verdict.FRESH


@pytest.mark.parametrize(
    "body",
    [
        "",                                   # empty response
        "{not json",                          # truncated / error page
        json.dumps({"generation": "g"}),      # no layers at all
        json.dumps({"layers": {}}),           # layers present but empty
        json.dumps({"layers": {"a": {}}}),    # layer with no attempted_at
        json.dumps({"layers": {"a": {"attempted_at": "not-a-date"}}}),
    ],
)
def test_unreadable_is_broken_never_fresh(body):
    """The dangerous bug is a watchdog that stays green because it could not
    tell. Every shape it cannot read means the pipeline is unproven, not fine —
    the same asymmetry worker/index.ts uses for a missing manifest."""
    assert verdict_for(body, NOW) == Verdict.BROKEN


def test_a_missing_response_is_broken():
    assert verdict_for(None, NOW) == Verdict.BROKEN


def test_threshold_matches_the_worker_so_the_two_cannot_drift():
    """worker/index.ts alarms at the same age from the inside. Two constants
    that are meant to agree will not, once someone tunes one of them."""
    src = (Path(__file__).resolve().parents[1] / "worker" / "index.ts").read_text()
    import re

    m = re.search(r"const STALE_AFTER_MIN\s*=\s*(\d+)", src)
    assert m, "worker/index.ts no longer declares STALE_AFTER_MIN"
    assert int(m.group(1)) == STALE_AFTER_MIN


class TestIssueLifecycle:
    """A multi-day outage must be one issue, not dozens: the watchdog runs
    hourly, and an alarm that buries you is an alarm you mute."""

    def test_first_alarm_opens_an_issue(self):
        action = issue_action(Verdict.STALE, open_issue=None)
        assert action.kind == "create"

    def test_a_continuing_outage_comments_rather_than_piling_up(self):
        action = issue_action(Verdict.STALE, open_issue={"number": 7})
        assert action.kind == "comment" and action.number == 7

    def test_recovery_closes_the_issue_it_opened(self):
        action = issue_action(Verdict.FRESH, open_issue={"number": 7})
        assert action.kind == "close" and action.number == 7

    def test_nothing_to_say_when_healthy_and_no_issue_is_open(self):
        assert issue_action(Verdict.FRESH, open_issue=None).kind == "none"

    def test_broken_alarms_exactly_like_stale(self):
        """Unreachable and frozen are the same outcome for a visitor, and
        treating BROKEN as a separate quieter case is how it gets ignored."""
        assert issue_action(Verdict.BROKEN, open_issue=None).kind == "create"
        assert issue_action(Verdict.BROKEN, open_issue={"number": 3}).kind == "comment"


def test_a_blank_url_override_falls_through_to_production(monkeypatch):
    """An unset workflow_dispatch input arrives as "", not as an absent
    variable, and os.environ.get(key, default) only falls back on ABSENCE. Left
    as a plain default, every scheduled run would have fetched "" and reported
    BROKEN — an alarm that fires constantly, which is an alarm switched off."""
    import importlib

    import scripts.watchdog as wd

    monkeypatch.setenv("WATCHDOG_MANIFEST_URL", "")
    assert importlib.reload(wd).MANIFEST_URL.startswith("https://")

    monkeypatch.setenv("WATCHDOG_MANIFEST_URL", "http://drill.invalid/m.json")
    assert importlib.reload(wd).MANIFEST_URL == "http://drill.invalid/m.json"

    monkeypatch.delenv("WATCHDOG_MANIFEST_URL")
    assert importlib.reload(wd).MANIFEST_URL.startswith("https://")


def test_the_drill_fixture_is_stale_enough_to_alarm():
    """The committed fixture is what exercises the alarm path on demand. If it
    ever stopped reading as stale the drill would silently prove nothing."""
    import time

    fixture = Path(__file__).resolve().parent / "fixtures" / "stale_manifest.json"
    assert verdict_for(fixture.read_text(), time.time()) == Verdict.STALE


class TestWorkflowWiring:
    """The script can be perfect and the alarm still never reach anyone. These
    pin the parts of watchdog.yml that decide whether it is heard."""

    @staticmethod
    def _wf() -> str:
        return (
            Path(__file__).resolve().parents[1]
            / ".github" / "workflows" / "watchdog.yml"
        ).read_text()

    def test_it_does_not_share_the_refresh_concurrency_group(self):
        """Both refresh workflows use `group: refresh`. Copy-pasting that here
        would queue the watchdog behind the thing it watches — so during a
        pile-up, the moment it matters most, it would not run."""
        import re

        block = re.search(r"^concurrency:\n((?:\s+.*\n)+)", self._wf(), re.M)
        assert block, "watchdog.yml declares no concurrency group"
        assert "group: watchdog" in block.group(1)
        assert "group: refresh" not in block.group(1)

    def test_it_can_write_issues_but_not_the_repository(self):
        """issues: write is the whole point; contents: write would hand a
        scheduled job the ability to push commits for no reason."""
        wf = self._wf()
        assert "issues: write" in wf
        assert "contents: read" in wf
        assert "contents: write" not in wf

    def test_it_runs_off_the_top_of_the_hour(self):
        """Scheduled jobs across the platform bunch at :00, and that is where
        GitHub throttles hardest — the failure mode being a watchdog that
        quietly stops being scheduled."""
        import re

        cron = re.search(r'cron:\s*"([^"]+)"', self._wf())
        assert cron, "watchdog.yml has no schedule"
        minute = cron.group(1).split()[0]
        assert minute not in ("0", "*"), f"cron minute {minute!r} sits on the busy mark"

    def test_the_drill_override_is_wired_to_the_script(self):
        """An input nobody passes to the step is a drill that silently checks
        production and always passes."""
        wf = self._wf()
        assert "manifest_url:" in wf, "no drill input declared"
        assert "WATCHDOG_MANIFEST_URL: ${{ inputs.manifest_url }}" in wf

    def test_the_run_actually_fails_when_the_map_is_frozen(self):
        """continue-on-error on the check step is what lets the issue steps run
        afterwards. Without an explicit failing step at the end, the run would
        go GREEN through an outage — the exact silent-success shape this whole
        change exists to remove."""
        wf = self._wf()
        assert "continue-on-error: true" in wf
        assert "exit 1" in wf


class TestFullTier:
    """The fast tier re-stamps every manifest layer each half hour, so a dead
    refresh-full reads fresh there. archive/season_{year}.json is written only
    by the full tier; its generated_at is that tier's public heartbeat."""

    @staticmethod
    def _season(age_min: float) -> str:
        return json.dumps({"generated_at": _iso(NOW - age_min * 60).replace("+00:00", "Z")})

    def test_the_season_file_sits_beside_the_manifest_for_the_shown_year(self):
        body = json.dumps({"season_year": 2026, "generated_at": "2027-01-03T00:00:00+00:00", "layers": {}})
        assert season_url("https://x.invalid/data/manifest.json", body) == (
            "https://x.invalid/data/archive/season_2026.json"
        )

    def test_a_manifest_without_season_year_falls_back_to_its_generated_at(self):
        body = json.dumps({"generated_at": "2026-09-26T13:00:00+00:00", "layers": {}})
        assert season_url("https://x.invalid/data/manifest.json", body).endswith("/season_2026.json")

    def test_no_season_is_named_when_the_manifest_cannot_say(self):
        assert season_url("https://x.invalid/m.json", None) is None
        assert season_url("https://x.invalid/m.json", "{nope") is None
        assert season_url("https://x.invalid/m.json", json.dumps({"layers": {}})) is None

    def test_a_full_tier_within_its_limit_is_quiet_and_past_it_alarms(self):
        assert full_verdict_for(self._season(FULL_STALE_AFTER_MIN - 1), NOW) == Verdict.FRESH
        assert full_verdict_for(self._season(FULL_STALE_AFTER_MIN + 1), NOW) == Verdict.STALE

    @pytest.mark.parametrize("body", [None, "", "{nope", "[]", json.dumps({"year": 2026}),
                                      json.dumps({"generated_at": "yesterday"})])
    def test_an_unreadable_season_summary_is_broken_never_fresh(self, body):
        assert full_verdict_for(body, NOW) == Verdict.BROKEN

    def test_the_limit_rides_out_two_missed_two_hourly_ticks(self):
        """worker/index.ts FULL_CRON fires every 2 h; one missed tick is 4 h
        between runs, which must not alarm; the 6-hourly GitHub fallback alone
        (Worker cron gone) must."""
        assert 4 * 60 < FULL_STALE_AFTER_MIN < 6 * 60
        import re

        src = (Path(__file__).resolve().parents[1] / "worker" / "index.ts").read_text()
        assert re.search(r'FULL_CRON\s*=\s*"17 \*/2 \* \* \*"', src), "full cron cadence changed: revisit the limit"

    def test_the_drill_fixtures_trip_the_full_tier_alarm_too(self):
        import time

        fixtures = Path(__file__).resolve().parent / "fixtures"
        manifest = (fixtures / "stale_manifest.json").read_text()
        url = season_url("https://raw.invalid/tests/fixtures/stale_manifest.json", manifest)
        assert url == "https://raw.invalid/tests/fixtures/archive/season_2020.json"
        season = (fixtures / "archive" / "season_2020.json").read_text()
        assert full_verdict_for(season, time.time()) == Verdict.STALE

    def test_main_reports_both_tiers_and_fails_on_a_dead_full_tier(self, monkeypatch, tmp_path):
        import scripts.watchdog as wd

        manifest = json.dumps({"season_year": 2026, "layers": {"events": {"attempted_at": _iso(NOW - 60)}}})
        bodies = {wd.MANIFEST_URL: manifest,
                  season_url(wd.MANIFEST_URL, manifest): self._season(FULL_STALE_AFTER_MIN + 60)}
        monkeypatch.setattr(wd, "fetch", lambda url: bodies.get(url))
        monkeypatch.setattr(wd.time, "time", lambda: NOW)
        out = tmp_path / "out"
        monkeypatch.setenv("GITHUB_OUTPUT", str(out))
        assert wd.main() == 1
        text = out.read_text()
        assert "verdict=fresh\n" in text and "full_verdict=stale\n" in text

        bodies[season_url(wd.MANIFEST_URL, manifest)] = self._season(30)
        out.write_text("")
        assert wd.main() == 0
        assert "full_verdict=fresh\n" in out.read_text()

    def test_an_unreadable_manifest_skips_the_full_tier_rather_than_double_alarming(self, monkeypatch, tmp_path):
        import scripts.watchdog as wd

        monkeypatch.setattr(wd, "fetch", lambda url: None)
        out = tmp_path / "out"
        monkeypatch.setenv("GITHUB_OUTPUT", str(out))
        assert wd.main() == 1
        assert "verdict=broken\n" in out.read_text() and "full_verdict=skipped\n" in out.read_text()

    def test_the_workflow_keeps_the_full_tier_on_its_own_issue(self):
        wf = TestWorkflowWiring._wf()
        assert "TITLE='[watchdog] full refresh is stale'" in wf
        assert "steps.check.outputs.full_verdict == 'fresh'" in wf  # closes on recovery
        assert "steps.check.outputs.full_verdict != 'fresh'" in wf  # fails the run
