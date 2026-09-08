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


def response(records, count=None):
    return json.dumps({
        "count": len(records) if count is None else count,
        "next": None,
        "previous": None,
        "results": records,
    })


def rec(fid, area_ha="100", firedate="2026-07-01T00:00:00+02:00", country="ES"):
    return {"id": fid, "shape": POLY, "area_ha": area_ha, "firedate": firedate,
            "country": country, "province": None, "commune": None}


def test_a_successful_fetch_writes_snapshot(tmp_path):
    settings = FakeSettings(tmp_path)
    calls = []

    def http_get(url):
        calls.append(url)
        return response([rec("ba.1"), rec("ba.2")], count=2)

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert snapshot_path(settings).exists()
    assert len(calls) == 1
    assert "firedate__gte=2026-01-01T00:00:00" in calls[0]
    assert "ordering=-area_ha" in calls[0]
    assert "limit=250" in calls[0]  # DEFAULT_BA_LIMIT (200) + FETCH_BUFFER (50)


def test_second_call_within_six_hours_issues_no_request(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: response([rec("ba.1")], count=1))
    calls = []

    def http_get(url):
        calls.append(url)
        return response([rec("ba.2")], count=1)

    assert fetch_season_snapshot(settings, NOW + timedelta(hours=5), http_get) == "reused"
    assert calls == []


def test_after_six_hours_it_fetches_again(tmp_path):
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: response([rec("ba.1")], count=1))
    calls = []

    def http_get(url):
        calls.append(url)
        return response([rec("ba.2")], count=1)

    assert fetch_season_snapshot(settings, NOW + timedelta(hours=7), http_get) == "fresh"
    assert len(calls) == 1


def test_should_fetch_is_true_when_no_snapshot(tmp_path):
    assert should_fetch(tmp_path / "missing.parquet", NOW) is True


def test_should_fetch_is_true_when_parquet_exists_but_empty(tmp_path):
    from pipeline.store import write_polygons
    settings = FakeSettings(tmp_path)
    write_polygons([], snapshot_path(settings))
    assert should_fetch(snapshot_path(settings), NOW) is True


def test_should_fetch_true_when_parquet_lacks_fetched_at_column(tmp_path):
    settings = FakeSettings(tmp_path)
    (tmp_path / "raw").mkdir()
    import duckdb
    con = duckdb.connect()
    con.execute(f"""
        COPY (
            SELECT 'ba.1' as id, 100 as area_ha
        ) TO '{snapshot_path(settings).as_posix()}' (FORMAT PARQUET)
    """)
    con.close()
    assert should_fetch(snapshot_path(settings), NOW) is True


def test_a_quote_in_the_data_dir_does_not_disable_the_six_hour_gate(tmp_path):
    """should_fetch interpolates the path into SQL, so it goes through
    store._sql_path. Unescaped, the quote breaks the query, the except reads it
    as an unreadable snapshot and returns True — the gate silently off, and
    EFFIS polled every 15 minutes instead of every 6 hours."""
    settings = FakeSettings(tmp_path / "o'brien data")
    fetch_season_snapshot(settings, NOW, lambda u: response([rec("ba.1")], count=1))
    assert should_fetch(snapshot_path(settings), NOW + timedelta(hours=1)) is False
    assert should_fetch(snapshot_path(settings), NOW + timedelta(hours=7)) is True


def test_zero_results_is_treated_as_failure(tmp_path):
    settings = FakeSettings(tmp_path)
    assert fetch_season_snapshot(settings, NOW, lambda u: response([], count=0)) == "stale"
    assert not snapshot_path(settings).exists()


def test_truncated_response_is_rejected_and_snapshot_untouched(tmp_path):
    """count says far more records exist than the page actually delivered —
    a gateway truncating a large body mid-stream, not a genuinely small
    dataset. Must be rejected, not accepted as a smaller-than-usual result."""
    settings = FakeSettings(tmp_path)
    fetch_season_snapshot(settings, NOW, lambda u: response([rec("ba.1")], count=1))
    before = snapshot_path(settings).read_bytes()

    later = NOW + timedelta(hours=7)
    truncated = lambda u: response([rec("ba.2")], count=9000)
    assert fetch_season_snapshot(settings, later, truncated) == "stale"
    assert snapshot_path(settings).read_bytes() == before


def test_invalid_records_within_the_fetch_window_do_not_starve_the_valid_ones(
    tmp_path, monkeypatch,
):
    """FETCH_LIMIT patched down to 3 for a small, exact test: one invalid
    record (zero area) plus two valid ones, all within the fetch window.
    The invalid one is dropped by _rows_from_records, but that is normal
    filtering (not truncation, since all 3 raw records were delivered as
    requested) and must not turn the fetch into a failure."""
    import pipeline.fetch_effis_season as module
    monkeypatch.setattr(module, "FETCH_LIMIT", 3)

    settings = FakeSettings(tmp_path)
    records = [rec("bad", area_ha="0"), rec("ba.1"), rec("ba.2")]

    def http_get(url):
        return response(records, count=3)

    assert fetch_season_snapshot(settings, NOW, http_get) == "fresh"
    assert _snapshot_ids(settings) == ["ba.1", "ba.2"]


class FakeResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text


def test_the_reason_survives_from_the_response_body(tmp_path, capsys):
    """The REST API's error body is JSON (`detail`), not the old WFS's
    embedded OWS ExceptionReport XML — losing the detail is the difference
    between "EFFIS says our query is wrong, fix it" and a bare "stale"."""
    def refused(url):
        exc = RuntimeError("400 Client Error: Bad Request for url: ...")
        exc.response = FakeResponse(
            400, json.dumps({"detail": "firedate__gte must be a valid date"})
        )
        raise exc

    assert fetch_season_snapshot(FakeSettings(tmp_path), NOW, refused) == "stale"
    warned = capsys.readouterr().err
    assert "effis-season" in warned
    assert "HTTP 400" in warned
    assert "firedate__gte must be a valid date" in warned


def test_a_reasonless_failure_still_says_something(tmp_path, capsys):
    def boom(url):
        raise RuntimeError("network down")

    assert fetch_season_snapshot(FakeSettings(tmp_path), NOW, boom) == "stale"
    assert "network down" in capsys.readouterr().err


def test_an_empty_result_set_is_named_as_such(tmp_path, capsys):
    assert fetch_season_snapshot(
        FakeSettings(tmp_path), NOW, lambda u: response([], count=0)
    ) == "stale"
    warned = capsys.readouterr().err
    assert "empty result set" in warned
    assert "HTTP" not in warned


def test_an_unparseable_body_falls_back_rather_than_raising(tmp_path, capsys):
    """A gateway's HTML error page is not JSON. Parsing it must not raise
    inside the very path whose contract is that it never raises."""
    def refused(url):
        exc = RuntimeError("502 Bad Gateway")
        exc.response = FakeResponse(502, "<html><body>gateway timeout</body></html>")
        raise exc

    assert fetch_season_snapshot(FakeSettings(tmp_path), NOW, refused) == "stale"
    assert "502" in capsys.readouterr().err


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
