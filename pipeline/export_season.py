"""Incremental export of the current year's archived fires into the
"Burned this year" overview layer files (web/src/layer_season.ts).

Two published files per year, both under archive/ (gen-pruning immune,
uploaded by remote.publish()'s archive/ walk, restored by name in
remote.hydrate()):

  season_{year}.json        boot-time summary: res-6 hex aggregates + totals
  season_{year}_cells.json  lazy: {fire_id: {digest, first, cells}}

plus season_state.json, the per-track bookkeeping that makes this run
incremental. Modelled on export_scale_blob.run_export — same digest-keyed
state, same time budget, same "write state last" recovery contract — but
with two additions the scale blob does not need:

* every contribution carries the `first` bin date it was built from, because
  `floor` is recomputed from the cells file each run and unchanged tracks
  are never re-read; and
* every contribution carries the source `digest`, because publish() uploads
  archive/ through an unordered pool: a new state can land while the updated
  cells file fails, and a missing-id check alone would then skip the stale
  contribution forever.

See docs/superpowers/specs/2026-09-18-season-burned-layer-design.md."""
from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable

import h3

from .config import (
    ARCHIVE_TRACKS_INDEX,
    SEASON_STATE_KEY,
    Settings,
    season_cells_key,
    season_key,
)
from .export_scale_blob import _load_json, _load_track_body, _save_json, year_of_track
from .geo_local import dedup_nested_cells

AGG_RES = 6
# Track bodies come from R2 one GET each; 8 concurrent fetches turn the
# 21k-track cold start from many refresh cycles into one or two. Bodies are
# pulled in batches so the time budget is checked between batches, not once.
FETCH_WORKERS = 8
FETCH_BATCH = 32
# Static-source diagnostic (spec: "measure, do not guess"): a real fire's
# series rarely spans more than a few weeks; a flare or refinery archived
# before the #121 filter shipped spans months on a handful of cells. This
# only LOGS the counts so the first prod runs give the number a gate would
# need — it does not gate anything.
LONG_SPAN_DAYS = 30


def first_bin_date(body: dict) -> str:
    series = body.get("series") or []
    if not series:
        raise ValueError(f"track {body.get('id')} has empty series, cannot read its first bin")
    return str(series[0]["bin"])[:10]


def _span_days(body: dict) -> int:
    series = body.get("series") or []
    if len(series) < 2:
        return 0
    first = datetime.fromisoformat(str(series[0]["bin"]).replace("Z", "+00:00"))
    last = datetime.fromisoformat(str(series[-1]["bin"]).replace("Z", "+00:00"))
    return (last - first).days


def aggregate_r6(cells_by_fire: dict[str, dict]) -> list[list]:
    """[[res-6 cell, km2], ...] sorted by cell: the real area of every
    (nested-deduped) burned cell, rolled up to its res-6 parent — ground
    burned once, however many fires touched it.

    The union is taken across fires BEFORE the roll-up: fires overlap (the
    same cell is claimed by up to 8 archived fires in the prod sample), and
    summing per fire published a km2 that over-counted by ~10 %."""
    seen: set[str] = set()
    for entry in cells_by_fire.values():
        seen.update(dedup_nested_cells(entry["cells"]))
    totals: dict[str, float] = {}
    for cell in seen:
        parent = h3.cell_to_parent(cell, AGG_RES) if h3.get_resolution(cell) > AGG_RES else cell
        totals[parent] = totals.get(parent, 0.0) + h3.cell_area(cell, unit="km^2")
    return [[cell, round(km2, 1)] for cell, km2 in sorted(totals.items())]


def summarize(year: int, cells_by_fire: dict[str, dict], now: datetime) -> dict:
    r6 = aggregate_r6(cells_by_fire)
    return {
        "year": year,
        "generated_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "floor": min((e["first"] for e in cells_by_fire.values()), default=None),
        "fires": len(cells_by_fire),
        "km2": round(sum(km2 for _, km2 in r6), 1),
        "r6": r6,
    }


def run_export_season(
    settings: Settings,
    target_year: int,
    client=None,
    r2_bucket: str | None = None,
    time_budget_s: float = 300.0,
    clock: Callable[[], float] = time.monotonic,
    now: datetime | None = None,
) -> None:
    """Bring season_{target_year}.json / _cells.json up to date with the
    track archive, within `time_budget_s`; whatever is not reached this run
    stays in `to_process` for the next one (see export_scale_blob.run_export
    for why a budget, not a hard kill, is the right shape here)."""
    index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
    if not index_path.exists():
        return
    now = now or datetime.now(timezone.utc)
    index: dict[str, str] = _load_json(index_path, {})
    state_path = settings.out_dir / SEASON_STATE_KEY
    cells_path = settings.out_dir / season_cells_key(target_year)
    summary_path = settings.out_dir / season_key(target_year)
    state: dict[str, dict] = _load_json(state_path, {})
    cells_by_fire: dict[str, dict] = _load_json(cells_path, {})

    # Self-heal a partial publish by reconciling what the state WANTS in the
    # cells file (year == target) against what is STORED there. An entry is
    # forgotten — which feeds it straight back into to_process below — when
    # the two disagree in either direction:
    #   wanted, not stored   → the contribution never landed;
    #   stored, not wanted   → the track was re-archived into another year
    #                          (or demoted to year=None) while its old
    #                          contribution survived in the cells file;
    #   both, digests differ → the contribution was built from another body.
    # Only checking `year == target_year` left the demotion case invisible:
    # nothing re-read the track, so the ghost stayed published forever.
    for tid, entry in list(state.items()):
        stored = cells_by_fire.get(tid)
        wanted = entry.get("year") == target_year
        if wanted != (stored is not None) or (stored is not None and stored.get("digest") != entry.get("digest")):
            del state[tid]
            cells_by_fire.pop(tid, None)

    to_process = [(tid, digest) for tid, digest in index.items() if state.get(tid, {}).get("digest") != digest]
    deadline = clock() + time_budget_s
    processed = long_span = long_span_small = malformed = 0

    def load(item: tuple[str, str]):
        tid, digest = item
        return tid, digest, _load_track_body(settings.out_dir, tid, client, r2_bucket)

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        for start in range(0, len(to_process), FETCH_BATCH):
            if clock() > deadline:
                break  # out of time — the rest stays in to_process for the next run
            for tid, digest, body in pool.map(load, to_process[start:start + FETCH_BATCH]):
                if body is None:
                    continue  # transient fetch failure — retried next run
                if not isinstance(body, dict):
                    # A JSON body that is not an object is malformed by shape,
                    # not by content — say so explicitly rather than leaning on
                    # whichever AttributeError it happens to raise downstream.
                    state[tid] = {"digest": digest, "year": None}
                    cells_by_fire.pop(tid, None)
                    malformed += 1
                    continue
                try:
                    year = year_of_track(body)
                    first = first_bin_date(body)
                    cells = body["cells"]
                    span = _span_days(body)
                except (ValueError, KeyError, TypeError):
                    # A body with no series or no cells can never contribute;
                    # record its digest so it is not re-fetched every run
                    # (a changed digest still brings it back), and move on
                    # rather than discarding the whole run's work. AttributeError
                    # is deliberately NOT caught: it means our code called a
                    # method that does not exist, and swallowing it would turn
                    # any such fault into a permanent, digest-recorded skip.
                    state[tid] = {"digest": digest, "year": None}
                    cells_by_fire.pop(tid, None)
                    malformed += 1
                    continue
                state[tid] = {"digest": digest, "year": year}
                cells_by_fire.pop(tid, None)  # drop a stale contribution if this id changed
                processed += 1
                if year != target_year:
                    continue
                cells_by_fire[tid] = {"digest": digest, "first": first, "cells": cells}
                if span > LONG_SPAN_DAYS:
                    long_span += 1
                    if len(body["cells"]) <= 10:
                        long_span_small += 1

    if processed or malformed:
        print(
            f"[season] processed={processed} long_span(>{LONG_SPAN_DAYS}d)={long_span} "
            f"of_which_<=10_cells={long_span_small} malformed={malformed}",
            file=sys.stderr,
        )
    _save_json(cells_path, cells_by_fire)  # contributions first...
    _save_json(summary_path, summarize(target_year, cells_by_fire, now))  # ...then the summary...
    _save_json(state_path, state)  # ...then commit state — the recovery contract
