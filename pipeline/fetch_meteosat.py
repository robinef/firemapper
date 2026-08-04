"""MTG FCI liveness tier. Liveness ONLY (spec §6): freshness + FRP trend.

Real fetch uses eumdac (optional dep) against EUMETSAT Data Store; requires a
free NRT licence. Product choice FIR vs FRP is decided at implementation and
documented here. Absence of credentials / eumdac → None → the pipeline
continues in degraded mode (no live tier).
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Callable
from urllib.parse import quote

import h3

from .config import H3_RES, Settings
from .fetch_firms import _src_id, append_hotspots

# EUMETView serves the MTG Fire Radiative Power product over plain WMS with a
# ~10-minute time dimension — no Data Store account or NRT licence needed.
EUMETVIEW_WMS = "https://view.eumetsat.int/geoserver/ows"
MTG_FRP_LAYER = "mtg_fd:frp"

# The service still throws the occasional server-side fault (a bare
# NullPointerException as HTTP 400, or a 503) on a request it answers fine
# seconds later, so a spent attempt is worth one more. This is NOT the remedy
# for the sortBy fault below: that one is deterministic and retrying it only
# burns the refresh budget.
FRP_ATTEMPTS = 3
FRP_BACKOFF_S = 2.0

# How far back to ask for. The cap below can only truncate from the OLD end (see
# _wfs_points_url), so the window has to be short enough that a busy day still
# fits under FRP_COUNT. Measured 2026-08-04 over Europe: 2 h ≈ 2.1k features,
# 6 h ≈ 5.0k, 12 h ≈ 6.4k, 24 h ≈ 32k. Six hours leaves a wide margin against
# FRP_COUNT while comfortably outliving a missed refresh — MTG publishes every
# ~10 min, and the layer's own budget is one hour.
FRP_WINDOW_H = 6
# Sized above the worst measured window by ~4x. A window that overflows this is
# silently truncated to its OLDEST features, which is exactly the stale-data
# failure this module exists to avoid — fetch_frp_points warns when it happens.
FRP_COUNT = 20000
# Per-attempt cap. Successful calls land in seconds; anything near this is the
# service being down, where retrying is pointless — so keep the ceiling low
# enough that three attempts cannot stall a refresh (3 x 60 s worst case, and
# attempt() carries the previous layer forward anyway).
FRP_TIMEOUT_S = 60


def _wfs_points_url(
    bbox: tuple[float, float, float, float], count: int, since: datetime
) -> str:
    """A time-windowed request. Recency comes from the FILTER, never from a sort.

    The service returns features OLDEST-first and `count` caps the result, so the
    naive request hands back data days old while the server holds detections
    minutes old. The obvious remedy, sortBy=time+D, is unusable: the server
    answers ANY sortBy on this layer with a bare java.lang.NullPointerException
    (HTTP 400, exceptionCode=NoApplicableCode). That was intermittent once and is
    now deterministic — measured 2026-08-04 at 5/5 failures, ~55 s apiece, which
    is how frp and the wind layer downstream of it went dark for days while three
    retries burned three minutes of every refresh.

    So constrain time instead of ordering it: ask only for the last few hours and
    the cap stops mattering, because the whole window fits under it. The bbox has
    to move into the same CQL filter — GeoServer rejects a `bbox` parameter and
    CQL_FILTER together with a 500 — and BBOX() takes lon/lat order, unlike the
    EPSG-urn bbox parameter this replaces.

    NOTE: do not send propertyName — restricting it makes GeoServer return
    features with a null geometry, which silently yields an empty heatmap.
    """
    lon_min, lat_min, lon_max, lat_max = bbox
    stamp = since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    cql = quote(
        f"time AFTER {stamp} AND BBOX(geom,{lon_min},{lat_min},{lon_max},{lat_max})"
    )
    return (
        f"{EUMETVIEW_WMS}?service=WFS&version=2.0.0&request=GetFeature"
        f"&typeNames={MTG_FRP_LAYER}&outputFormat=application/json&srsName=EPSG:4326"
        f"&count={count}&CQL_FILTER={cql}"
    )


def _retrying(
    http_text: Callable[[str], str],
    sleep: Callable[[float], None],
    attempts: int = FRP_ATTEMPTS,
) -> Callable[[str], str]:
    """Wrap a fetcher so a transient upstream fault costs a pause, not the layer.

    Re-raises the last error once the budget is spent — the carry-forward
    contract in attempt() depends on a real outage still surfacing.
    """

    def call(url: str) -> str:
        for i in range(attempts):
            try:
                return http_text(url)
            except Exception:  # noqa: BLE001 - any transport/server fault is worth one more try
                if i == attempts - 1:
                    raise
                sleep(FRP_BACKOFF_S * 2**i)
        raise AssertionError("unreachable")  # pragma: no cover

    return call


def fetch_frp_points(
    bbox: tuple[float, float, float, float],
    http_text: Callable[[str], str] | None = None,
    count: int = FRP_COUNT,
    min_confidence: int = 0,
    sleep: Callable[[float], None] | None = None,
    window_h: int = FRP_WINDOW_H,
    now: datetime | None = None,
) -> list[dict]:
    """Fetch individual MTG FRP pixels (MW) as points, for a weighted heatmap.

    The WMS renders these same values as fixed ~2 km squares; the vector form
    is what allows a continuous heatmap rendering client-side.
    """
    if http_text is None:
        import requests

        def http_text(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=FRP_TIMEOUT_S)
            r.raise_for_status()
            return r.text

    if sleep is None:  # pragma: no cover - real clock
        import time

        sleep = time.sleep

    import json as _json

    # Retried, then deliberately NOT swallowed. Returning [] on a transport
    # failure makes an outage indistinguishable from "no fires burning", and the
    # caller then publishes an empty layer over good data instead of carrying it
    # forward. The caller (pipeline.run.process) wraps this in attempt(), which
    # is where the degradation decision belongs — so a spent retry budget must
    # still raise.
    since = (now or datetime.now(timezone.utc)) - timedelta(hours=window_h)
    raw = _retrying(http_text, sleep)(_wfs_points_url(bbox, count, since))
    fc = _json.loads(raw)

    # numberMatched is what the filter found; len(features) is what fitted under
    # `count`. When they diverge the server has truncated from the OLD end, so
    # what we hold is a stale slice of the window — the precise failure the time
    # filter exists to prevent, just reached by a different route (an unusually
    # busy window rather than an unbounded query). Warn loudly: the layer still
    # publishes, but it is no longer the freshest data available.
    matched = fc.get("numberMatched")
    features = fc.get("features", [])
    if isinstance(matched, int) and matched > len(features):
        print(
            f"[warn] MTG FRP window truncated: {matched} matched, {len(features)} "
            f"returned (count={count}). Data is the OLDEST of the last {window_h}h; "
            f"raise FRP_COUNT or shorten FRP_WINDOW_H."
        )

    out: list[dict] = []
    for f in fc.get("features", []):
        geom, props = f.get("geometry") or {}, f.get("properties") or {}
        if geom.get("type") == "Point":
            lon, lat = geom["coordinates"][0], geom["coordinates"][1]
        elif props.get("Lon") is not None and props.get("Lat") is not None:
            lon, lat = props["Lon"], props["Lat"]  # geometry-less response
        else:
            continue
        frp = props.get("FRP")
        conf = props.get("Confidence")
        if frp is None or (conf is not None and conf < min_confidence):
            continue
        out.append(
            {
                "lon": round(float(lon), 4), "lat": round(float(lat), 4),
                "frp": round(float(frp), 1), "conf": conf, "time": props.get("time"),
            }
        )
    return out


def mtg_frp_extent(http_text: Callable[[str], str] | None = None) -> dict | None:
    """Return {'start','end','step'} of the live MTG FRP time dimension, or None."""
    if http_text is None:
        import requests

        def http_text(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=90)
            r.raise_for_status()
            return r.text

    try:
        caps = http_text(f"{EUMETVIEW_WMS}?service=WMS&request=GetCapabilities&version=1.3.0")
    except Exception:  # noqa: BLE001 - liveness discovery must never break refresh
        return None
    i = caps.find(f"<Name>{MTG_FRP_LAYER}</Name>")
    if i < 0:
        return None
    m = re.search(r"<Dimension name=[\"']time[\"'][^>]*>([^<]+)</Dimension>", caps[i : i + 6000])
    if not m:
        return None
    parts = m.group(1).strip().split("/")
    if len(parts) != 3:
        return None
    return {"start": parts[0], "end": parts[1], "step": parts[2]}


def fetch_meteosat(
    settings: Settings, fetch_pixels: Callable[[], list[dict]] | None = None
) -> int | None:
    if settings.eumetsat_key is None or settings.eumetsat_secret is None:
        return None
    if fetch_pixels is None:
        try:
            import eumdac  # noqa: F401
        except ImportError:
            return None

        def fetch_pixels() -> list[dict]:  # pragma: no cover - network
            return _real_fetch(settings)

    rows = []
    for p in fetch_pixels():
        rows.append(
            {
                "lat": p["lat"], "lon": p["lon"], "acq_time": p["acq_time"], "tier": "meteosat",
                "satellite": "MTG-I1", "confidence": "n", "frp": float(p.get("frp") or 0.0),
                "src_id": _src_id(p["lat"], p["lon"], p["acq_time"], "MTG-I1", "meteosat"),
            }
        )
    return append_hotspots(rows, settings.data_dir / "raw" / "hotspots.parquet")


def _real_fetch(settings: Settings) -> list[dict]:  # pragma: no cover - network
    raise NotImplementedError("implement against eumdac; see module docstring")


def liveness_for_events(
    events: dict[str, list[dict]], met_rows: list[dict]
) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for eid, members in events.items():
        cells = {m["cell"] for m in members}
        hits = []
        for r in met_rows:
            cell = h3.latlng_to_cell(r["lat"], r["lon"], H3_RES)
            if cells & set(h3.grid_disk(cell, 1)):
                hits.append(r)
        if hits:
            hits.sort(key=lambda r: r["acq_time"])
            out[eid] = {
                "latest": hits[-1]["acq_time"].isoformat(),
                "frp_series": [[r["acq_time"].isoformat(), r["frp"]] for r in hits],
            }
    return out
