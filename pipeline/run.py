from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import EUROPE_BBOX, Settings, load_settings
from .store import read_hotspots, write_points
from .enrich import fetch_gdacs, load_places
from .events import cluster
from .export import export
from .fetch_firms import fetch_firms, fetch_firms_history
from .fetch_aircraft import fetch_aircraft
from .fetch_effis import fetch_effis_ba
from .fetch_imagery import build_imagery
from .timeline import build_timeline
from .day_slices import build_day_slices

# Cluster over a longer window than the live layer so fires that have gone quiet
# still surface as historical ("past") scars.
SCAR_WINDOW_DAYS = 45
from .fetch_wind import fetch_wind, wind_sample_points
from .fetch_meteosat import (
    EUMETVIEW_WMS,
    MTG_FRP_LAYER,
    fetch_frp_points,
    fetch_meteosat,
    liveness_for_events,
    mtg_frp_extent,
)


def _load_rows(settings: Settings) -> list[dict]:
    return read_hotspots(settings.data_dir / "raw" / "hotspots.parquet")


def _frp_as_rows(frp_points: list[dict], now: datetime) -> list[dict]:
    """MTG FRP pixels as hotspot rows so events/footprint share one source."""
    out = []
    for p in frp_points:
        age = p.get("age_min")
        t = now if age is None else now - timedelta(minutes=age)
        out.append({
            "lat": p["lat"], "lon": p["lon"], "acq_time": t, "tier": "meteosat",
            "satellite": "MTG-I1", "confidence": "n", "frp": p.get("frp", 0.0),
            "src_id": f"{p['lon']:.4f},{p['lat']:.4f}",
        })
    return out


def process(settings: Settings, now: datetime, frp_points: list[dict] | None = None) -> Path:
    rows = _load_rows(settings)
    # Fetch the MTG pixels first: when there are no polar (VIIRS/MODIS)
    # detections, events, footprint and isochrones must all derive from this
    # one source, or the markers and outlines describe different fires.
    if frp_points is None:
        frp_points = _safe(
            lambda: fetch_frp_points(EUROPE_BBOX), default=[], label="mtg-frp-points"
        )
    print(f"[info] MTG FRP pixels: {len(frp_points)}")
    # Always fuse the live MTG pixels with the (VIIRS/MODIS) archive: VIIRS gives
    # real ignition dates + geometry, MTG gives 10-min liveness and catches fresh
    # fires VIIRS has not passed over yet. frp_points is the authoritative current
    # MTG snapshot, so drop any stale stored meteosat rows before adding it.
    rows = [r for r in rows if r["tier"] != "meteosat"]
    if frp_points:
        rows = rows + _frp_as_rows(frp_points, now)
    events = cluster(rows, now)
    met_rows = [r for r in rows if r["tier"] == "meteosat"]
    liveness = liveness_for_events(events, met_rows)
    places_file = settings.data_dir / "places" / "cities15000.txt"
    places = load_places(places_file) if places_file.exists() else []
    alerts = _safe(lambda: fetch_gdacs(), default=[], label="gdacs")

    extent = _safe(mtg_frp_extent, default=None, label="mtg-frp-extent")
    live_frp = (
        {
            "url": EUMETVIEW_WMS, "layer": MTG_FRP_LAYER,
            "latest": extent["end"], "step": extent["step"],
        }
        if extent
        else None
    )
    if live_frp:
        print(f"[info] MTG FRP live tier: latest {extent['end']} every {extent['step']}")

    wind_pts = wind_sample_points(frp_points)
    wind = _safe(lambda: fetch_wind(wind_pts), default=[], label="open-meteo-wind")
    print(f"[info] wind samples: {len(wind)}")

    aircraft = _safe(fetch_aircraft, default=[], label="opensky-aircraft")
    print(f"[info] firefighting aircraft: {len(aircraft)}")

    # Persist each live layer as a GeoParquet snapshot (latest wins), so nothing
    # we fetch is ephemeral — every layer is a queryable local dataset.
    raw = settings.data_dir / "raw"
    _safe(lambda: write_points(frp_points, raw / "frp.parquet"), default=0, label="store-frp")
    _safe(lambda: write_points(wind, raw / "wind.parquet"), default=0, label="store-wind")
    _safe(lambda: write_points(aircraft, raw / "aircraft.parquet"), default=0, label="store-aircraft")

    # Historical scars come from our OWN fire detections (FIRMS/VIIRS/MTG),
    # clustered over a longer window so fires that have gone quiet persist as
    # "past" scars — no external burned-area service.
    scar_events = cluster(rows, now, window_days=SCAR_WINDOW_DAYS)
    # EFFIS burned areas are a best-effort bonus tier: its Oracle backend is
    # often down, so fetch_effis_ba is self-guarding and _safe wraps it again.
    effis = _safe(lambda: fetch_effis_ba(settings), default=[], label="effis-ba")
    print(f"[info] EFFIS burned-area scars: {len(effis)}")
    imagery = _safe(
        lambda: build_imagery(settings, scar_events, now, places, extra_scars=effis),
        default=None, label="imagery-scars"
    )
    if imagery:
        print(f"[info] imagery scars: {len(imagery['scars'])} (hd={bool(imagery['hd'])})")

    # Daily fire-activity timeline (polar detections) for the bottom histogram.
    timeline = build_timeline(rows, now)
    print(f"[info] timeline: {sum(d['count'] for d in timeline)} detections over {len(timeline)} d")

    # Per-day Europe-wide detection slices — click a histogram day to paint it.
    day_slices = _safe(
        lambda: build_day_slices(settings.data_dir / "raw" / "hotspots.parquet", now),
        default={}, label="day-slices",
    )
    print(f"[info] day slices: {len(day_slices)} days")

    return export(
        settings, events, liveness, places, alerts, now,
        live_frp, frp_points, wind, aircraft, imagery, timeline, day_slices,
    )


def _safe(fn, default, label: str):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - degraded mode by design
        print(f"[warn] {label} failed: {e}", file=sys.stderr)
        return default


def refresh(settings: Settings) -> None:
    _safe(lambda: fetch_firms(settings), 0, "firms")
    # Seed ~30 days of VIIRS history (needs a FIRMS key) so past fires exist as
    # scars; without a key this no-ops and past scars stay sparse.
    _safe(lambda: fetch_firms_history(settings), 0, "firms-history")
    _safe(lambda: fetch_meteosat(settings), None, "meteosat")
    process(settings, now=datetime.now(timezone.utc))


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "refresh"
    settings = load_settings()
    if cmd == "refresh":
        refresh(settings)
    elif cmd == "watch":
        import os

        interval = int(os.environ.get("WATCH_INTERVAL_S", "600"))
        while True:
            refresh(settings)
            time.sleep(interval)
    elif cmd == "bench":
        bench = load_settings(env={"DATA_DIR": "data/bench", "OUT_DIR": "data/bench/out"})
        t0 = time.monotonic()
        process(bench, now=datetime.now(timezone.utc))
        dt = time.monotonic() - t0
        print(f"processing: {dt:.1f}s")
        sys.exit(0 if dt < 60 else 1)
    else:
        sys.exit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
