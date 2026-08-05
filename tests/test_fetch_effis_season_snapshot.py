import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.fetch_effis_season import (
    fetch_season_snapshot, should_fetch, snapshot_path,
)

NOW = datetime(2026, 7, 12, 4, 0, tzinfo=timezone.utc)
POLY = {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]}


class FakeSettings:
    def __init__(self, tmp_path: Path):
        self.data_dir = tmp_path


def page(features, matched, returned):
    return json.dumps({
        "type": "FeatureCollection",
        "numberMatched": matched,
        "numberReturned": returned,
        "features": features,
    })


def feat(fid, area="100", firedate="2026-07-01", country="ES"):
    return {"type": "Feature", "id": fid, "geometry": POLY,
            "properties": {"area_ha": area, "firedate": firedate, "country": country}}


def test_complete_single_page_writes_snapshot(tmp_path):
    settings = FakeSettings(tmp_path)
    calls = []

    def http_get(url):
        calls.append(url)
        return page([feat("ba.1"), feat("ba.2")], matched=2, returned=2)

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert snapshot_path(settings).exists()
    assert len(calls) == 1


def test_paginates_until_matched_is_reached(tmp_path):
    settings = FakeSettings(tmp_path)
    pages = [
        page([feat("ba.1"), feat("ba.2")], matched=3, returned=2),
        page([feat("ba.3")], matched=3, returned=1),
    ]
    calls = []

    def http_get(url):
        calls.append(url)
        return pages[len(calls) - 1]

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 2
    assert "startIndex=2" in calls[1]


def test_incomplete_response_is_rejected_and_snapshot_untouched(tmp_path):
    settings = FakeSettings(tmp_path)
    # First seed a good snapshot.
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    # Server claims 900 matched but keeps returning 1 and never advances.
    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, lambda u: page([feat("ba.9")], 900, 1)) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_exception_report_leaves_snapshot_byte_identical(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    ows = '<?xml version="1.0"?><ExceptionReport><Exception/></ExceptionReport>'
    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, lambda u: ows) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_raising_http_get_leaves_snapshot_byte_identical(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    def boom(url):
        raise RuntimeError("network down")

    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, boom) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_zero_features_is_treated_as_failure(tmp_path):
    settings = FakeSettings(tmp_path)
    assert fetch_season_snapshot(settings, NOW, lambda u: page([], 0, 0)) == "stale"
    assert not snapshot_path(settings).exists()


def test_second_call_within_six_hours_issues_no_request(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    calls = []

    def http_get(url):
        calls.append(url)
        return page([feat("ba.2")], 1, 1)

    assert fetch_season_snapshot(settings, NOW + timedelta(hours=5), http_get) == "reused"
    assert calls == []


def test_after_six_hours_it_fetches_again(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    calls = []

    def http_get(url):
        calls.append(url)
        return page([feat("ba.2")], 1, 1)

    assert fetch_season_snapshot(settings, NOW + timedelta(hours=7), http_get) == "fresh"
    assert len(calls) == 1


def test_should_fetch_is_true_when_no_snapshot(tmp_path):
    assert should_fetch(tmp_path / "missing.parquet", NOW) is True


def test_empty_page_at_start_gt_0_with_matched_outstanding_is_stale(tmp_path):
    """Critical 1: empty later page with outstanding matched must reject."""
    settings = FakeSettings(tmp_path)
    # Seed good snapshot
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1"), feat("ba.2")], 2, 2))
    before = snapshot_path(settings).read_bytes()

    # Later, server claims 3 but page 1 has 2, then page 2 is empty (truncated)
    pages = [
        page([feat("ba.3"), feat("ba.4")], matched=3, returned=2),
        page([], matched=3, returned=0),
    ]
    calls = []

    def http_get(url):
        calls.append(url)
        return pages[len(calls) - 1]

    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, http_get) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_multi_page_until_matched_is_satisfied_then_completes(tmp_path):
    """Completing a multi-page fetch that ends with a short page."""
    settings = FakeSettings(tmp_path)
    pages = [
        page([feat("ba.1"), feat("ba.2")], matched=3, returned=2),
        page([feat("ba.3")], matched=3, returned=1),
    ]
    calls = []

    def http_get(url):
        calls.append(url)
        return pages[len(calls) - 1]

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 2


def test_server_returns_fewer_than_number_returned_claims(tmp_path):
    """Server claiming 1000 but sending 900 skips 100; cursor must advance by what arrived."""
    settings = FakeSettings(tmp_path)
    # First fetch to establish baseline
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    # Server claims numberReturned=1000 but sends only 900 features
    # If cursor advanced by numberReturned, it would skip 100 and never catch up
    def http_get(url):
        if "startIndex=0" in url:
            # Claim 1000 returned but send fewer
            features = [feat(f"ba.{i}") for i in range(1, 901)]
            return json.dumps({
                "type": "FeatureCollection",
                "numberMatched": 1000,
                "numberReturned": 1000,  # lie
                "features": features,
            })
        else:
            # Server never finishes
            return page([], 1000, 0)

    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, http_get) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_no_matched_counter_and_short_first_page_is_fresh(tmp_path):
    """When server omits numberMatched and sends < PAGE_SIZE rows, trust it's complete."""
    settings = FakeSettings(tmp_path)
    calls = []

    def http_get(url):
        calls.append(url)
        return json.dumps({
            "type": "FeatureCollection",
            "features": [feat("ba.1"), feat("ba.2")],
            # no numberMatched, no numberReturned
        })

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 1


def test_should_fetch_is_true_when_parquet_exists_but_empty(tmp_path):
    """Empty parquet (no rows) should trigger refetch."""
    settings = FakeSettings(tmp_path)
    # Create an empty parquet
    from pipeline.store import write_polygons
    write_polygons([], snapshot_path(settings))

    # should_fetch should return True since max(fetched_at) is None
    assert should_fetch(snapshot_path(settings), NOW) is True
