"""An outage and a quiet world must not look the same downstream.

Every fetcher in this codebase swallows its own errors and returns an empty
list, so carry-forward built on bare lists would either freeze old fires on the
map forever or blank the map on any hiccup.
"""
from __future__ import annotations

from datetime import datetime, timezone

from pipeline.fetch_result import FetchResult, attempt

NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)


def test_success_is_ok_and_carries_observation_time():
    seen = datetime(2026, 7, 30, 11, 40, tzinfo=timezone.utc)
    result = attempt(lambda: [1, 2], label="x", now=NOW, observed=lambda d: seen)
    assert result.status == "ok"
    assert result.data == [1, 2]
    assert result.observed_at == seen
    assert result.usable is True


def test_empty_result_is_empty_not_failed():
    result = attempt(lambda: [], label="x", now=NOW)
    assert result.status == "empty"
    assert result.data == []
    assert result.usable is True


def test_exception_is_failed_and_keeps_the_default():
    result = attempt(lambda: 1 / 0, label="x", now=NOW, default=[])
    assert result.status == "failed"
    assert result.data == []
    assert result.usable is False
    assert result.observed_at is None


def test_none_counts_as_empty():
    assert attempt(lambda: None, label="x", now=NOW).status == "empty"


def test_an_unreadable_observation_time_is_not_a_failure():
    def explode(_data):
        raise ValueError("bad timestamp")

    result = attempt(lambda: [1], label="x", now=NOW, observed=explode)
    assert result.status == "ok"
    assert result.observed_at is None


def test_failed_result_is_not_usable():
    assert FetchResult("failed", [], NOW).usable is False
    assert FetchResult("empty", [], NOW).usable is True
