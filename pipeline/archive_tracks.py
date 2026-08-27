"""Permanent per-fire track archive for past-scar H3 detail.

A "past" scar (build_scars(), fetch_imagery.py) is clustered over a much
longer window (SCAR_WINDOW_DAYS, 45 days) than the live track pipeline keeps
around (export.py's `reachable`, bounded by GENERATIONS_KEPT generations —
which publish every ~15 min, so that window is hours, not days). By the time
a fire is quiet enough to become a past scar, its live track has usually
already rolled off. This module writes a small, permanent, id-keyed copy the
moment that happens, so a past-scar card can still load the same
`{series, cells, cell_bins, frp_live}` shape an active fire's card loads —
see web/src/data.ts's loadTrack and firecard.ts's openScar.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from .config import ARCHIVE_TRACKS_INDEX
from .export import _cell_bins
from .fetch_imagery import ACTIVE_MAX_H, MIN_MEMBERS, quiet_hours
from .metrics import bins_series


def previous_archive_index(out_dir: Path) -> dict[str, str]:
    """{id: sha256 of its archived track body}, or {} on a cold start (no
    local file yet — hydrate() populates it from R2 before this is called),
    or on any unexpected shape (truncated upload, a future format change) —
    this must never raise, since run.py's caller relies on it as a fallback
    default for a failed archive_past_tracks() run."""
    path = out_dir / ARCHIVE_TRACKS_INDEX
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_bytes())
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, str)}


def _archive_body(eid: str, members: list[dict]) -> str:
    """Same shape as a live track file (export.py's per-event body), so the
    frontend loads either one identically. frp_live is always empty: a
    settled scar is not live, so there is no MTG liveness series to carry."""
    return json.dumps({
        "id": eid,
        "series": bins_series(members),
        "cells": sorted({m["cell"] for m in members}),
        "cell_bins": _cell_bins(members),
        "frp_live": [],
    })


def archive_past_tracks(
    out_dir: Path, scar_events: dict, now: datetime, prev_index: dict[str, str],
) -> dict[str, str]:
    """Write/refresh the permanent per-fire track for every fire in
    `scar_events` quiet enough to be a past scar, skipping any whose content
    hasn't changed since it was last archived. A genuinely closed fire's
    cells never change again, so after the first write this is a no-op for
    that id on every later run — cost is bounded by new closures per run, not
    by how many past fires have accumulated. Returns the full updated index
    (unchanged entries carried over as-is, untouched on disk).
    """
    index = dict(prev_index)
    tracks_dir = out_dir / "archive" / "tracks"
    for eid, members in scar_events.items():
        if len(members) < MIN_MEMBERS:
            continue  # speck — never becomes a visible scar, not worth a permanent file
        if quiet_hours(members, now) <= ACTIVE_MAX_H:
            continue  # still active — has a live track already, not ours to keep
        body = _archive_body(eid, members)
        digest = hashlib.sha256(body.encode()).hexdigest()
        if index.get(eid) == digest:
            continue  # unchanged since last archived
        tracks_dir.mkdir(parents=True, exist_ok=True)
        (tracks_dir / f"{eid}.json").write_text(body)
        index[eid] = digest
    index_path = out_dir / ARCHIVE_TRACKS_INDEX
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index))
    return index
