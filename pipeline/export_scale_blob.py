"""Incremental export of the current year's archived-fire footprints into
one gap-free, position-independent hex blob for the web scale-comparison
layer. Each fire gets a hex count proportional to its real detected area,
packed into a shared spiral (pipeline/pack_blob.py) — the blob is a felt
sense of total scale, not a reconstruction of each fire's actual shape.

See docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md."""
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

import h3

from .config import (
    ARCHIVE_TRACKS_INDEX,
    SCALE_BLOB_STATE_KEY,
    Settings,
    scale_blob_fires_key,
    scale_blob_key,
)
from .enrich import Places, load_places, nearest_place
from .geo_local import centroid_of_cells
from .pack_blob import hex_count_for_area, pack_fires_as_blob


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


def _fires_summary_path(out_dir: Path, year: int) -> Path:
    return out_dir / scale_blob_fires_key(year)


def _load_places(settings: Settings) -> Places:
    """Same tolerant-of-absence pattern pipeline/run.py already uses: a
    missing or implausibly small gazetteer means every fire's country comes
    back None, not a crash — this is a display nicety, not something worth
    blocking the export over. Deliberately does not enforce MIN_PLACES as a
    hard failure: run.py needs that to catch a truncated real download loudly,
    but a small/fixture gazetteer here should just mean fewer matches, not an
    aborted export."""
    places_file = settings.data_dir / "places" / "cities5000.txt"
    if not places_file.exists():
        return Places([])
    try:
        return load_places(places_file, min_places=0)
    except ValueError:
        return Places([])


def _load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True))


def _true_area_km2(cells: list[str]) -> float:
    """Sum of each cell's real area, without double-counting.

    A track's cells can legitimately include both a coarse Meteosat cell and
    the several finer VIIRS cells nested inside it (design spec: "a coarse
    res-7 Meteosat cell spatially containing several res-8 VIIRS cells" is an
    expected occurrence, not a bug). The children exactly tile the parent, so
    summing every cell's area double-counts that ground. Drop any cell that
    is the H3 parent of another cell already in the set — its area is
    already accounted for by its children. (If only some of a parent's
    children are present, this slightly undercounts the parent's uncovered
    remainder — an acceptable trade against the double-counting this exists
    to fix.)"""
    cell_set = set(cells)
    kept = [
        c
        for c in cell_set
        if not any(
            h3.get_resolution(other) > h3.get_resolution(c) and h3.cell_to_parent(other, h3.get_resolution(c)) == c
            for other in cell_set
        )
    ]
    return round(sum(h3.cell_area(c, unit="km^2") for c in kept), 1)


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


def run_export(
    settings: Settings,
    target_year: int,
    client,
    r2_bucket: str | None = None,
    time_budget_s: float = 600.0,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """`time_budget_s` bounds this function's own wall-clock cost — the real
    ceiling is scripts/refresh_remote.py's 30-minute CI job timeout, which
    can hard-kill the whole process (not just this function) before
    anything gets written at all: a cold start against a large real archive
    (19,347 tracks in prod as of the first production run) fetches every
    body serially and cannot finish within that budget. Rather than block
    the entire refresh cycle indefinitely — repeating the same failed
    cold-start every run, forever — this stops processing new tracks once
    the budget is spent and writes whatever it *did* finish. Unprocessed
    tracks simply never entered `state`, so the next run's `to_process` diff
    picks them up automatically; no separate resumption bookkeeping needed."""
    index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
    if not index_path.exists():
        return  # nothing archived yet

    index: dict[str, str] = json.loads(index_path.read_text())
    state: dict[str, dict] = _load_json(_state_path(settings.out_dir), {})
    blob: list[dict] = _load_json(_blob_path(settings.out_dir, target_year), [])
    fires_summary: dict[str, dict] = _load_json(_fires_summary_path(settings.out_dir, target_year), {})

    blob_by_fire: dict[str, list[dict]] = {}
    for cell in blob:
        blob_by_fire.setdefault(cell["fire_id"], []).append(cell)

    # Self-heal a partial PUBLISH, which the local write ordering below cannot
    # cover. Locally the blob is written before the state, so a crash between
    # the two leaves a state that under-claims — safe, and the next run just
    # redoes the work. The R2 boundary has no such ordering: publish() uploads
    # everything under archive/ through an unordered ThreadPoolExecutor, so a
    # publish that dies partway can land scale_blob_state.json in the bucket
    # while blob_{year}.json (or blob_{year}_fires.json) never makes it. The
    # next hydrate() then restores a state claiming tracks are processed whose
    # geometry (or country/area summary) is nowhere to be found, and because
    # ONLY a digest change ever puts a track back into `to_process`, that fire
    # would be missing permanently. So: any state entry for THIS year missing
    # EITHER its cells or its summary is forgotten, which feeds it straight
    # back into `to_process` below. Other years are left alone — their absence
    # from this year's blob is the normal case, and dropping them would mean
    # re-fetching every past year's track body on every run.
    for track_id in [
        tid
        for tid, entry in state.items()
        if entry.get("year") == target_year and (tid not in blob_by_fire or tid not in fires_summary)
    ]:
        del state[track_id]
        blob_by_fire.pop(track_id, None)
        fires_summary.pop(track_id, None)

    to_process = {tid: digest for tid, digest in index.items() if state.get(tid, {}).get("digest") != digest}

    new_fire_hex_counts: dict[str, int] = {}
    places: Places | None = None
    deadline = clock() + time_budget_s

    for track_id, digest in to_process.items():
        if clock() > deadline:
            break  # out of time this cycle — remaining tracks stay in to_process, retried next run
        body = _load_track_body(settings.out_dir, track_id, client, r2_bucket)
        if body is None:
            continue  # transient fetch failure — stays unprocessed, retried next run

        year = year_of_track(body)
        state[track_id] = {"digest": digest, "year": year}
        blob_by_fire.pop(track_id, None)  # drop stale entries if this id's year changed
        fires_summary.pop(track_id, None)

        if year != target_year:
            continue

        cells = body["cells"]
        origin_lat, origin_lon = centroid_of_cells(cells)
        area_km2 = _true_area_km2(cells)

        if places is None:  # lazy, once per run, only if there's actually work to do
            places = _load_places(settings)
        place = nearest_place(origin_lat, origin_lon, places)
        fires_summary[track_id] = {
            "country": place["country"] if place else None,
            "area_km2": area_km2,
        }
        # The blob shows total scale, not each fire's real detected shape —
        # a fixed-size hex count proportional to real area, packed into one
        # gap-free spiral (pack_blob.py), not the fire's actual footprint.
        new_fire_hex_counts[track_id] = hex_count_for_area(area_km2)

    if new_fire_hex_counts:
        # New hexes start right after the highest spiral position any
        # currently-published cell actually occupies — NOT a sum of
        # currently-tracked fires' hex counts. A reprocessed fire (digest
        # changed) is popped from blob_by_fire above, so if it wasn't the
        # last fire ever packed, summing what's left undercounts: a fire
        # packed after it is still sitting at its own (higher) positions,
        # untouched, and a sum-based start_index would silently reuse them.
        # The per-cell "index" is what makes the true high-water mark
        # derivable regardless of which fires this run did or didn't touch.
        start_index = 1 + max(
            (cell["index"] for cells in blob_by_fire.values() for cell in cells),
            default=-1,
        )
        packed = pack_fires_as_blob(new_fire_hex_counts, start_index=start_index)
        for fire_id, polys in packed.items():
            blob_by_fire[fire_id] = [
                # cell_id/res no longer name a real H3 cell (there is no
                # real cell here) — kept only because the web layer's schema
                # expects them, `res` fixed at 8 as a harmless placeholder.
                {"fire_id": fire_id, "cell_id": f"{fire_id}-{i}", "res": 8, "vertices_m": poly,
                 "index": start_index + i}
                for i, poly in enumerate(polys)
            ]

    new_blob = [cell for cells in blob_by_fire.values() for cell in cells]
    _save_json(_blob_path(settings.out_dir, target_year), new_blob)  # write blob first
    _save_json(_fires_summary_path(settings.out_dir, target_year), fires_summary)  # ...then the summary...
    _save_json(_state_path(settings.out_dir), state)  # ...then commit state — the recovery contract
