import sys
import traceback
import types
import pytest
from datetime import datetime, timezone

from pipeline.config import load_settings
from pipeline.fetch_firms import (
    REDACTED,
    _fault,
    scrub,
    append_hotspots,
    fetch_firms,
    fetch_firms_history,
    parse_firms_csv,
)

FIRMS_CSV = """latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
40.123,3.456,330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,n,2.0NRT,290.0,12.5,N
40.125,3.458,330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,l,2.0NRT,290.0,1.5,N
"""


def test_parse_firms_csv_filters_low_confidence():
    rows = parse_firms_csv(FIRMS_CSV, tier="viirs")
    assert len(rows) == 1
    r = rows[0]
    assert r["lat"] == 40.123 and r["tier"] == "viirs"
    assert r["acq_time"] == datetime(2026, 7, 20, 1, 36, tzinfo=timezone.utc)
    assert r["src_id"]


FIRMS_CSV_WITH_TYPE = """latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type
40.1,3.1,330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,h,2.0NRT,290.0,12.5,N,0
40.2,3.2,330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,h,2.0NRT,290.0,12.5,N,2
40.3,3.3,330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,h,2.0NRT,290.0,12.5,N,3
"""


def test_parse_firms_csv_drops_static_land_and_offshore_sources():
    """type 2 (static land source, e.g. a flare stack) and 3 (offshore, e.g. a
    gas platform) are not wildfires — confidence alone never filters them out
    because they read back as persistent, high-confidence detections."""
    rows = parse_firms_csv(FIRMS_CSV_WITH_TYPE, tier="viirs")
    assert len(rows) == 1
    assert rows[0]["lon"] == 3.1


def test_parse_firms_csv_keeps_rows_with_no_type_column():
    # FIRMS_CSV (module fixture) has no `type` column at all — missing type
    # must not be treated as evidence of a false positive.
    rows = parse_firms_csv(FIRMS_CSV, tier="viirs")
    assert len(rows) == 1


def test_append_dedups(tmp_path):
    rows = parse_firms_csv(FIRMS_CSV, tier="viirs")
    store = tmp_path / "hotspots.parquet"
    assert append_hotspots(rows, store) == 1
    assert append_hotspots(rows, store) == 0


def test_fetch_firms_uses_injected_http(tmp_path):
    s = load_settings(env={"FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path)})
    calls: list[str] = []

    def fake_get(url: str) -> str:
        calls.append(url)
        return FIRMS_CSV

    n = fetch_firms(s, http_get=fake_get)
    assert n >= 1
    assert any("VIIRS" in u for u in calls)


def _csv_on(day_iso: str) -> str:
    # One high-confidence VIIRS row on `day_iso`.
    return (
        "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
        "instrument,confidence,version,bright_ti5,frp,daynight\n"
        f"45.0,8.0,330,0.4,0.4,{day_iso},1200,N,VIIRS,h,2.0NRT,290,5.0,N\n"
    )


def test_fetch_firms_history_incremental_skips_stored_windows(tmp_path):
    s = load_settings(env={"FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path)})
    calls: list[str] = []

    def fake_get(url: str) -> str:
        calls.append(url)
        return _csv_on(url.rsplit("/", 1)[-1])  # a row on the window's start day

    # Empty store → all six 5-day windows over 30 days are fetched.
    fetch_firms_history(s, days=30, http_get=fake_get)
    assert len(calls) == 6

    # Store now holds data up to the newest window's start → a second run pulls
    # only the window that extends past it, not the whole 30 days again.
    calls.clear()
    fetch_firms_history(s, days=30, http_get=fake_get)
    assert len(calls) < 6


def test_fetch_firms_history_uses_configured_window(tmp_path):
    # No explicit `days` → the window comes from settings.firms_history_days.
    # 45 days / 5-day windows = 9 windows against an empty store.
    s = load_settings(env={
        "FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path), "FIRMS_HISTORY_DAYS": "45",
    })
    calls: list[str] = []

    def fake_get(url: str) -> str:
        calls.append(url)
        return _csv_on(url.rsplit("/", 1)[-1])

    fetch_firms_history(s, http_get=fake_get)  # days omitted → configured 45
    assert len(calls) == 9


HEADER_ONLY = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"


def _one_row(lat="44.0", lon="8.0", date="2026-07-11"):
    return HEADER_ONLY + f"{lat},{lon},330.1,0.4,0.4,{date},1200,N,VIIRS,n,2.0NRT,295.0,12.3,D\n"


def test_history_falls_back_to_the_sister_satellite(tmp_path):
    """SNPP returned an empty CSV for 2026-07-11..15 while NOAA-20 had ~9k rows.
    One satellite's outage must not become a silent hole in the timeline."""
    asked: list[str] = []

    def http_get(url: str) -> str:
        asked.append(url)
        return HEADER_ONLY if "VIIRS_SNPP_NRT" in url else _one_row()

    settings = load_settings(env={
        "FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path), "OUT_DIR": str(tmp_path / "o"),
    })
    total = fetch_firms_history(settings, days=5, http_get=http_get)

    assert total > 0
    assert any("VIIRS_SNPP_NRT" in u for u in asked)
    assert any("VIIRS_NOAA20_NRT" in u for u in asked)


def test_history_stops_at_the_first_satellite_with_data(tmp_path):
    asked: list[str] = []

    def http_get(url: str) -> str:
        asked.append(url)
        return _one_row()

    settings = load_settings(env={
        "FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path), "OUT_DIR": str(tmp_path / "o"),
    })
    fetch_firms_history(settings, days=5, http_get=http_get)

    # no point paying for NOAA-20 when SNPP already answered
    assert all("VIIRS_NOAA20_NRT" not in u for u in asked)


def test_scrub_removes_the_key():
    key = "0123456789abcdef0123456789abcdef"
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_NRT/x/2"
    out = scrub(f"500 Server Error for url: {url}", key)
    assert key not in out
    assert REDACTED in out


def test_scrub_is_a_noop_without_a_key():
    # No key configured means nothing to hide; the message must survive intact.
    assert scrub("500 Server Error", None) == "500 Server Error"


def test_history_never_prints_the_key_when_a_window_fails(tmp_path, capsys):
    """A failing window prints the exception, and requests puts the failing URL —
    key and all — in that exception. These logs are public on a public repo, so a
    single upstream 500 would otherwise publish a working credential."""
    key = "deadbeefdeadbeefdeadbeefdeadbeef"
    s = load_settings(env={"FIRMS_MAP_KEY": key, "DATA_DIR": str(tmp_path)})

    def boom(url: str) -> str:
        # Exactly the shape requests raises: the URL is inside the message.
        raise RuntimeError(f"500 Server Error for url: {url}")

    fetch_firms_history(s, days=5, http_get=boom)
    err = capsys.readouterr().err
    assert key not in err
    assert REDACTED in err


class _Resp:
    """Minimal stand-in for a requests Response that failed."""

    def __init__(self, url: str, status: int):
        self.status_code = status
        self._url = url

    def raise_for_status(self):
        err = RuntimeError(f"{self.status_code} Server Error for url: {self._url}")
        err.response = self  # requests attaches the response; _fault reads it
        raise err


def test_default_fetcher_scrubs_the_key(tmp_path, monkeypatch):
    """The default http_get is the path production actually takes, and it was
    marked `no cover`, so it would have passed the suite unscrubbed."""
    import requests

    key = "cafebabecafebabecafebabecafebabe"
    s = load_settings(env={"FIRMS_MAP_KEY": key, "DATA_DIR": str(tmp_path)})
    monkeypatch.setattr(requests, "get", lambda url, timeout: _Resp(url, 500))

    try:
        fetch_firms(s)
    except Exception as exc:  # noqa: BLE001 - the message is what is under test
        assert key not in str(exc)
        assert REDACTED in str(exc)
        assert "HTTP 500" in str(exc)  # the status survives the flattening
    else:
        raise AssertionError("expected the failure to propagate")


def test_default_history_fetcher_scrubs_the_key(tmp_path, monkeypatch, capsys):
    """History swallows per-window failures and PRINTS them, so the return value
    proves nothing — it is 0 whether or not the key was scrubbed. Assert on what
    actually reaches the log."""
    import requests

    key = "f00df00df00df00df00df00df00df00d"
    s = load_settings(env={"FIRMS_MAP_KEY": key, "DATA_DIR": str(tmp_path)})
    monkeypatch.setattr(requests, "get", lambda url, timeout: _Resp(url, 401))

    assert fetch_firms_history(s, days=5) == 0
    err = capsys.readouterr().err
    assert key not in err
    assert REDACTED in err
    # 401 means the key expired; 500 means NASA is down. Only one needs a human.
    assert "HTTP 401" in err


def test_nrt_scrubs_an_injected_fetchers_exception(tmp_path):
    """The injected seam bypasses the default wrapper entirely; the boundary has
    to hold regardless of who supplies the fetcher."""
    key = "abadidea0abadidea0abadidea0abad0"
    s = load_settings(env={"FIRMS_MAP_KEY": key, "DATA_DIR": str(tmp_path)})

    def boom(url: str) -> str:
        raise RuntimeError(f"500 Server Error for url: {url}")

    try:
        fetch_firms(s, http_get=boom)
    except Exception as exc:  # noqa: BLE001
        assert key not in str(exc)
        assert REDACTED in str(exc)
    else:
        raise AssertionError("expected the failure to propagate")


def test_empty_key_is_treated_as_missing(tmp_path):
    """An unset GitHub secret interpolates to "", not to nothing. "" is not None,
    so it slips past every `is None` guard — fetch_firms:89, :162 and run.py:223
    — and then builds a URL with an EMPTY key segment, fetches nothing, and
    publishes the empty archive those guards exist to refuse.

    config.py normalises it with `or None`. Deleting that normalisation left the
    whole suite green, so the line documented as preventing "precisely the
    empty-archive publish" had no test at all.
    """
    from pipeline.config import load_settings

    s = load_settings(env={"FIRMS_MAP_KEY": "", "DATA_DIR": str(tmp_path), "OUT_DIR": str(tmp_path)})
    assert s.firms_map_key is None, "empty string must read as missing, not as a key"

    # And the guard it feeds must actually fire.
    with pytest.raises(RuntimeError, match="FIRMS_MAP_KEY missing"):
        fetch_firms(s, http_get=lambda _u: "")


def test_dotenv_strips_quotes_so_the_key_is_scrubbable(tmp_path, monkeypatch):
    """`FIRMS_MAP_KEY="abc"` in a .env yielded the key WITH quotes. scrub() then
    searches for `"abc"` while requests reports the prepared URL containing
    `%22abc%22` — a literal replace misses, and the key reaches the log.

    Quotes are the common case because every shell tutorial writes them.
    """
    from pipeline.config import load_settings

    (tmp_path / ".env").write_text('FIRMS_MAP_KEY="quoted_key_123"\n')
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)

    assert load_settings().firms_map_key == "quoted_key_123"


def test_scrub_also_catches_the_percent_encoded_form():
    """requests reports the PREPARED url, so a key containing a character that
    urlencodes (a quote, a space, a slash) appears percent-encoded in the
    exception text while scrub searches for the raw value."""
    key = 'ab"cd'
    leaked = 'HTTPError: 500 for url: https://x/api/area/csv/ab%22cd/VIIRS/1'
    assert key not in scrub(leaked, key)
    assert "ab%22cd" not in scrub(leaked, key)


def test_fault_scrubs_on_its_own():
    """Both tests named "...scrubs_the_key" passed with _fault's scrub REMOVED —
    they were satisfied by the outer scrub at the call site, so nothing pinned
    _fault itself. History has no outer scrub at all, so _fault is the only
    thing standing between a 500 and the key.
    """
    key = "unit_key_abcdef"

    class Resp:
        status_code = 500

    exc = RuntimeError(f"500 Server Error for url: https://x/api/area/csv/{key}/VIIRS/1")
    exc.response = Resp()

    out = _fault(exc, key)
    assert key not in out, "_fault must scrub without help from a caller"
    assert "HTTP 500" in out, "and still say which failure it was"


def test_default_fetcher_severs_the_exception_chain(tmp_path, monkeypatch):
    """`from None` is what stops the traceback printer rendering the ORIGINAL
    requests exception — url and all — as __context__. Dropping it from either
    default wrapper left the suite green, because the chain-severing was
    actually being held by the call-site wrap one level out.

    Asserted one level in: the RuntimeError we catch is itself raised from the
    call-site handler, so the property under test lives on ITS context.
    """
    key = "chain_key_zzz"
    s = load_settings(env={"FIRMS_MAP_KEY": key, "DATA_DIR": str(tmp_path)})

    class Boom(Exception):
        pass

    def explode(_url, **_kw):
        raise Boom(f"boom https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/V/1")

    fake = types.SimpleNamespace(get=explode)
    monkeypatch.setitem(sys.modules, "requests", fake)

    with pytest.raises(RuntimeError) as ei:
        fetch_firms(s)

    # Render the traceback exactly as an unhandled exception would print it.
    # `from None` sets __suppress_context__, so __context__ stays populated but
    # the printer skips it — asserting on the chain directly would be testing a
    # proxy. This tests the thing that actually reaches the log.
    printed = "".join(
        traceback.format_exception(type(ei.value), ei.value, ei.value.__traceback__)
    )
    assert key not in printed, f"key rendered in the traceback:\n{printed}"
    assert "Boom" not in printed, "original exception still rendered as context"


def test_a_parse_failure_keeps_its_own_type_and_frame(tmp_path):
    """The scrub wrap spans the FETCH only. It used to span parsing and the
    store write too, so a KeyError from the CSV parser surfaced as a bare
    RuntimeError raised at the scrub line — original type gone, and the
    traceback pointing at a line whose only job is redacting a url.

    Nothing downstream branches on the type (run._safe catches Exception), so
    this costs nothing in production and buys back a diagnosable traceback.
    """
    s = load_settings(env={"FIRMS_MAP_KEY": "k", "DATA_DIR": str(tmp_path)})
    # Well-formed enough to fetch, malformed enough to fail in the parser.
    bad = "latitude,longitude,acq_time,satellite,confidence,frp\n1.0,2.0,1200,N,h,10\n"

    with pytest.raises(KeyError) as ei:
        fetch_firms(s, http_get=lambda _u: bad)

    frames = traceback.extract_tb(ei.value.__traceback__)
    assert any(f.name == "parse_firms_csv" for f in frames), (
        f"traceback should point at the parser, got {[f.name for f in frames]}"
    )
