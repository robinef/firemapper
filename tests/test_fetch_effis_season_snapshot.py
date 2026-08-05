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


def test_empty_later_page_with_nothing_outstanding_returns_rows_fresh(tmp_path, monkeypatch):
    """Test the branch: empty later page when nothing is outstanding returns rows as complete."""
    settings = FakeSettings(tmp_path)
    # Monkeypatch PAGE_SIZE to 2 to control pagination
    import pipeline.fetch_effis_season as module
    monkeypatch.setattr(module, "PAGE_SIZE", 2)

    pages = [
        # Page 1: 2 features, no numberMatched (server omits the counter)
        json.dumps({
            "type": "FeatureCollection",
            "features": [feat("ba.1"), feat("ba.2")],
        }),
        # Page 2: empty feature collection
        json.dumps({
            "type": "FeatureCollection",
            "features": [],
        }),
    ]
    calls = []

    def http_get(url):
        calls.append(url)
        return pages[len(calls) - 1]

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 2
    # Verify both rows were written
    import duckdb
    con = duckdb.connect()
    rows = con.execute(f"SELECT COUNT(*) FROM read_parquet('{snapshot_path(settings).as_posix()}')").fetchone()[0]
    assert rows == 2


def test_page_1_with_matched_5000_page_2_exception_is_stale(tmp_path):
    """Critical: server dies after page 1. Carry expected forward; exception page shouldn't truncate."""
    settings = FakeSettings(tmp_path)
    # Seed good snapshot
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    pages = [
        # Page 1: 2 features, claims 5000 matched
        page([feat("ba.1"), feat("ba.2")], matched=5000, returned=2),
        # Page 2: OWS ExceptionReport (no counters)
        '<?xml version="1.0"?><ExceptionReport><Exception/></ExceptionReport>',
    ]
    calls = []

    def http_get(url):
        calls.append(url)
        return pages[len(calls) - 1]

    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, http_get) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_should_fetch_true_when_parquet_lacks_fetched_at_column(tmp_path):
    """Exercise the intended branch: parquet exists but has no fetched_at column."""
    settings = FakeSettings(tmp_path)
    # Create the raw directory
    (tmp_path / "raw").mkdir()
    # Create a parquet with data but no fetched_at column
    import duckdb
    con = duckdb.connect()
    con.execute(f"""
        COPY (
            SELECT 'ba.1' as id, 100 as area_ha
        ) TO '{snapshot_path(settings).as_posix()}' (FORMAT PARQUET)
    """)
    con.close()

    # should_fetch should return True: max(fetched_at) will fail or return None
    assert should_fetch(snapshot_path(settings), NOW) is True


# An empty page is ambiguous: it is either the end of the data or the backend
# falling over mid-pagination. `_features_from_text` yields [] for both, so the
# difference has to be read off the body itself — and it decides whether a
# season completes or is published truncated.
#
# The pair below is the point. Same shape, same counters, one byte of meaning
# apart: page 1 full, page 2 empty. One is end-of-data and must keep the rows;
# the other is an error and must discard them. A guard that cannot tell them
# apart passes whichever single case you happen to write.

OWS_EXCEPTION = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">'
    '<ows:Exception exceptionCode="NoApplicableCode">'
    "<ows:ExceptionText>Backend failure</ows:ExceptionText>"
    "</ows:Exception></ows:ExceptionReport>"
)
EMPTY_COLLECTION = json.dumps({"type": "FeatureCollection", "features": []})


def paged(monkeypatch, bodies):
    """Serve `bodies` in order, with PAGE_SIZE shrunk so a two-feature page is a
    FULL page. Without that the first page is short, `_collect` completes on it
    and the second body is never requested — the guard under test never runs."""
    import pipeline.fetch_effis_season as module

    monkeypatch.setattr(module, "PAGE_SIZE", 2)
    calls = []

    def http_get(url):
        calls.append(url)
        return bodies[len(calls) - 1]

    return http_get, calls


def test_a_full_page_then_an_exception_report_is_a_truncation(tmp_path, monkeypatch):
    """No counters, so nothing is outstanding by arithmetic and the old code
    read the exception page as "nothing left to page" — publishing page 1 as
    the complete season."""
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.0")], 1, 1))
    before = snapshot_path(settings).read_bytes()

    http_get, calls = paged(monkeypatch, [
        json.dumps({"type": "FeatureCollection",
                    "features": [feat("ba.1"), feat("ba.2")]}),
        OWS_EXCEPTION,
    ])
    later = NOW + timedelta(hours=7)
    assert fetch_season_snapshot(settings, later, http_get) == "stale"
    assert len(calls) == 2  # the guard ran on page 2, not on a short page 1
    assert snapshot_path(settings).read_bytes() == before


def test_a_full_page_then_a_genuinely_empty_collection_is_the_end_of_the_data(
    tmp_path, monkeypatch,
):
    """The other half of the pair. Identical pagination, a real (empty)
    FeatureCollection instead of an error, and the rows must be KEPT — a guard
    strict enough to reject this would stall the archive forever."""
    settings = FakeSettings(tmp_path)
    http_get, calls = paged(monkeypatch, [
        json.dumps({"type": "FeatureCollection",
                    "features": [feat("ba.1"), feat("ba.2")]}),
        EMPTY_COLLECTION,
    ])
    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 2
    assert _snapshot_ids(settings) == ["ba.1", "ba.2"]


def test_a_smaller_later_number_matched_does_not_end_pagination_early(
    tmp_path, monkeypatch,
):
    """`expected` is monotonic. The server claims 6, then on page 2 claims 3 —
    already satisfied by the 4 features sent so far. Last-wins takes the 3,
    stops two-thirds of the way through and publishes 4 rows as the season;
    max() holds it to the 6 it first promised and pages on to all 6."""
    settings = FakeSettings(tmp_path)
    http_get, calls = paged(monkeypatch, [
        page([feat("ba.1"), feat("ba.2")], matched=6, returned=2),
        page([feat("ba.3"), feat("ba.4")], matched=3, returned=2),
        page([feat("ba.5"), feat("ba.6")], matched=6, returned=2),
    ])
    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert len(calls) == 3
    assert _snapshot_ids(settings) == ["ba.1", "ba.2", "ba.3", "ba.4", "ba.5", "ba.6"]


def test_a_quote_in_the_data_dir_does_not_disable_the_six_hour_gate(tmp_path):
    """should_fetch interpolates the path into SQL, so it goes through
    store._sql_path. Unescaped, the quote breaks the query, the except reads it
    as an unreadable snapshot and returns True — the gate silently off, and
    EFFIS polled every 15 minutes instead of every 6 hours."""
    settings = FakeSettings(tmp_path / "o'brien data")
    fetch_season_snapshot(settings, NOW, lambda u: page([feat("ba.1")], 1, 1))
    assert should_fetch(snapshot_path(settings), NOW + timedelta(hours=1)) is False
    assert should_fetch(snapshot_path(settings), NOW + timedelta(hours=7)) is True


def _snapshot_ids(settings) -> list[str]:
    from pipeline.store import _sql_path, connect

    con = connect()
    try:
        rows = con.execute(
            f"SELECT id FROM read_parquet('{_sql_path(snapshot_path(settings))}') "
            "ORDER BY id"
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]
