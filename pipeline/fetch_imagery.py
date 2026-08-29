"""Before/after true-colour imagery of a burn SCAR — green forest before, black
after. NOT live fire: satellite optical revisit is days, and clouds stretch the
effective gap to weeks, so this is days-behind by nature and the UI states the
two capture dates plainly.

Two source tiers, mirroring the FRP/VIIRS pattern:

  DEFAULT (keyless): NASA GIBS MODIS/VIIRS Corrected-Reflectance true colour.
    Global, date-specific (any day, years back — so historical fires work), no
    account. Coarse (~250 m), so a small scar is a few pixels, but it always
    works and is honest for regional scars.

  HD (optional, gated): Copernicus Data Space Sentinel-2 at 10 m via a
    configured OGC instance. Needs SENTINELHUB_CLIENT_ID/_SECRET (catalog OAuth)
    and SENTINELHUB_INSTANCE_ID. Absent → we simply stay on GIBS.

A "scar" is one fire the user can compare: it carries a label, a map location,
and the two dates. Scars come from OUR OWN fire detections (FIRMS/VIIRS/MTG),
split by lifecycle: fires still detecting are "active"; fires that have gone
quiet (>ACTIVE_MAX_H since the last detection) are "past" — last month's fires,
sourced from the same sensors as the live map, with no external burned-area
service.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .events import cell_km2_for
from .metrics import area_km2

# GIBS true-colour layers (keyless). MODIS Terra is the daily default; VIIRS is
# an alternative. Corrected-reflectance = natural colour.
GIBS_LAYER = "MODIS_Terra_CorrectedReflectance_TrueColor"
BASELINE_LEAD_DAYS = 6  # "before" image this many days pre-fire (pre-scar)
SCAR_SETTLE_DAYS = 14   # for a past fire, "after" this long post-ignition
MIN_MEMBERS = 4         # ignore specks — a scar worth comparing has a few cells
MAX_SCARS = 25          # a pickable shortlist per section (active / past)
ACTIVE_MAX_H = 48       # a fire quiet longer than this counts as a past scar

WMS_BASE = "https://sh.dataspace.copernicus.eu/ogc/wms"
TRUE_COLOR_LAYER = "TRUE_COLOR"

# Curated real European megafire scars, always available so the before/after
# mode has a striking green→black example even with no live past fires (and even
# keyless — GIBS carries these historical dates too, just coarser). The list
# lives in notable_scars.json (data, not code) so it can be edited without
# touching the pipeline. Each entry carries the WINDOW-END capture days:
# `before` sits just pre-ignition (still green), `after` on the settled black
# scar. Verified against CDSE Sentinel-2.
_NOTABLE_SCARS_FILE = Path(__file__).parent / "notable_scars.json"


def notable_scars() -> list[dict]:
    """The curated real megafire scars, shaped like build_scars() output.

    Loaded from notable_scars.json next to this module. Fully guarded: a missing
    or unparseable file yields [] rather than raising, so a bad edit can never
    take the whole imagery manifest down."""
    try:
        raw = json.loads(_NOTABLE_SCARS_FILE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - missing/invalid file → no curated scars
        return []
    if not isinstance(raw, list):
        return []
    return [
        {**s, "kind": "past", "started": s["before"]}
        for s in raw
    ]


def _iso(d: date) -> str:
    return d.isoformat()


def _scar_dates(fire_start: date, now: date, past: bool) -> tuple[str, str]:
    """(before, after) capture dates. Before = pre-fire baseline; after = the
    settled scar for a past fire, else the latest usable day (yesterday)."""
    yesterday = now - timedelta(days=1)
    before = fire_start - timedelta(days=BASELINE_LEAD_DAYS)
    if past:
        after = min(fire_start + timedelta(days=SCAR_SETTLE_DAYS), yesterday)
    else:
        after = yesterday
    return _iso(before), _iso(max(after, fire_start))


def _label_for(place: str | None, start: date, past: bool) -> str:
    """A human scar label: place + date, e.g. "Saumos · 24 Jul 2026". Falls back
    to a compass-free generic only when no nearby place is known."""
    when = f"{start.day} {start:%b %Y}"
    if place:
        return f"{place} · {when}"
    return f"{'Burn scar' if past else 'Active fire'} · {when}"


def _scar_from_fire(eid: str, members: list, today: date, past: bool,
                    places: list | None = None, track_gen: str | None = None) -> dict:
    from .enrich import nearest_place

    lons = [m["lon"] for m in members]
    lats = [m["lat"] for m in members]
    lat = sum(lats) / len(lats)
    lon = sum(lons) / len(lons)
    start = min(m["acq_time"] for m in members).date()
    before, after = _scar_dates(start, today, past=past)
    # A stored place name wins; otherwise reverse-geocode the centroid.
    name = members[0].get("name")
    if not name and places:
        p = nearest_place(lat, lon, places)
        name = p["name"] if p else None
    # Same sensor-aware cell size the live fire card uses (events.py).
    cell_km2 = cell_km2_for(members)
    cum_cells = len({m["cell"] for m in members})
    return {
        "id": eid,
        "label": _label_for(name, start, past),
        "place": name,
        "kind": "past" if past else "active",
        "lon": round(lon, 4),
        "lat": round(lat, 4),
        "cells": len(members),
        "area_km2": area_km2(members, cell_km2),
        "cum_cells": cum_cells,
        "started": start.isoformat(),
        "before": before,
        "after": after,
        "track_gen": track_gen,
    }


def quiet_hours(members: list, now: datetime) -> float:
    """Hours since a fire's last detection — the one definition of "quiet"
    build_scars and archive_tracks.py both key their active/past split on.
    Kept in one place so a scar's `kind` and whether it ever gets archived
    cannot silently disagree after a future change to the threshold logic."""
    return (now - max(m["acq_time"] for m in members)).total_seconds() / 3600


def build_scars(
    events: dict, now: datetime, places: list | None = None,
    archived_ids: set[str] | None = None,
) -> list[dict]:
    """Compare-able burn scars from our own fire detections, split by lifecycle.

    A fire whose latest detection is within ACTIVE_MAX_H is "active"; one quiet
    longer than that is "past" (last month's fires). Specks below MIN_MEMBERS
    are dropped, each section is capped at MAX_SCARS, and the two sections are
    ranked differently on purpose — see the sort below. Tiles are the keyless
    GIBS true-colour layer client-side, so no per-scar fetch here.

    `archived_ids` names past fires that already have a permanent per-fire
    track (see archive_tracks.py) — those get `track_gen: "archive"` so the
    frontend's openScar can load the same H3 arrival-footprint detail an
    active fire's card shows. Only ever applied to PAST-kind entries: an
    active fire already has a live track through the ordinary export path,
    and an id collision must never hand it a stale archive pointer instead.
    """
    today = now.date()
    active: list[dict] = []
    past: list[dict] = []
    for eid, members in events.items():
        if len(members) < MIN_MEMBERS:
            continue  # speck
        is_past = quiet_hours(members, now) > ACTIVE_MAX_H
        track_gen = "archive" if is_past and eid in (archived_ids or ()) else None
        (past if is_past else active).append(
            _scar_from_fire(eid, members, today, is_past, places, track_gen)
        )

    # Active fires are ranked by recency: they are still burning, so "what is
    # happening now" is the question. PAST scars are ranked by SIZE, because the
    # question there is "which burns are worth comparing" — and because a cap
    # filled by recency quietly deletes the only route to a notable fire's card
    # as soon as a couple of quiet days produce enough small ones.
    active.sort(key=lambda s: s["started"], reverse=True)
    past.sort(key=lambda s: (s["cells"], s["started"]), reverse=True)
    return active[:MAX_SCARS] + past[:MAX_SCARS]


# The browser asks the Worker for HD tiles, never Sentinel Hub directly. The
# instance id is the bearer token for a whole OGC configuration — GetCapabilities
# enumerates its layers, WCS returns raw raster, FIS returns statistics — so
# publishing it in the manifest would hand that access to every visitor, billed
# to the account. docs/DEPLOYMENT.md has always said never to expose it to a
# public deploy; this is how the HD tier ships without doing so. The pipeline
# therefore needs no Sentinel Hub credential at all: it only names the route.
HD_PROXY_PATH = "/hd"


def hd_config(settings) -> dict | None:
    """Sentinel-2 10 m HD source via the Worker proxy, or None when off.

    Gated on SENTINELHUB_PROXY, a plain flag rather than a secret. The layer
    name defaults to TRUE_COLOR — the true-colour layer of the "Simple
    Sentinel-2 L2A template" configuration that .env.example documents. Note
    that the older TRUE-COLOR-S2L2A default was simply wrong for that template
    and returned HTTP 400 on every tile, which MapLibre swallows silently (it
    drops a failed raster tile WITHOUT firing `error`), leaving a blank half.
    Per-scar dates stay GIBS-driven; HD only swaps the tile source.
    """
    if not getattr(settings, "sh_proxy", False):
        return None
    layer = getattr(settings, "sh_layer", None) or TRUE_COLOR_LAYER
    return {"wms_base": HD_PROXY_PATH, "layer": layer}


def _dedup_scars(scars: list[dict]) -> list[dict]:
    """Drop scars sharing a rounded lon/lat with an earlier one, so a best-effort
    external source (EFFIS) does not duplicate a scar we already derived from our
    own FIRMS detections. First occurrence wins (our own scars come first)."""
    seen: set[tuple[float, float]] = set()
    out: list[dict] = []
    for s in scars:
        key = (round(s["lon"], 2), round(s["lat"], 2))
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def build_imagery(
    settings, events: dict, now: datetime, places: list | None = None,
    extra_scars: list[dict] | None = None, archived_ids: set[str] | None = None,
) -> dict | None:
    """Imagery config for the manifest: keyless GIBS layer + per-scar dates,
    with an optional CDSE HD source. Live scars from our detections are joined
    with the curated real megafires (and any best-effort external burned-area
    scars in `extra_scars`, e.g. EFFIS), so the before/after mode always has a
    green→black example to show. `places` labels real scars with their nearest
    town. `archived_ids` is forwarded to build_scars — see its docstring."""
    scars = (
        build_scars(events, now, places, archived_ids)
        + notable_scars() + (extra_scars or [])
    )
    scars = _dedup_scars(scars)
    if not scars:
        return None
    return {"source": "gibs", "gibs_layer": GIBS_LAYER, "hd": hd_config(settings), "scars": scars}
