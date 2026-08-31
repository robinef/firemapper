"""Season-to-date burned area from api2.effis.emergency.copernicus.eu.

A separate source from `pipeline/fetch_effis_season.py`. That module polls
the ies-ows.jrc.ec.europa.eu WFS (Oracle-backed) for individual burned-area
POLYGONS, and `fetch_effis_ba` (pipeline/fetch_effis.py) reads its snapshot
to draw before/after scar imagery on the live map — that dependency is real
and this module must never touch it. api2 is EFFIS's own "Seasonal Trend"
app's data source (confirmed via browser network capture), a different
backend (gunicorn, not the Oracle WFS, and not affected by the WFS's
`msOracleSpatialLayerOpen(): ... Connection failure` outage that has run
since this repo's season feature launched). It has no per-fire polygons at
all, only pre-aggregated weekly + cumulative burnt-area stats per year,
EU-wide and per EU country — exactly the "how much burned this season"
question `/scale` asks and nothing `fetch_effis_ba` needs.

One HTTP request per country (27, hardcoded — EU membership is static) plus
one EU-wide request; no pagination, unlike the WFS.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# Country calls are independent, I/O-bound HTTP requests, so a small pool of
# workers turns 27 sequential round-trips into a handful of overlapping ones.
# Capped well below 27 to stay polite to api2's single host, not to bound
# local resource use.
COUNTRY_FETCH_WORKERS = 8

STATS_BASE = "https://api2.effis.emergency.copernicus.eu/statistics/v2/effis"
MIN_AGE_HOURS = 6.0

# The 27 EU member states, as returned by
# api2.../statistics/utils/countriesbyaoi?aoi=EU. `name` is already EFFIS's
# own canonical English display name.
EU_COUNTRIES: dict[str, str] = {
    "AUT": "Austria", "BEL": "Belgium", "BGR": "Bulgaria", "HRV": "Croatia",
    "CYP": "Cyprus", "CZE": "Czech Republic", "DNK": "Denmark",
    "EST": "Estonia", "FIN": "Finland", "FRA": "France", "DEU": "Germany",
    "GRC": "Greece", "HUN": "Hungary", "IRL": "Ireland", "ITA": "Italy",
    "LVA": "Latvia", "LTU": "Lithuania", "LUX": "Luxembourg", "MLT": "Malta",
    "NLD": "Netherlands", "POL": "Poland", "PRT": "Portugal",
    "ROU": "Romania", "SVK": "Slovakia", "SVN": "Slovenia", "ESP": "Spain",
    "SWE": "Sweden",
}


def snapshot_path(settings) -> Path:
    return settings.data_dir / "raw" / "effis_stats.json"


def _eu_url(year: int) -> str:
    return f"{STATS_BASE}/weeklyaoi?aoi=EU&year={year}"


def _country_url(iso3: str, year: int) -> str:
    return f"{STATS_BASE}/weekly?country={iso3}&year={year}"


def _latest_cumulative(payload: dict) -> dict | None:
    """Season-to-date entry: the last `banfcumulative` row with a real
    `area_ha`. Future weeks are pre-listed with `area_ha: null`, so this is
    not simply the last entry in the array."""
    entries = payload.get("banfcumulative")
    if not isinstance(entries, list):
        return None
    actual = [e for e in entries if isinstance(e, dict) and e.get("area_ha") is not None]
    return actual[-1] if actual else None


def _fault(exc: Exception) -> str:
    """One-line reason. api2 errors as plain HTTP + a body (JSON `detail`
    when the backend is up but complaining, HTML/plain text on a gateway
    failure) — unlike the WFS's OWS ExceptionReport XML, so no XML parsing
    here."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    body = getattr(response, "text", "") or ""
    detail = ""
    if body:
        try:
            doc = json.loads(body)
            if isinstance(doc, dict):
                detail = doc.get("detail") or doc.get("message") or doc.get("error") or ""
        except ValueError:
            detail = body
    if not detail:
        detail = str(exc)
    return f"HTTP {status}: {detail}" if status else detail


def should_fetch(path: Path, now: datetime, min_age_hours: float = MIN_AGE_HOURS) -> bool:
    """False while the stored snapshot is younger than the gate. api2 data
    itself only advances weekly, so polling every pipeline run (~15 min)
    would be pure waste."""
    try:
        stamp = json.loads(path.read_text()).get("fetched_at")
    except Exception:  # noqa: BLE001 - missing/malformed snapshot: worth refetching
        return True
    try:
        fetched_at = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return True
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    return (now - fetched_at).total_seconds() >= min_age_hours * 3600


def fetch_stats_snapshot(
    settings,
    now: datetime,
    http_get: Callable[[str], str] | None = None,
) -> str:
    """Fetch EU-wide + per-country season-to-date totals, write the snapshot,
    return "fresh" | "reused" | "stale" — same vocabulary, same "never let
    this bonus tier fail the run" contract as fetch_effis_season's fetcher.

    A single failed country call degrades that country out of the list
    rather than failing the whole snapshot: the EU total (what the page's
    headline sentence needs) does not depend on any one country succeeding.
    """
    path = snapshot_path(settings)
    if not should_fetch(path, now):
        return "reused"

    if http_get is None:
        import requests

        def http_get(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            return r.text

    year = now.year
    try:
        eu_payload = json.loads(http_get(_eu_url(year)))
        # Same try as the fetch: a malformed (non-object) body must produce
        # the deliberate "stale" message below, not an uncaught AttributeError
        # from _latest_cumulative that run.py's _safe() catches anyway but
        # without this function's own diagnostic.
        eu_latest = _latest_cumulative(eu_payload)
    except Exception as exc:  # noqa: BLE001 - api2 best-effort, never fatal
        print(
            f"[warn] effis-stats: no rows, keeping previous snapshot — {_fault(exc)}",
            file=sys.stderr,
        )
        return "stale"
    if eu_latest is None:
        print(
            "[warn] effis-stats: no rows, keeping previous snapshot — "
            "api2 returned no season-to-date week yet",
            file=sys.stderr,
        )
        return "stale"

    def _fetch_one(item: tuple[str, str]) -> tuple[str, dict | None]:
        iso3, name = item
        try:
            payload = json.loads(http_get(_country_url(iso3, year)))
            # Inside the same try as the fetch: a body that parses as JSON but
            # isn't the expected object shape (api2 returning a bare list/null
            # for one country) must degrade this country alone, not raise out
            # of the pool and discard every already-fetched country with it.
            latest = _latest_cumulative(payload)
        except Exception as exc:  # noqa: BLE001 - one country must not sink the rest
            print(f"[warn] effis-stats: {iso3} skipped — {_fault(exc)}", file=sys.stderr)
            return iso3, None
        if latest is None:
            return iso3, None
        return iso3, {
            "name": name,
            # .get(), not [...]: only `area_ha` is guaranteed non-null by
            # _latest_cumulative. A country missing `mddate` or `events` must
            # degrade gracefully, same as a country whose HTTP call failed —
            # not raise here, outside the try/except above, and take the
            # other 26 already-fetched countries down with it.
            "mddate": latest.get("mddate"),
            "events": latest.get("events") or 0,
            "area_ha": latest["area_ha"],
        }

    # Independent I/O-bound calls, so a worker pool overlaps their round-trips
    # rather than paying 27 timeouts back to back. Each still degrades on its
    # own via _fetch_one's own try/except — a pool failure isolates exactly
    # the way the old sequential loop did, just concurrently.
    with ThreadPoolExecutor(max_workers=COUNTRY_FETCH_WORKERS) as pool:
        results = pool.map(_fetch_one, EU_COUNTRIES.items())
    countries: dict[str, dict] = {
        iso3: entry for iso3, entry in results if entry is not None
    }

    snapshot = {
        "fetched_at": now.isoformat(),
        "season_year": year,
        "eu": {
            "mddate": eu_latest.get("mddate"),
            "events": eu_latest.get("events") or 0,
            "area_ha": eu_latest["area_ha"],
        },
        "countries": countries,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot))
    return "fresh"
