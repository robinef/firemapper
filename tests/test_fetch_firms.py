from datetime import datetime, timezone

from pipeline.config import load_settings
from pipeline.fetch_firms import (
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
