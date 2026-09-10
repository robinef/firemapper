"""Incremental export of the current year's archived-fire footprints into
one gap-free, position-independent hex blob for the web scale-comparison
layer. Each fire gets a hex count proportional to its real detected area,
packed into a shared spiral (pipeline/pack_blob.py) — the blob is a felt
sense of total scale, not a reconstruction of each fire's actual shape.

See docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md."""
import json
from datetime import datetime
from pathlib import Path

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

    for track_id, digest in to_process.items():
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
        area_km2 = round(sum(h3.cell_area(c, unit="km^2") for c in cells), 1)

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
        # New hexes start right after every already-published one — a spiral
        # fill can't skip or collide, so this is the only bookkeeping needed
        # to keep placing previously-packed fires exactly where they are.
        start_index = sum(len(cells) for cells in blob_by_fire.values())
        packed = pack_fires_as_blob(new_fire_hex_counts, start_index=start_index)
        for fire_id, polys in packed.items():
            blob_by_fire[fire_id] = [
                # cell_id/res no longer name a real H3 cell (there is no
                # real cell here) — kept only because the web layer's schema
                # expects them, `res` fixed at 8 as a harmless placeholder.
                {"fire_id": fire_id, "cell_id": f"{fire_id}-{i}", "res": 8, "vertices_m": poly}
                for i, poly in enumerate(polys)
            ]

    new_blob = [cell for cells in blob_by_fire.values() for cell in cells]
    _save_json(_blob_path(settings.out_dir, target_year), new_blob)  # write blob first
    _save_json(_fires_summary_path(settings.out_dir, target_year), fires_summary)  # ...then the summary...
    _save_json(_state_path(settings.out_dir), state)  # ...then commit state — the recovery contract
