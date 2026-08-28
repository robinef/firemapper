import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.fetch_effis_stats import (
    EU_COUNTRIES, fetch_stats_snapshot, should_fetch, snapshot_path,
)

NOW = datetime(2026, 7, 12, 4, 0, tzinfo=timezone.utc)


class FakeSettings:
    def __init__(self, tmp_path: Path):
        self.data_dir = tmp_path


def cumulative_payload(mddate="20260709", events=10, area_ha=500):
    return json.dumps({"banfcumulative": [
        {"week": 1, "mddate": mddate, "events": events, "area_ha": area_ha},
    ]})


def _http_get_ok(calls):
    def http_get(url):
        calls.append(url)
        return cumulative_payload()
    return http_get


def test_fresh_fetch_writes_eu_total_and_every_country(tmp_path):
    settings = FakeSettings(tmp_path)
    calls = []

    assert fetch_stats_snapshot(settings, NOW, _http_get_ok(calls)) == "fresh"
    assert snapshot_path(settings).exists()
    # one EU call + one per EU country
    assert len(calls) == 1 + len(EU_COUNTRIES)
    assert any("aoi=EU" in u for u in calls)
    assert any("country=FRA" in u for u in calls)

    snapshot = json.loads(snapshot_path(settings).read_text())
    assert snapshot["eu"]["area_ha"] == 500
    assert snapshot["countries"]["FRA"]["name"] == "France"
    assert snapshot["countries"]["FRA"]["area_ha"] == 500


def test_second_call_within_six_hours_issues_no_request(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_stats_snapshot(settings, NOW, _http_get_ok([]))
    calls = []

    assert fetch_stats_snapshot(
        settings, NOW + timedelta(hours=5), _http_get_ok(calls),
    ) == "reused"
    assert calls == []


def test_after_six_hours_it_fetches_again(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_stats_snapshot(settings, NOW, _http_get_ok([]))
    calls = []

    assert fetch_stats_snapshot(
        settings, NOW + timedelta(hours=7), _http_get_ok(calls),
    ) == "fresh"
    assert len(calls) == 1 + len(EU_COUNTRIES)


def test_should_fetch_true_when_no_snapshot(tmp_path):
    assert should_fetch(tmp_path / "missing.json", NOW) is True


def test_should_fetch_true_when_snapshot_is_malformed(tmp_path):
    path = tmp_path / "raw" / "effis_stats.json"
    path.parent.mkdir(parents=True)
    path.write_text("not json")
    assert should_fetch(path, NOW) is True


def test_eu_fetch_raising_leaves_snapshot_untouched_and_logs_reason(tmp_path, capsys):
    settings = FakeSettings(tmp_path)
    fetch_stats_snapshot(settings, NOW, _http_get_ok([]))
    before = snapshot_path(settings).read_bytes()

    def boom(url):
        raise RuntimeError("network down")

    later = NOW + timedelta(hours=7)
    assert fetch_stats_snapshot(settings, later, boom) == "stale"
    assert snapshot_path(settings).read_bytes() == before
    warned = capsys.readouterr().err
    assert "effis-stats" in warned
    assert "network down" in warned


def test_eu_payload_with_no_actual_data_is_stale(tmp_path):
    settings = FakeSettings(tmp_path)

    def all_null(url):
        return json.dumps({"banfcumulative": [{"mddate": "20260101", "area_ha": None}]})

    assert fetch_stats_snapshot(settings, NOW, all_null) == "stale"
    assert not snapshot_path(settings).exists()


def test_one_country_failing_does_not_fail_the_whole_snapshot(tmp_path):
    settings = FakeSettings(tmp_path)

    def http_get(url):
        if "country=FRA" in url:
            raise RuntimeError("timeout")
        return cumulative_payload()

    assert fetch_stats_snapshot(settings, NOW, http_get) == "fresh"
    snapshot = json.loads(snapshot_path(settings).read_text())
    assert "FRA" not in snapshot["countries"]
    assert "DEU" in snapshot["countries"]
