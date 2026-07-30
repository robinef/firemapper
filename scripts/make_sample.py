"""Build a local demo dataset + artifacts, real data when possible.

With a `FIRMS_MAP_KEY` this tops up the real VIIRS archive (30 days) and fuses
live Meteosat pixels — the same data the deployed site shows.

**Without a key it falls back to synthetic fires**, deterministic (seed 42):
a handful across southern Europe in different lifecycle states (accelerating /
growing / steady / declining), with movement tracks and Meteosat liveness rows.
That fallback is the point of `make sample`: the README promises a working demo
with no account, and an empty map is not a demo.

Either way it then runs the processing stage to emit web/public/data/ artifacts.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from pipeline.config import load_settings
from pipeline.fetch_firms import append_hotspots
from pipeline.run import process
from pipeline.store import read_hotspots

random.seed(42)
NOW = datetime.now(timezone.utc)


def _rows_for_fire(lat0, lon0, drift_deg, kind, met=False):
    """Emit detections over ~3 days. kind sets growth shape."""
    rows = []
    # marching front: one step per 6h bin, distinct adjacent cells for growth
    if kind == "accelerating":
        # sparse early, dense last 24h
        schedule = [(72, 1), (60, 1), (36, 1), (18, 3), (10, 4), (4, 5)]
    elif kind == "growing":
        schedule = [(60, 2), (42, 2), (24, 2), (12, 2), (4, 2)]
    elif kind == "steady":
        schedule = [(60, 2), (36, 2), (12, 1), (4, 1)]
    else:  # declining
        schedule = [(70, 5), (52, 4), (30, 2), (26, 1)]
    step = 0
    for hours_ago, n in schedule:
        t = NOW - timedelta(hours=hours_ago)
        for _ in range(n):
            lat = lat0 + drift_deg[0] * step + random.uniform(-0.002, 0.002)
            lon = lon0 + drift_deg[1] * step + random.uniform(-0.002, 0.002)
            frp = random.uniform(20, 400)
            rows.append(_hot(lat, lon, t, "viirs", frp))
            step += 1
    if met:
        # fresh Meteosat liveness pixel near the latest position (~15 min ago)
        lat = lat0 + drift_deg[0] * step
        lon = lon0 + drift_deg[1] * step
        rows.append(_hot(lat, lon, NOW - timedelta(minutes=15), "meteosat", 350.0))
    return rows


def _hot(lat, lon, t, tier, frp):
    import hashlib

    return {
        "lat": round(lat, 5), "lon": round(lon, 5), "acq_time": t, "tier": tier,
        "satellite": "MTG-I1" if tier == "meteosat" else "SYN", "confidence": "n" if tier == "meteosat" else "h",
        "frp": round(frp, 1),
        "src_id": hashlib.sha1(f"{lat},{lon},{t.isoformat()},{tier}".encode()).hexdigest(),
    }


FIRES = [
    # (name, lat, lon, drift(lat,lon)/step, kind, meteosat_live)
    ("Attica GR", 38.10, 23.60, (0.006, 0.004), "accelerating", True),
    ("Central PT", 39.90, -7.60, (0.004, -0.005), "growing", True),
    ("Andalusia ES", 37.30, -6.00, (0.0, 0.006), "steady", False),
    ("Corsica FR", 42.20, 9.10, (-0.005, 0.0), "declining", False),
    ("Basilicata IT", 40.60, 16.20, (0.005, 0.005), "growing", False),
    ("Serbia RS", 44.80, 20.00, (0.003, -0.004), "accelerating", False),
    # Gironde pine forest south of Bordeaux (Landiras 2022 megafire area)
    ("Gironde FR", 44.45, -0.50, (0.006, -0.005), "accelerating", True),
]


def main() -> None:
    import os

    # No explicit env → load_settings reads .env + os.environ (so SENTINELHUB_*
    # for HD imagery is picked up). Dir defaults are already data / web/public/data.
    settings = load_settings()
    store = settings.data_dir / "raw" / "hotspots.parquet"
    # The parquet store is a persistent, src_id-deduped cache. Reuse it and only
    # fetch VIIRS days newer than what's already there — a full 30-day refetch
    # happens only on the first run (empty store) or on demand (FULL=1, e.g. to
    # heal gaps left by rate-limited windows).
    if os.environ.get("FULL") and store.exists():
        store.unlink()
        print("[info] FULL=1 → wiped store, refetching 30 d")
    from pipeline.fetch_firms import fetch_firms_history

    hist = fetch_firms_history(settings)
    print(f"[info] FIRMS history hotspots (new): {hist}")

    # fetch_firms_history returns 0 without a key rather than raising, so a
    # keyless run would otherwise publish an empty map and look broken. Fall
    # back to synthetic fires so `make sample` always produces a usable demo.
    if not store.exists() or not read_hotspots(store):
        rows: list[dict] = []
        for _name, lat, lon, drift, kind, met in FIRES:
            rows.extend(_rows_for_fire(lat, lon, drift, kind, met=met))
        append_hotspots(rows, store)
        print(f"[info] no real detections available → {len(rows)} synthetic rows")

    gen = process(settings, now=NOW)
    print(f"sample: {gen}")


if __name__ == "__main__":
    main()
