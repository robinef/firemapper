"""Carry-forward policy: carry failures, never carry a confirmed empty."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pipeline.fetch_result import FetchResult
from pipeline.freshness import MAX_AGE_S, carried_entry, layer_entry, should_carry

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)


def _entry(key: str, minutes_old: int, status: str = "ok") -> dict:
    stamp = (NOW - timedelta(minutes=minutes_old)).isoformat()
    return {
        "attempted_at": stamp, "fetched_at": stamp, "observed_at": stamp,
        "status": status, "source": "x", "max_age_s": MAX_AGE_S[key],
    }


def test_failed_fetch_carries_a_recent_previous_layer():
    result = FetchResult("failed", [], NOW)
    assert should_carry("frp", result, _entry("frp", 30), NOW) is True


def test_failed_fetch_does_not_carry_an_expired_previous_layer():
    # frp budget is 3600 s, so carry expiry is 2 h; 200 min is past it
    result = FetchResult("failed", [], NOW)
    assert should_carry("frp", result, _entry("frp", 200), NOW) is False


def test_confirmed_empty_replaces_previous_data():
    """A genuine 'no fires' must read differently from an outage."""
    result = FetchResult("empty", [], NOW)
    assert should_carry("frp", result, _entry("frp", 5), NOW) is False


def test_ok_result_never_carries():
    result = FetchResult("ok", [1], NOW)
    assert should_carry("frp", result, _entry("frp", 5), NOW) is False


def test_aircraft_is_never_carried():
    """A stale plane position is a wrong claim, not degraded data."""
    result = FetchResult("failed", [], NOW)
    assert should_carry("aircraft", result, _entry("aircraft", 1), NOW) is False


def test_nothing_to_carry_on_a_cold_start():
    assert should_carry("frp", FetchResult("failed", [], NOW), None, NOW) is False


def test_layer_entry_records_three_timestamps():
    seen = NOW - timedelta(minutes=18)
    entry = layer_entry("frp", FetchResult("ok", [1], NOW, seen), now=NOW, source="mtg-fci")
    assert entry["status"] == "ok"
    assert entry["observed_at"] == seen.isoformat()
    assert entry["fetched_at"] == NOW.isoformat()
    assert entry["attempted_at"] == NOW.isoformat()
    assert entry["max_age_s"] == 3600


def test_failed_layer_entry_has_no_fetched_at():
    entry = layer_entry("frp", FetchResult("failed", [], NOW), now=NOW, source="mtg-fci")
    assert entry["status"] == "failed"
    assert entry["fetched_at"] is None


def test_carried_entry_keeps_the_original_data_age():
    previous = _entry("frp", 30)
    carried = carried_entry(previous, now=NOW)
    assert carried["status"] == "carried"
    # the data really is 30 minutes old — only the attempt is new
    assert carried["observed_at"] == previous["observed_at"]
    assert carried["fetched_at"] == previous["fetched_at"]
    assert carried["attempted_at"] == NOW.isoformat()
