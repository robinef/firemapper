"""Incremental export of the current year's archived-fire footprints into
one packed, position-independent blob for the web scale-comparison layer.

See docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md."""
import json
from datetime import datetime
from pathlib import Path

import h3

from .config import ARCHIVE_TRACKS_INDEX, SCALE_BLOB_STATE_KEY, Settings, scale_blob_key
from .geo_local import cell_boundary_local_m, centroid_of_cells
from .pack_blob import bounding_box, pack_fires


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def year_of_track(body: dict) -> int:
    series = body.get("series") or []
    if not series:
        raise ValueError(f"track {body.get('id')} has empty series, cannot attribute a year")
    return _parse_iso(series[-1]["bin"]).year


def _state_path(out_dir: Path) -> Path:
    return out_dir / SCALE_BLOB_STATE_KEY


def _blob_path(out_dir: Path, year: int) -> Path:
    return out_dir / scale_blob_key(year)


def _load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True))


def _load_track_body(out_dir: Path, track_id: str, client, r2_bucket: str | None) -> dict | None:
    local_path = out_dir / "archive" / "tracks" / f"{track_id}.json"
    if local_path.exists():
        return json.loads(local_path.read_text())
    if client is None or r2_bucket is None:
        return None
    from .remote import (  # local import: avoids a hard dependency on boto3 for pure-local runs
        DATA_PREFIX,
        _get,
    )

    body = _get(client, r2_bucket, f"{DATA_PREFIX}archive/tracks/{track_id}.json")
    return json.loads(body) if body is not None else None


def run_export(settings: Settings, target_year: int, client, r2_bucket: str | None = None) -> None:
    index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
    if not index_path.exists():
        return  # nothing archived yet

    index: dict[str, str] = json.loads(index_path.read_text())
    state: dict[str, dict] = _load_json(_state_path(settings.out_dir), {})
    blob: list[dict] = _load_json(_blob_path(settings.out_dir, target_year), [])

    blob_by_fire: dict[str, list[dict]] = {}
    for cell in blob:
        blob_by_fire.setdefault(cell["fire_id"], []).append(cell)

    # Self-heal a partial PUBLISH, which the local write ordering below cannot
    # cover. Locally the blob is written before the state, so a crash between
    # the two leaves a state that under-claims — safe, and the next run just
    # redoes the work. The R2 boundary has no such ordering: publish() uploads
    # everything under archive/ through an unordered ThreadPoolExecutor, so a
    # publish that dies partway can land scale_blob_state.json in the bucket
    # while blob_{year}.json never makes it. The next hydrate() then restores a
    # state claiming tracks are processed whose geometry is nowhere in the blob,
    # and because ONLY a digest change ever puts a track back into `to_process`,
    # those fires would be missing from the blob permanently. So: any state entry
    # for THIS year with no cells in the blob we just loaded is forgotten, which
    # feeds it straight back into `to_process` below. Other years are left alone
    # — their absence from this year's blob is the normal case, and dropping them
    # would mean re-fetching every past year's track bodies on every run.
    for track_id in [
        tid
        for tid, entry in state.items()
        if entry.get("year") == target_year and tid not in blob_by_fire
    ]:
        del state[track_id]

    to_process = {tid: digest for tid, digest in index.items() if state.get(tid, {}).get("digest") != digest}

    new_fire_polys: dict[str, list[list[tuple[float, float]]]] = {}
    new_fire_cells: dict[str, list[str]] = {}

    for track_id, digest in to_process.items():
        body = _load_track_body(settings.out_dir, track_id, client, r2_bucket)
        if body is None:
            continue  # transient fetch failure — stays unprocessed, retried next run

        year = year_of_track(body)
        state[track_id] = {"digest": digest, "year": year}
        blob_by_fire.pop(track_id, None)  # drop stale entries if this id's year changed

        if year != target_year:
            continue

        cells = body["cells"]
        origin_lat, origin_lon = centroid_of_cells(cells)
        new_fire_polys[track_id] = [cell_boundary_local_m(c, origin_lat, origin_lon) for c in cells]
        new_fire_cells[track_id] = cells

    if new_fire_polys:
        existing_boxes = [bounding_box([c["vertices_m"] for c in cells]) for cells in blob_by_fire.values()]
        packed = pack_fires(new_fire_polys, existing_boxes=existing_boxes)
        for fire_id, polys in packed.items():
            cell_ids = new_fire_cells[fire_id]
            blob_by_fire[fire_id] = [
                {"fire_id": fire_id, "cell_id": cid, "res": h3.get_resolution(cid), "vertices_m": poly}
                for cid, poly in zip(cell_ids, polys)
            ]

    new_blob = [cell for cells in blob_by_fire.values() for cell in cells]
    _save_json(_blob_path(settings.out_dir, target_year), new_blob)  # write blob first
    _save_json(_state_path(settings.out_dir), state)  # ...then commit state — the recovery contract
