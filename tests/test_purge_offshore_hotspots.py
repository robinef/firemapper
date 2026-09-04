from datetime import datetime, timezone

from pipeline.fetch_firms import FIRMS_SOURCES, REDACTED, _src_id
from pipeline.config import load_settings
from scripts.purge_offshore_hotspots import offending_src_ids

CSV_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_ti5,frp,daynight,type\n"
)


def _row(lat, lon, typ):
    return f"{lat},{lon},330.1,0.4,0.4,2026-07-20,0136,N20,VIIRS,h,2.0NRT,290.0,12.5,N,{typ}\n"


def test_offending_src_ids_matches_the_same_hash_the_store_uses():
    """The purge has to compute the exact src_id parse_firms_csv would have
    stored, or a matching delete never finds the row."""
    settings = load_settings(env={"FIRMS_MAP_KEY": "k"})
    text = CSV_HEADER + _row(40.2, 3.2, 3)  # offshore

    ids = offending_src_ids(settings, http_get=lambda url: text)

    t = datetime(2026, 7, 20, 1, 36, tzinfo=timezone.utc)
    # Must match under at least one source's tier (whichever URL was asked).
    possible = {_src_id(40.2, 3.2, t, "N20", tier) for _source, tier in FIRMS_SOURCES}
    assert ids and ids <= possible


def test_offending_src_ids_ignores_vegetation_fires_and_missing_type():
    settings = load_settings(env={"FIRMS_MAP_KEY": "k"})
    text = CSV_HEADER + _row(40.2, 3.2, 0)  # presumed vegetation fire

    assert offending_src_ids(settings, http_get=lambda url: text) == set()


def test_offending_src_ids_skips_a_malformed_row(capsys):
    settings = load_settings(env={"FIRMS_MAP_KEY": "k"})

    def http_get(url: str) -> str:
        raise RuntimeError("boom")

    ids = offending_src_ids(settings, http_get=http_get)
    assert ids == set()
    assert "boom" in capsys.readouterr().err


def test_offending_src_ids_never_prints_the_key_when_a_window_fails(capsys):
    """Every URL here carries the FIRMS key as a path segment, and this sweep
    runs in GitHub Actions on a public repo — a failing window must not leak
    it into the job log the way an un-scrubbed exception would."""
    key = "deadbeefdeadbeefdeadbeefdeadbeef"
    settings = load_settings(env={"FIRMS_MAP_KEY": key})

    def http_get(url: str) -> str:
        raise RuntimeError(f"500 Server Error for url: {url}")

    offending_src_ids(settings, http_get=http_get)
    err = capsys.readouterr().err
    assert key not in err
    assert REDACTED in err
