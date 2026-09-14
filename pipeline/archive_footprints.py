"""Permanent per-scar footprint archive for EFFIS burned-area polygons.

fetch_effis.py's fetch_effis_ba() reads a real burned-area polygon out of the
EFFIS snapshot but (until now) only kept its centroid — an EFFIS-sourced past
scar had no track_gen/cell_bins, so its card rendered no footprint on the map
at all. This writes the polygon itself to a small, permanent, id-keyed file
the moment it is seen, exactly the way archive_tracks.py does for FIRMS scar
tracks: web/src/firecard.ts's openScar loads it lazily when that scar's card
opens.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .config import ARCHIVE_FOOTPRINTS_INDEX


def previous_footprints_index(out_dir: Path) -> dict[str, str]:
    """{id: sha256 of its archived footprint body}, or {} on a cold start, or
    on any unexpected shape — this must never raise (see
    archive_tracks.previous_archive_index, same contract)."""
    path = out_dir / ARCHIVE_FOOTPRINTS_INDEX
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_bytes())
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, str)}


def _is_safe_id(sid: str) -> bool:
    """A scar id must be a bare filename component — no path separators, no
    `.`/`..` — before it is trusted to build a path under footprints_dir.
    EFFIS is an external, third-party feed: fetch_effis_season.py's
    _rows_from_records relays its `id` field verbatim (only checks it is
    non-empty), so a malformed or malicious id must never be allowed to
    address a file outside the archive directory. `Path(sid).name` strips
    any leading path (so `/etc/passwd` -> `passwd`, `../../x` -> `x`) and
    collapses `.`/`..`/"" to something that can never equal the input."""
    return bool(sid) and Path(sid).name == sid


def archive_effis_footprints(
    out_dir: Path, scars: list[dict], prev_index: dict[str, str],
) -> dict[str, str]:
    """Write/refresh the permanent footprint file for every scar carrying a
    `geometry` (a GeoJSON Polygon/MultiPolygon dict), skipping any whose
    content hasn't changed since it was last archived. A settled EFFIS scar's
    perimeter never changes, so after the first write this is a no-op for
    that id on every later run. Returns the full updated index (unchanged
    entries carried over as-is, untouched on disk).
    """
    index = dict(prev_index)
    footprints_dir = out_dir / "archive" / "footprints"
    for scar in scars:
        geometry = scar.get("geometry")
        if not geometry:
            continue
        sid = str(scar["id"])
        if not _is_safe_id(sid):
            continue
        body = json.dumps({"type": "Feature", "geometry": geometry, "properties": {"id": sid}})
        digest = hashlib.sha256(body.encode()).hexdigest()
        if index.get(sid) == digest:
            continue
        footprints_dir.mkdir(parents=True, exist_ok=True)
        (footprints_dir / f"{sid}.json").write_text(body)
        index[sid] = digest
    index_path = out_dir / ARCHIVE_FOOTPRINTS_INDEX
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index))
    return index


def stamp_footprint_flags(scars: list[dict], index: dict[str, str]) -> None:
    """Mutates each scar in place: drops the transient `geometry` key (never
    published — the polygon lives only in the permanent archive file) and, for
    any scar whose id made it into `index`, sets `footprint: True` — the flag
    web/src/firecard.ts's openScar reads to decide whether to fetch it."""
    for scar in scars:
        had_geometry = scar.pop("geometry", None) is not None
        if had_geometry and str(scar["id"]) in index:
            scar["footprint"] = True
