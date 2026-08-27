from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .archive_tracks import archive_past_tracks, previous_archive_index
from .config import EUROPE_BBOX, Settings, load_settings
from .store import read_hotspots, write_points
from .enrich import MIN_PLACES, fetch_gdacs, load_places
from .events import cluster
from .export import export
from .fetch_firms import fetch_firms, fetch_firms_history
from .fetch_effis import fetch_effis_ba
from .fetch_effis_season import fetch_season_snapshot, snapshot_path
from .fetch_imagery import build_imagery
from .fetch_result import FetchResult, attempt, newest_timestamp
from .scale import pick_unit
from .season import season_totals
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
        frp_result = attempt(
            # Same clock the generation is stamped with, so the fetch window and
            # the freshness record cannot describe different moments — and a
            # replayed run with an injected `now` asks for that run's window.
            lambda: fetch_frp_points(EUROPE_BBOX, now=now), label="mtg-frp-points", now=now,
            default=[], observed=lambda pts: newest_timestamp(p.get("time") for p in pts),
        )
        frp_points = frp_result.data
    else:
        # Injected by callers (tests, make_sample) — treat as an observed fetch.
        frp_result = FetchResult(
            "ok" if frp_points else "empty", frp_points, now,
            newest_timestamp(p.get("time") for p in frp_points),
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
    places = load_places(places_file, min_places=MIN_PLACES) if places_file.exists() else []
    # Say so. A missing gazetteer degrades silently — every fire and scar just
    # loses its place name and gets called "Burn scar · <date>" — which is how
    # the refresh workflows ran without it for a long time unnoticed.
    print(f"[{'info' if places else 'warn'}] places: {len(places)} loaded from {places_file}")
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
    if frp_result.status == "failed":
        # Wind is sampled AT the fire pixels, so a failed FRP fetch leaves
        # nothing to query. Reporting that as "empty" would claim we looked and
        # found no wind, and would replace good data; inherit the failure so the
        # layer is carried instead.
        wind_result = FetchResult("failed", [], now)
        print("[warn] wind: skipped, no FRP pixels to sample (upstream failed)")
    else:
        wind_result = attempt(
            lambda: fetch_wind(wind_pts), label="open-meteo-wind", now=now, default=[],
            observed=lambda samples: newest_timestamp(w.get("time") for w in samples),
        )
    wind = wind_result.data
    print(f"[info] wind samples: {len(wind)}")

    # Persist each live layer as a GeoParquet snapshot (latest wins), so nothing
    # we fetch is ephemeral — every layer is a queryable local dataset.
    raw = settings.data_dir / "raw"
    _safe(lambda: write_points(frp_points, raw / "frp.parquet"), default=0, label="store-frp")
    _safe(lambda: write_points(wind, raw / "wind.parquet"), default=0, label="store-wind")

    # Historical scars come from our OWN fire detections (FIRMS/VIIRS/MTG),
    # clustered over a longer window so fires that have gone quiet persist as
    # "past" scars — no external burned-area service.
    scar_events = cluster(rows, now, window_days=SCAR_WINDOW_DAYS)
    # A past scar's own H3 arrival-footprint detail: written once per fire,
    # the run it first goes quiet enough to have left the live track window
    # (see archive_tracks.py for why that window is too short to cover the
    # scar lookback directly). Must never block publishing live fire data, so
    # a failure here falls back to "archive nothing new this run" rather than
    # aborting.
    archive_index = _safe(
        lambda: archive_past_tracks(
            settings.out_dir, scar_events, now, previous_archive_index(settings.out_dir),
        ),
        default=previous_archive_index(settings.out_dir), label="archive-past-tracks",
    )
    # EFFIS is asked at most once per run (and rate-limited to ~6 h inside
    # fetch_season_snapshot): one fragile backend, one request. The ORDER below
    # is load-bearing — fetch_effis_ba no longer talks to the network, it reads
    # the snapshot this writes, so fetching second would publish a scarless map
    # for a whole run on a cold start. fetch_season_snapshot is documented as
    # non-raising; _safe wraps it anyway because a bad EFFIS week must never
    # stop us publishing live fire data.
    season_status = _safe(
        lambda: fetch_season_snapshot(settings, now), default="stale",
        label="effis-season",
    )
    # EFFIS burned areas are a best-effort bonus tier: its Oracle backend is
    # often down, so fetch_effis_ba is self-guarding and _safe wraps it again.
    effis = _safe(lambda: fetch_effis_ba(settings), default=[], label="effis-ba")
    print(f"[info] EFFIS burned-area scars: {len(effis)} (season: {season_status})")

    # None means no snapshot to aggregate — a different page state from a season
    # total of zero. export writes no season.json for it and stamps the manifest
    # layer `fetched_at: null`, which is the flag the page reads. `season_status`
    # travels UNALTERED alongside it and is not coerced to "unavailable": a null
    # season under a "stale" status (we hold an old snapshot, the aggregation
    # over it failed) is a different fault from one under "unavailable" (there
    # is no snapshot at all), and only the pair distinguishes them.
    season = _safe(
        lambda: season_totals(snapshot_path(settings), now.year), default=None,
        label="season-totals",
    )
    if season:
        _safe(lambda: _attach_units(season), default=None, label="season-units")
        # .get() throughout: this is the only line in the block that would read
        # the dict directly, and a log line must never be what kills the run.
        print(
            f"[info] season {season.get('season_year')}: "
            f"{season.get('total_km2')} km2 over "
            f"{season.get('area_count')} mapped burn areas"
        )
    imagery_result = attempt(
        lambda: build_imagery(
            settings, scar_events, now, places, extra_scars=effis,
            archived_ids=set(archive_index),
        ),
        label="imagery-scars", now=now, default=None,
    )
    imagery = imagery_result.data
    if imagery:
        print(f"[info] imagery scars: {len(imagery['scars'])} (hd={bool(imagery['hd'])})")

    # Daily fire-activity timeline (polar detections) for the bottom histogram.
    timeline_result = attempt(
        lambda: build_timeline(rows, now), label="timeline", now=now, default=[],
        # A timeline of all-zero days is not data, whatever its length: report
        # the newest day that actually had a detection.
        observed=lambda days: newest_timestamp(
            d["date"] for d in days if d.get("count")
        ),
    )
    timeline = timeline_result.data
    print(f"[info] timeline: {sum(d['count'] for d in timeline)} detections over {len(timeline)} d")

    # Per-day Europe-wide detection slices — click a histogram day to paint it.
    day_slices = _safe(
        lambda: build_day_slices(settings.data_dir / "raw" / "hotspots.parquet", now),
        default={}, label="day-slices",
    )
    print(f"[info] day slices: {len(day_slices)} days")

    # Per-layer outcomes travel with the data so export can tell a failed fetch
    # from a genuinely empty one and decide what to carry forward.
    results = {
        "frp": frp_result,
        "wind": wind_result,
        "imagery": imagery_result,
        "timeline": timeline_result,
    }
    return export(
        settings, events, liveness, places, alerts, now,
        live_frp, frp_points, wind, imagery, timeline, day_slices,
        results=results, season=season, season_status=season_status,
    )


def _attach_units(season: dict) -> None:
    """Give the season total and each country its scale unit, in place.

    Every call is guarded because pick_unit raises on a non-positive total by
    design: zero is a distinct page state, not a grid of no tiles. The guard is
    per value, not per season — season_totals rounds each country
    independently, so a 4 ha perimeter is 0.0 km2 under a healthy total. Where
    there is no honest unit the key is simply absent, and export emits null.
    """
    if season.get("total_km2", 0) > 0:
        season["unit"] = pick_unit(season["total_km2"])
    for country in season.get("countries") or []:
        if country.get("km2", 0) > 0:
            country["unit"] = pick_unit(country["km2"])


def _safe(fn, default, label: str):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - degraded mode by design
        print(f"[warn] {label} failed: {e}", file=sys.stderr)
        return default


def refresh(settings: Settings, tier: str = "full") -> None:
    """Run one refresh at the given tier.

    "fast" (every 30 min): live layers only — MTG FRP and wind —
    re-clustered against the archive already on disk. Nothing here needs a key.

    "full" (hourly): also tops up the polar (VIIRS/MODIS) archive and the slow
    bonus tiers. A missing FIRMS key is FATAL here rather than a warning: an
    empty archive publishes a map with no fires and no timeline, which is
    exactly the failure that shipped to production.
    """
    if tier not in ("fast", "full"):
        raise ValueError(f"unknown tier {tier}")
    if tier == "full":
        if settings.firms_map_key is None:
            raise RuntimeError(
                "FIRMS_MAP_KEY missing — refusing to publish an empty archive"
            )
        # History BEFORE the 2-day NRT poll, and the order is load-bearing.
        # fetch_firms_history skips any window ending at or below the latest
        # day already stored, so letting the NRT poll land first stamps the
        # store with today and makes the 30-day seed skip EVERY window — a cold
        # start then yields two days of history and a near-empty timeline,
        # silently, because both calls report success.
        _safe(lambda: fetch_firms_history(settings), 0, "firms-history")
        _safe(lambda: fetch_firms(settings), 0, "firms")
        _safe(lambda: fetch_meteosat(settings), None, "meteosat")
    process(settings, now=datetime.now(timezone.utc))


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "refresh"
    settings = load_settings()
    tier = sys.argv[2] if len(sys.argv) > 2 else "full"
    if cmd == "refresh":
        refresh(settings, tier=tier)
    elif cmd == "watch":
        import os

        interval = int(os.environ.get("WATCH_INTERVAL_S", "600"))
        while True:
            refresh(settings, tier=tier)
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
