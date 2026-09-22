"""Incremental export of the current year's archived fires into the
"Burned this year" overview layer files (web/src/layer_season.ts).

Three published files per year, all under archive/ (gen-pruning immune,
uploaded by remote.publish()'s archive/ walk, restored by name in
remote.hydrate()):

  season_{year}.json        boot-time summary: res-6 hex aggregates + totals
  season_{year}_sizes.json  boot-time: {year, fires: {fire_id: [km2, country, first]}},
                            the size filter's input (histogram, EU-27 scope)
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
    SEASON_STATIC_MAX_CELLS,
    SEASON_STATIC_SPAN_DAYS,
    Settings,
    scale_blob_fires_key,
    season_cells_key,
    season_key,
    season_sizes_key,
)
from .events import static_classification
from .export_scale_blob import _load_json, _load_track_body, _save_json, year_of_track
from .geo_local import dedup_nested_cells
from .store import read_hotspots

AGG_RES = 6
# Track bodies come from R2 one GET each; 8 concurrent fetches turn the
# 21k-track cold start from many refresh cycles into one or two. Bodies are
# pulled in batches so the time budget is checked between batches, not once.
FETCH_WORKERS = 8
FETCH_BATCH = 32
# Static-source diagnostic (spec: "measure, do not guess"): a real fire's
# series rarely spans more than a few weeks; a flare or refinery archived
# before the #121 filter shipped spans months on a handful of cells. These
# counters LOG the population; the gate itself is is_static_track below,
# with its measured thresholds in config.py.
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


def is_static_track(span_days: int, cells: list[str]) -> bool:
    """A fixed heat source archived as a "fire": detected for longer than any
    real fire in the archive, on a handful of cells. Both conditions, because
    each alone catches real fires — see SEASON_STATIC_* in config.py."""
    return span_days > SEASON_STATIC_SPAN_DAYS and len(set(cells)) <= SEASON_STATIC_MAX_CELLS


def season_static_zone(settings: Settings, year: int) -> set[str] | None:
    """The static heat-source zone over `year`'s raw detections — the live
    map's own rule (events.static_classification: cells detected on >=
    STATIC_CELL_DAYS distinct days, plus their STATIC_RING_K ring), applied to
    the whole season rather than cluster()'s window.

    From the raw store, not the archived tracks: a track's cell_bins records
    each cell once, on its first bin, so the bodies cannot tell a plant lit
    on 30 days from a cell burned once (measured 2026-09-22: no archived
    cell reaches 5 days). None when the store is absent or empty — the export
    then keeps whatever filtering it last applied (see apply_static_zone)."""
    store = settings.data_dir / "raw" / "hotspots.parquet"
    rows = [r for r in read_hotspots(store) if r["acq_time"].year == year]
    if not rows:
        print(f"[season] no raw hotspot store rows for {year} at {store}; static zone unknown this run", file=sys.stderr)
        return None
    return static_classification(rows)[1]


def apply_static_zone(
    target_year: int,
    state: dict[str, dict],
    cells_by_fire: dict[str, dict],
    zone: set[str],
) -> tuple[int, int]:
    """Remove every zone cell from every target-year fire, in place, and
    return (fires emptied, distinct cells removed).

    Runs over the WHOLE store each run, not only this run's tracks: the zone
    grows (a plant accrues days) and shrinks (old detections leave the raw
    archive), and an unchanged fire is never re-read. So the removal must be
    reversible without the track body. The cells file stores the FILTERED
    list — it is also the file the web paints, so it cannot hold plant cells —
    and each entry keeps what the zone took in `zone_cells` (the web ignores
    it). Raw cells = cells + zone_cells, re-filtered against today's zone, so
    a cell the zone no longer covers comes back. Keeping the removed cells in
    the SAME entry makes the pair atomic under publish()'s unordered upload.

    A fire the zone empties cannot stay in the cells file (the web counts
    every entry as a fire), so its raw cells and first date move to its state
    entry (`zone_empty`), which the reconcile treats as not wanted. If that
    state upload is lost, the reconcile sees a wanted fire missing from the
    cells file, re-reads the body and empties it again — self-healing."""
    removed: set[str] = set()
    emptied = 0
    candidates = [(tid, e) for tid, e in cells_by_fire.items()] + [
        (tid, {"digest": e["digest"], "first": e["first"], "cells": [], "zone_cells": e["zone_cells"]})
        for tid, e in state.items()
        if e.get("zone_empty") and e.get("year") == target_year
    ]
    for tid, entry in candidates:
        raw = list(dict.fromkeys([*entry["cells"], *entry.get("zone_cells", [])]))
        kept = [c for c in raw if c not in zone]
        taken = [c for c in raw if c in zone]
        removed.update(taken)
        st = state.get(tid)
        if kept:
            cells_by_fire[tid] = {"digest": entry["digest"], "first": entry["first"], "cells": kept}
            if taken:
                cells_by_fire[tid]["zone_cells"] = taken
            if st is not None:
                for k in ("zone_empty", "zone_cells", "first"):
                    st.pop(k, None)
        else:
            cells_by_fire.pop(tid, None)
            emptied += 1
            if st is not None:
                st.update({"zone_empty": True, "zone_cells": taken, "first": entry["first"]})
    return emptied, len(removed)


def dedup_by_fire(cells_by_fire: dict[str, dict]) -> dict[str, list[str]]:
    """Each fire's nested-deduped cells. ~1.5 s over a full season, and both
    the aggregate and the sizes sidecar need it, so a run computes it once."""
    return {fid: dedup_nested_cells(entry["cells"]) for fid, entry in cells_by_fire.items()}


def aggregate_r6(
    cells_by_fire: dict[str, dict],
    deduped: dict[str, list[str]] | None = None,
) -> list[list]:
    """[[res-6 cell, km2], ...] sorted by cell: the real area of every
    (nested-deduped) burned cell, rolled up to its res-6 parent — ground
    burned once, however many fires touched it.

    The union is taken across fires BEFORE the roll-up: fires overlap (the
    same cell is claimed by up to 8 archived fires in the prod sample), and
    summing per fire published a km2 that over-counted by ~10 %."""
    deduped = dedup_by_fire(cells_by_fire) if deduped is None else deduped
    seen: set[str] = set()
    for cells in deduped.values():
        seen.update(cells)
    totals: dict[str, float] = {}
    for cell in seen:
        parent = h3.cell_to_parent(cell, AGG_RES) if h3.get_resolution(cell) > AGG_RES else cell
        totals[parent] = totals.get(parent, 0.0) + h3.cell_area(cell, unit="km^2")
    return [[cell, round(km2, 1)] for cell, km2 in sorted(totals.items())]


def summarize(
    year: int,
    cells_by_fire: dict[str, dict],
    now: datetime,
    deduped: dict[str, list[str]] | None = None,
) -> dict:
    r6 = aggregate_r6(cells_by_fire, deduped)
    return {
        "year": year,
        "generated_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "floor": min((e["first"] for e in cells_by_fire.values()), default=None),
        "fires": len(cells_by_fire),
        "km2": round(sum(km2 for _, km2 in r6), 1),
        "r6": r6,
    }


def sizes_sidecar(
    year: int,
    cells_by_fire: dict[str, dict],
    fires_summary: dict[str, dict],
    deduped: dict[str, list[str]] | None = None,
) -> dict:
    """Per-fire [km2, country, first] for the web's size filter. km2 is the
    same per-fire nested-dedup sum the web's fireSizes() computes (and
    geo_local.true_area_km2 before its 0.1 rounding), kept to 3 decimals so a
    fire sitting on a slider edge lands on the same side as it would from the
    cells. Country comes from the scale blob's fires summary (written earlier
    in the same refresh); null where it has none. Arrays, not objects, to
    keep ~22k entries small."""
    deduped = dedup_by_fire(cells_by_fire) if deduped is None else deduped
    fires = {}
    for fid, entry in cells_by_fire.items():
        km2 = sum(h3.cell_area(c, unit="km^2") for c in deduped[fid])
        country = (fires_summary.get(fid) or {}).get("country")
        fires[fid] = [round(km2, 3), country, entry["first"]]
    return {"year": year, "fires": fires}


def run_export_season(
    settings: Settings,
    target_year: int,
    client=None,
    r2_bucket: str | None = None,
    time_budget_s: float = 300.0,
    clock: Callable[[], float] = time.monotonic,
    now: datetime | None = None,
    static_zone: set[str] | None = None,
) -> None:
    """Bring season_{target_year}.json / _cells.json up to date with the
    track archive, within `time_budget_s`; whatever is not reached this run
    stays in `to_process` for the next one (see export_scale_blob.run_export
    for why a budget, not a hard kill, is the right shape here).

    `static_zone` (season_static_zone): cells no published fire may keep —
    see apply_static_zone. None leaves the last run's filtering as it is."""
    index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
    if not index_path.exists():
        return
    now = now or datetime.now(timezone.utc)
    index: dict[str, str] = _load_json(index_path, {})
    state_path = settings.out_dir / SEASON_STATE_KEY
    cells_path = settings.out_dir / season_cells_key(target_year)
    summary_path = settings.out_dir / season_key(target_year)
    sizes_path = settings.out_dir / season_sizes_key(target_year)
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
    #
    # A static track (is_static_track) is recorded with its year but is not
    # wanted: a cells file that still holds it is a partial publish too.
    for tid, entry in list(state.items()):
        stored = cells_by_fire.get(tid)
        wanted = entry.get("year") == target_year and not entry.get("static") and not entry.get("zone_empty")
        if wanted != (stored is not None) or (stored is not None and stored.get("digest") != entry.get("digest")):
            del state[tid]
            cells_by_fire.pop(tid, None)

    def pending(tid: str, digest: str) -> bool:
        entry = state.get(tid, {})
        if entry.get("digest") != digest:
            return True
        # A target-year entry with no `static` verdict was recorded before the
        # gate existed (prod's state held every static track that way, digest
        # unchanged). Re-read it once. Its stored contribution is left in
        # place until then: the re-check covers every 2026 track and can span
        # several runs' budgets, and dropping first would blank the season.
        return entry.get("year") == target_year and "static" not in entry

    to_process = [(tid, digest) for tid, digest in index.items() if pending(tid, digest)]
    deadline = clock() + time_budget_s
    processed = long_span = long_span_small = malformed = static_excluded = 0

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
                if span > LONG_SPAN_DAYS:
                    long_span += 1
                    if len(body["cells"]) <= 10:
                        long_span_small += 1
                static = is_static_track(span, cells)
                state[tid]["static"] = static
                if static:
                    static_excluded += 1
                    continue
                cells_by_fire[tid] = {"digest": digest, "first": first, "cells": cells}

    zone_emptied = zone_removed = 0
    if static_zone is not None:
        zone_emptied, zone_removed = apply_static_zone(target_year, state, cells_by_fire, static_zone)
    if processed or malformed or zone_emptied or zone_removed:
        print(
            f"[season] processed={processed} long_span(>{LONG_SPAN_DAYS}d)={long_span} "
            f"of_which_<=10_cells={long_span_small} static_excluded={static_excluded} "
            f"static_zone_fires_excluded={zone_emptied} static_zone_cells_removed={zone_removed} "
            f"malformed={malformed}",
            file=sys.stderr,
        )
    deduped = dedup_by_fire(cells_by_fire)
    fires_summary = _load_json(settings.out_dir / scale_blob_fires_key(target_year), {})
    _save_json(cells_path, cells_by_fire)  # contributions first...
    # ...then the two files derived from them (the sidecar first: the summary
    # is what makes the web offer the layer at all)...
    _save_json(sizes_path, sizes_sidecar(target_year, cells_by_fire, fires_summary, deduped))
    _save_json(summary_path, summarize(target_year, cells_by_fire, now, deduped))
    _save_json(state_path, state)  # ...then commit state — the recovery contract
