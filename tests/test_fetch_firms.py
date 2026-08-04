from datetime import datetime, timezone

from pipeline.config import load_settings
from pipeline.fetch_firms import (
    REDACTED,
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
