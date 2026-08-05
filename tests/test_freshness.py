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


def test_a_never_carried_layer_is_not_carried(monkeypatch):
    """Some layers state a fact that expires — a position, a countdown — where
    stale data is a wrong CLAIM rather than degraded data, so a failed fetch must
    blank them instead of carrying the previous value forward.

    NEVER_CARRIED is empty since the aircraft layer was retired, so the rule is
    exercised through the frozenset itself; without this the mechanism would sit
    untested until the next live-position layer needed it."""
    import pipeline.freshness as fr

    monkeypatch.setattr(fr, "NEVER_CARRIED", frozenset({"frp"}))
    result = FetchResult("failed", [], NOW)
    assert fr.should_carry("frp", result, _entry("frp", 1), NOW) is False


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


def test_never_carries_from_a_previous_layer_that_itself_failed():
    """A failed layer holds no data and wrote no file, so there is nothing to
    copy. Treating one as carryable is what broke prod on 2026-07-31: the
    16:05 refresh saw the 13:59 generation's failed wind layer, judged it
    carryable off its `attempted_at`, found no wind.geojson to copy, and
    validate_generation then refused to publish ANY layer — so the whole map
    froze at 13:59 over one upstream 400."""
    previous = _entry("wind", 30, status="failed")
    previous["fetched_at"] = None  # a failed fetch never stamps one
    assert should_carry("wind", FetchResult("failed", [], NOW), previous, NOW) is False


def test_still_carries_a_chain_of_carries():
    """carried_entry keeps the original fetched_at, so a carry of a carry stays
    legal until the DATA (not the attempt) ages out."""
    carried = carried_entry(_entry("wind", 30), now=NOW)
    assert carried["status"] == "carried"
    assert should_carry("wind", FetchResult("failed", [], NOW), carried, NOW) is True


def test_carry_expiry_measures_the_data_not_the_attempt():
    """A carried entry re-stamps attempted_at to now every run. If expiry read
    that, a layer could be carried forever; it must read fetched_at."""
    stale = carried_entry(_entry("wind", 7 * 60), now=NOW)  # data 7 h old, budget 3 h x2
    assert stale["attempted_at"] == NOW.isoformat()
    assert should_carry("wind", FetchResult("failed", [], NOW), stale, NOW) is False
