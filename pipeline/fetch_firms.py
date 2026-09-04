from __future__ import annotations

import csv
import hashlib
from urllib.parse import quote
import io
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .config import EUROPE_BBOX, Settings

# Same VIIRS instrument on three platforms. Tried in order per history window:
# an outage on one satellite must not become a hole in the timeline. Observed
# 2026-07-11..15, where SNPP returned an empty CSV while NOAA-20 had ~9k rows.
HISTORY_SOURCES = ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")
from .store import append_hotspots  # re-export: hotspots persist as GeoParquet

# FIRMS area API. VIIRS (3 sats) + MODIS. Docs: https://firms.modaps.eosdis.nasa.gov/api/area/
FIRMS_SOURCES = [
    ("VIIRS_SNPP_NRT", "viirs"),
    ("VIIRS_NOAA20_NRT", "viirs"),
    ("VIIRS_NOAA21_NRT", "viirs"),
    ("MODIS_NRT", "modis"),
]
_LOW_CONF = {"viirs": {"l"}, "modis": {str(i) for i in range(0, 30)}}  # modis numeric <30
# FIRMS `type`: 0 = presumed vegetation fire, 1 = active volcano, 2 = other
# static land source, 3 = offshore (observed to be gas flares — persistent,
# realistic FRP, and clustered exactly like a real fire, which is why
# confidence alone never caught them). Missing `type` is kept, not dropped:
# not every source/version of this API returns the column, and a detection
# with no type info is not evidence it's a false positive.
_EXCLUDED_TYPES = {"2", "3"}

REDACTED = "<FIRMS_MAP_KEY>"


def scrub(text: str, key: str | None) -> str:
    """Remove the FIRMS key from anything on its way to a log.

    The key is a path segment, not a query parameter or a header — NASA's area
    API offers no alternative — so every URL built here carries the credential.
    `requests` puts the failing URL into its exception messages, and this
    pipeline runs in GitHub Actions on a PUBLIC repository, where job logs are
    world-readable and retained. So one upstream 500, or one expired key
    returning 401, would publish a working credential to anyone watching.

    Scrubbing at the point of logging rather than trusting callers: the key can
    reach a log through a raised exception, a caught-and-printed one, or a
    traceback, and each of those has its own path out.
    """
    if not key:
        return text
    out = text.replace(key, REDACTED)
    # requests reports the PREPARED url, so a key containing anything not
    # url-safe (a quote, a space) appears percent-encoded there while the raw
    # value never matches. Scrub both spellings.
    encoded = quote(key, safe="")
    if encoded != key:
        out = out.replace(encoded, REDACTED)
    return out


def _fault(exc: Exception, key: str | None) -> str:
    """A scrubbed message that still says WHICH failure it was.

    Flattening every requests exception into a bare RuntimeError loses the
    status code, and 401 (the key expired) reads very differently from 500 (NASA
    is down): one needs a human, the other needs patience. Nothing downstream
    catches a requests type — attempt() and run._safe both catch Exception — so
    the type can go, but the status should not.
    """
    status = getattr(getattr(exc, "response", None), "status_code", None)
    prefix = f"HTTP {status}: " if status else ""
    return prefix + scrub(str(exc), key)


def _src_id(lat: float, lon: float, t: datetime, sat: str, tier: str) -> str:
    return hashlib.sha1(
        f"{lat:.5f},{lon:.5f},{t.isoformat()},{sat},{tier}".encode()
    ).hexdigest()


def parse_firms_csv(text: str, tier: str) -> list[dict]:
    rows: list[dict] = []
    for rec in csv.DictReader(io.StringIO(text)):
        conf = rec.get("confidence", "").strip().lower()
        if conf in _LOW_CONF.get(tier, set()):
            continue
        if rec.get("type", "").strip() in _EXCLUDED_TYPES:
            continue
        d, hm = rec["acq_date"], rec["acq_time"].zfill(4)
        t = datetime.strptime(f"{d} {hm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
        lat, lon = float(rec["latitude"]), float(rec["longitude"])
        sat = rec.get("satellite", "")
        rows.append(
            {
                "lat": lat, "lon": lon, "acq_time": t, "tier": tier, "satellite": sat,
                "confidence": conf, "frp": float(rec.get("frp") or 0.0),
                "src_id": _src_id(lat, lon, t, sat, tier),
            }
        )
    return rows


def fetch_firms(settings: Settings, http_get: Callable[[str], str] | None = None) -> int:
    if settings.firms_map_key is None:
        raise RuntimeError("FIRMS_MAP_KEY missing (see .env.example)")
    if http_get is None:
        import requests

        def http_get(url: str) -> str:
            try:
                r = requests.get(url, timeout=60)
                r.raise_for_status()
            except Exception as exc:  # noqa: BLE001 - re-raised, only the text changes
                # `from None` severs the chain so a traceback printer cannot
                # render the original requests exception, un-scrubbed URL and
                # all, as __context__.
                #
                # Belt and braces, not load-bearing: mutation testing shows
                # removing it here changes nothing observable, because the
                # call-site wrap below re-raises `from None` too and that is
                # what actually holds the property today. Kept because this
                # wrapper is the boundary that SHOULD own it — the call-site
                # wrap exists for injected fetchers, and narrowing or moving it
                # must not silently unseal this path. No test can pin it while
                # the outer layer masks it; the mutation result is the record.
                raise RuntimeError(_fault(exc, settings.firms_map_key)) from None
            return r.text

    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    area = f"{lon_min},{lat_min},{lon_max},{lat_max}"
    store = settings.data_dir / "raw" / "hotspots.parquet"
    total = 0
    for source, tier in FIRMS_SOURCES:
        url = (
            f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
            f"{settings.firms_map_key}/{source}/{area}/2"  # last 2 days per poll
        )
        # Scrubbed HERE, not only inside the default http_get: that wrapper only
        # exists when no fetcher was injected, so a caller-supplied one (tests,
        # make_sample) would otherwise raise straight past it and land, verbatim,
        # in whatever prints it. The injection seam exists to be used; the
        # boundary has to hold regardless of who supplies the fetcher.
        try:
            body = http_get(url)
        except Exception as exc:  # noqa: BLE001 - re-raised, only the text changes
            raise RuntimeError(scrub(str(exc), settings.firms_map_key)) from None
        # Parsing and the store write stay OUTSIDE the try. Only the fetch can
        # carry the url, and wrapping them too flattened a KeyError from the CSV
        # parser, or a DuckDB IO error from the store, into a bare RuntimeError
        # raised at this line — losing both the type and the frame that actually
        # failed, on a line whose only job is scrubbing a url.
        total += append_hotspots(parse_firms_csv(body, tier), store)
    return total


def _store_latest_viirs(store: Path):
    """Most recent stored VIIRS acq_time (a date), or None if none/no store.
    Used to fetch only newer days instead of re-pulling the whole window."""
    if not store.exists():
        return None
    try:
        from .store import connect

        row = connect().execute(
            f"SELECT max(acq_time) FROM read_parquet('{store}') WHERE tier = 'viirs'"
        ).fetchone()
    except Exception:  # noqa: BLE001 - treat an unreadable store as empty
        return None
    return row[0].date() if row and row[0] else None


def fetch_firms_history(
    settings: Settings, days: int | None = None, http_get: Callable[[str], str] | None = None
) -> int:
    """Append recent VIIRS hotspots to the persistent store so past fires exist
    as historical scars. Needs a FIRMS key; no key → no-op (0).

    The window size defaults to settings.firms_history_days (30) but an explicit
    `days` arg overrides it. NRT covers only ~the last 2 months; windows older
    than ~60 days need the SP (Standard Processing) archive, which is out of
    scope here.

    Incremental: the store is a src_id-deduped cache, so windows already covered
    by it are skipped and only days newer than the latest stored VIIRS detection
    are fetched — a first run pulls the full `days`, later runs pull ~one window.
    (Gaps below the latest stored day are NOT backfilled here; wipe the store to
    force a full refetch.) The area API caps a dated request at 5 days, so this
    chains 5-day windows back from today.
    """
    if days is None:
        days = settings.firms_history_days
    if settings.firms_map_key is None:
        return 0
    if http_get is None:
        import requests

        def http_get(url: str) -> str:
            try:
                r = requests.get(url, timeout=120)
                r.raise_for_status()
            except Exception as exc:  # noqa: BLE001 - re-raised, only the text changes
                raise RuntimeError(_fault(exc, settings.firms_map_key)) from None
            return r.text

    from datetime import datetime, timedelta, timezone

    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    area = f"{lon_min},{lat_min},{lon_max},{lat_max}"
    store = settings.data_dir / "raw" / "hotspots.parquet"
    today = datetime.now(timezone.utc).date()
    have_until = _store_latest_viirs(store)
    total = 0
    # NRT (near-real-time), NOT SP (Standard Processing): the SP archive lags
    # ~2-3 months, so it has nothing for the last 30 days.
    for start_offset in range(days, 0, -5):
        start = today - timedelta(days=start_offset)
        span = min(5, start_offset)
        window_end = start + timedelta(days=span)
        # Skip windows the store already fully covers (fetch only newer days).
        if have_until is not None and window_end <= have_until:
            continue
        # One satellite is a single point of failure: an SNPP processing outage
        # returns HTTP 200 with a header row and no data, which would land as a
        # silent multi-day hole in the timeline. Fall through to the sister
        # platforms, which fly the same instrument, before giving up on a window.
        window_rows = 0
        for source in HISTORY_SOURCES:
            url = (
                f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
                f"{settings.firms_map_key}/{source}/{area}/{span}/{start.isoformat()}"
            )
            try:
                rows = parse_firms_csv(http_get(url), "viirs")
            except Exception as e:  # noqa: BLE001 - history is best-effort
                print(
                    f"[warn] firms-history {source} {start}: "
                    f"{scrub(str(e), settings.firms_map_key)}",
                    file=sys.stderr,
                )
                continue
            if rows:
                window_rows = append_hotspots(rows, store)
                break
        if not window_rows:
            print(
                f"[warn] firms-history: no detections for the 5 days from {start} "
                f"from any of {', '.join(HISTORY_SOURCES)}",
                file=sys.stderr,
            )
        total += window_rows
    return total
