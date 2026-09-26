"""Incremental export of the current year's per-fire summary — each archived
fire's country and true detected area — for the web scale-comparison blob.

The web draws the blob itself from this summary (web/src/scale_blob_shape.ts
packs one hex per 0.7 km² onto a spiral, one band per EU-27 country). This
module used to pack the hexes here and publish every one as a polygon,
archive/blob_{year}.json: 57 MB for 2026, re-downloaded by every refresh's
hydrate and no longer read by the site.

The same summary also gives the season layer its EU-27 scope
(pipeline/export_season.py).

See docs/superpowers/specs/2026-09-09-fire-scale-blob-design.md."""
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from .config import (
    ARCHIVE_TRACKS_INDEX,
    SCALE_BLOB_STATE_KEY,
    Settings,
    scale_blob_fires_key,
)
from .enrich import Places, load_places_tolerant, nearest_place
from .geo_local import centroid_of_cells, true_area_km2


def _parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def year_of_track(body: dict) -> int:
    series = body.get("series") or []
    if not series:
        raise ValueError(f"track {body.get('id')} has empty series, cannot attribute a year")
    return _parse_iso(series[-1]["bin"]).year


def _state_path(out_dir: Path) -> Path:
    return out_dir / SCALE_BLOB_STATE_KEY


def _fires_summary_path(out_dir: Path, year: int) -> Path:
    return out_dir / scale_blob_fires_key(year)


def _load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True))


def _true_area_km2(cells: list[str]) -> float:
    """Sum of each cell's real area, without double-counting — see
    geo_local.true_area_km2, shared with export_season.py."""
    return true_area_km2(cells)


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
    fires_summary: dict[str, dict] = _load_json(_fires_summary_path(settings.out_dir, target_year), {})

    # Self-heal a partial PUBLISH, which the local write ordering below cannot
    # cover. Locally the summary is written before the state, so a crash between
    # the two leaves a state that under-claims — safe, and the next run just
    # redoes the work. The R2 boundary has no such ordering: publish() uploads
    # everything under archive/ through an unordered ThreadPoolExecutor, so a
    # publish that dies partway can land scale_blob_state.json in the bucket
    # while blob_{year}_fires.json never makes it. The next hydrate() then
    # restores a state claiming tracks are processed whose summary is nowhere
    # to be found, and because ONLY a digest change ever puts a track back into
    # `to_process`, that fire would be missing permanently. So: any state entry
    # for THIS year missing its summary is forgotten, which feeds it straight
    # back into `to_process` below. Other years are left alone — their absence
    # from this year's summary is the normal case, and dropping them would mean
    # re-fetching every past year's track body on every run.
    for track_id in [
        tid for tid, entry in state.items() if entry.get("year") == target_year and tid not in fires_summary
    ]:
        del state[track_id]
    # ...and the other direction: a fire in THIS year's summary that the state
    # now files under another year. Another year's pass (the fast tier's, in
    # January) re-read it after its last bin moved into the new year, and
    # dropped it only from ITS summary — this one would keep it forever, and the
    # fire would be counted in both years. The state is authoritative.
    for track_id in [
        tid for tid in fires_summary if tid in state and state[tid].get("year") != target_year
    ]:
        del fires_summary[track_id]

    to_process = {tid: digest for tid, digest in index.items() if state.get(tid, {}).get("digest") != digest}

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
        fires_summary.pop(track_id, None)  # drop a stale entry if this id's year changed

        if year != target_year:
            continue

        cells = body["cells"]
        origin_lat, origin_lon = centroid_of_cells(cells)

        if places is None:  # lazy, once per run, only if there's actually work to do
            places = load_places_tolerant(settings)
        place = nearest_place(origin_lat, origin_lon, places)
        fires_summary[track_id] = {
            "country": place["country"] if place else None,
            "area_km2": _true_area_km2(cells),
        }

    _save_json(_fires_summary_path(settings.out_dir, target_year), fires_summary)  # write the summary first...
    _save_json(_state_path(settings.out_dir), state)  # ...then commit state — the recovery contract
