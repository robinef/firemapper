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

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import h3

from .config import (
    ARCHIVE_TRACKS_INDEX,
    MAX_FIRE_DAYS,
    SEASON_STATE_KEY,
    SEASON_STATIC_MAX_CELLS,
    SEASON_STATIC_SPAN_DAYS,
    Settings,
    scale_blob_fires_key,
    season_cells_key,
    season_key,
    season_sizes_key,
)
from .enrich import Places, load_places_tolerant, place_for
from .events import STATIC_RING_K, static_classification
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
# season_state.json's non-track entries: per year, the last zone
# season_static_zone computed, {"cells": [...sorted], "computed_at": iso},
# applied on a run whose raw store is unreadable. Per year because the state
# is shared: in January two years are exported in one run, and one global
# zone would hand the new year's (small) zone to the ended season, restoring
# every plant it had removed. Track ids are 12 hex chars; these cannot
# collide. Popped off the state as it loads and put back as it saves, so no
# per-track loop (reconcile, pending, apply_static_zone) ever iterates them.
# The bare key is the single zone stored before it was per year.
ZONE_STATE_KEY = "__zone__"


def zone_state_key(year: int) -> str:
    return f"{ZONE_STATE_KEY}{year}"


# NASA-flagged static cells per year (scripts/make_sp_static_zone.py): the
# FIRMS SP archive labels each detection (`type` 2 = static land source).
# The raw store behind season_static_zone starts 2026-06-30, and the Jan-Jun
# backfill clustered SP rows, which put a plant's pings on neighbouring cells
# that never reach STATIC_CELL_DAYS: Kryvyi Rih, Puertollano, Arzew, Fos and
# ~180 more cells survived as 1-3-cell "fires". Data, not code; one year only,
# because from 2027 the raw store covers the whole season.
SP_STATIC_CELLS_FILE = Path(__file__).parent / "sp_static_cells.json"


def sp_static_zone(year: int, path: Path = SP_STATIC_CELLS_FILE) -> set[str]:
    """`year`'s NASA-flagged cells plus the STATIC_RING_K ring — the same
    jitter margin the raw-store zone gets. Empty for a year with no entry or
    a missing/unreadable file: this zone only ever adds to the other one."""
    try:
        cells = json.loads(path.read_text()).get(str(year), [])
    except (OSError, ValueError, AttributeError):
        return set()
    zone: set[str] = set()
    for c in cells:
        if h3.is_valid_cell(c):
            zone.update(h3.grid_disk(c, STATIC_RING_K))
    return zone


def _members_from_cells(cells: list[str]) -> list[dict]:
    """One point per burnt cell, in enrich.place_for's expected shape — the
    same "nearest to any detection, not the centroid" rule the live map uses
    (enrich.place_for), applied to an archived fire's cells rather than its
    raw detections. Keeps a big fire named after the town nearest its edge."""
    out = []
    for c in cells:
        lat, lon = h3.cell_to_latlng(c)
        out.append({"cell": c, "lat": lat, "lon": lon})
    return out


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
    """The static heat-source zone over `year`'s raw detections, by the live
    map's rule (events.static_classification): a cell is static when some
    MAX_FIRE_DAYS consecutive days — the live clustering window — hold >=
    STATIC_CELL_DAYS distinct detection days on it; the zone is those cells
    plus their STATIC_RING_K ring. So the season drops a cell iff some live
    refresh this year would have dropped it, not merely because separate
    episodes add up over the whole year.

    From the raw store, not the archived tracks: a track's cell_bins records
    each cell once, on its first bin, so the bodies cannot tell a plant lit
    on 30 days from a cell burned once (measured 2026-09-22: no archived
    cell reaches 5 days). None when the store is absent or empty — the export
    then applies the last good zone it stored (ZONE_STATE_KEY).

    The rows start MAX_FIRE_DAYS before 1 Jan, not on it: a live refresh on
    5 Jan clusters over a window reaching into December, so it already drops
    a plant lit all autumn. Counting only this year's rows left every plant
    unzoned until it had STATIC_CELL_DAYS detection days in the new year —
    three weeks of refineries published as the new season's only "fires"."""
    store = settings.data_dir / "raw" / "hotspots.parquet"
    start = datetime(year, 1, 1, tzinfo=timezone.utc) - timedelta(days=MAX_FIRE_DAYS)
    rows = [r for r in read_hotspots(store) if start <= r["acq_time"] and r["acq_time"].year <= year]
    if not rows:
        print(f"[season] no raw hotspot store rows for {year} at {store}; static zone unknown this run", file=sys.stderr)
        return None
    return static_classification(rows, window_days=MAX_FIRE_DAYS)[1]


def apply_static_zone(
    target_year: int,
    state: dict[str, dict],
    cells_by_fire: dict[str, dict],
    zone: set[str],
) -> tuple[int, int]:
    """Remove every zone cell from every target-year fire, in place, and
    return (fires emptied, distinct cells removed).

    Runs over the WHOLE store each run, not only this run's tracks: the zone
    grows as a plant accrues days, and an unchanged fire is never re-read.
    The raw store only grows, so the zone does not shrink on its own; it can
    when STATIC_CELL_DAYS / MAX_FIRE_DAYS / STATIC_RING_K change or rows are
    purged (store.delete_by_src_id). So the removal must be reversible
    without the track body. The cells file stores the FILTERED
    list — it is also the file the web paints, so it cannot hold plant cells —
    and each entry keeps what the zone took in `zone_cells` (the web ignores
    it). Raw cells = cells + zone_cells, re-filtered against today's zone, so
    a cell the zone no longer covers comes back. Keeping the removed cells in
    the SAME entry makes the pair atomic under publish()'s unordered upload.

    A fire the zone empties cannot stay in the cells file (the web counts
    every entry as a fire), so its raw cells and first date move to its state
    entry (`zone_empty`), which the reconcile treats as not wanted. If that
    state upload is lost, the reconcile sees a wanted fire missing from the
    cells file, re-reads the body and empties it again — self-healing.

    Only the cells' own ids are compared: the zone is res-8 (polar), so a
    res-7 Meteosat cell in a fire would not be masked even on a plant. The
    prod cells file has none today (every archived cell is res 8, measured
    2026-09-22); revisit if Meteosat-only fires start being archived."""
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
    state: dict[str, dict],
    deduped: dict[str, list[str]] | None = None,
) -> dict:
    """Per-fire [km2, country, first, place] for the web's size filter and,
    with #4, the burn-scar card's title (web/src/season_click.ts). km2 is the
    same per-fire nested-dedup sum the web's fireSizes() computes (and
    geo_local.true_area_km2 before its 0.1 rounding), kept to 3 decimals so a
    fire sitting on a slider edge lands on the same side as it would from the
    cells. Country comes from the scale blob's fires summary (written earlier
    in the same refresh); null where it has none. Place comes from `state`,
    where the per-body loop (and its migration) computed it once per digest —
    not recomputed here, so an idle run that only re-derives the sidecar from
    a stored cells file (see the "rewritten from stored cells" test) still
    carries it. Arrays, not objects, to keep ~22k entries small."""
    deduped = dedup_by_fire(cells_by_fire) if deduped is None else deduped
    fires = {}
    for fid, entry in cells_by_fire.items():
        km2 = sum(h3.cell_area(c, unit="km^2") for c in deduped[fid])
        country = (fires_summary.get(fid) or {}).get("country")
        place = (state.get(fid) or {}).get("place")
        fires[fid] = [round(km2, 3), country, entry["first"], place]
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
    extra_zone: set[str] | None = None,
) -> None:
    """Bring season_{target_year}.json / _cells.json up to date with the
    track archive, within `time_budget_s`; whatever is not reached this run
    stays in `to_process` for the next one (see export_scale_blob.run_export
    for why a budget, not a hard kill, is the right shape here).

    `static_zone` (season_static_zone): cells no published fire may keep —
    see apply_static_zone. None applies the last good zone stored in state
    (ZONE_STATE_KEY), or nothing if there has never been one.

    `extra_zone` (sp_static_zone): cells masked on top of that zone every
    run. Never stored — it is data shipped with the code, so the stored zone
    stays exactly what the raw store produced."""
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
    zones = {k: state.pop(k) for k in [k for k in state if k.startswith(ZONE_STATE_KEY)]}
    legacy_zone = zones.pop(ZONE_STATE_KEY, None)  # adopted once, then dropped
    stored_zone: dict | None = zones.get(zone_state_key(target_year), legacy_zone)
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
    processed = long_span = long_span_small = malformed = static_excluded = placed = 0
    places: Places | None = None  # lazy, loaded once per run, only once there is work

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
                old_entry = state.get(tid, {})
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
                # Named after the town nearest a burnt cell, exactly like a
                # live fire (enrich.place_for) — computed once per digest,
                # here rather than at sidecar time, so a re-read body is the
                # only thing that ever recomputes it.
                if places is None:
                    places = load_places_tolerant(settings)
                if len(places) == 0:
                    # The gazetteer is unavailable (missing/corrupt) for this
                    # run only — not evidence the fire has no nearby town. A
                    # fire that was already named keeps that name; one never
                    # named is left WITHOUT the key, so the migration loop
                    # below names it on the next run that has a gazetteer. A
                    # stored null would be permanent: nothing re-reads it.
                    if "place" in old_entry:
                        state[tid]["place"] = old_entry["place"]
                else:
                    place = place_for(_members_from_cells(cells), places)
                    state[tid]["place"] = place["name"] if place else None
                    placed += 1

    # No zone this run (raw store missing or unreadable) → the last good one,
    # so a fire re-read this run is filtered like every other. Never a zone
    # at all → no filtering, exactly the pre-zone export.
    if static_zone is not None:
        stored_zone = {
            "cells": sorted(static_zone),
            "computed_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    zone = static_zone if static_zone is not None else (set(stored_zone["cells"]) if stored_zone else None)
    if extra_zone:
        zone = (zone or set()) | extra_zone
    zone_emptied = zone_removed = 0
    if zone is not None:
        zone_emptied, zone_removed = apply_static_zone(target_year, state, cells_by_fire, zone)

    # Migration: a fire published before this feature shipped has no "place"
    # key and was never re-read above (its digest is unchanged), so it never
    # goes through the per-body branch that computes one. Fill it in from the
    # cells already in memory — NO body re-read — so this is a one-off pass
    # that completes over a few runs, like the static-verdict migration.
    # cells_by_fire is exactly "wanted" fires at this point (self-heal above
    # keeps it in lockstep with state), so nothing here needs the static /
    # zone_empty checks pending() and apply_static_zone use.
    for tid, entry in cells_by_fire.items():
        if clock() > deadline:
            break  # out of time — the rest stays unplaced for the next run
        st = state.get(tid)
        if st is None or "place" in st:
            continue
        if places is None:
            places = load_places_tolerant(settings)
        if len(places) == 0:
            break  # no gazetteer this run: leave them unplaced for the next one
        place = place_for(_members_from_cells(entry["cells"]), places)
        st["place"] = place["name"] if place else None
        placed += 1

    if processed or malformed or zone_emptied or zone_removed or placed:
        print(
            f"[season] processed={processed} long_span(>{LONG_SPAN_DAYS}d)={long_span} "
            f"of_which_<=10_cells={long_span_small} static_excluded={static_excluded} "
            f"static_zone_fires_excluded={zone_emptied} static_zone_cells_removed={zone_removed} "
            f"malformed={malformed} placed={placed}",
            file=sys.stderr,
        )
    deduped = dedup_by_fire(cells_by_fire)
    fires_summary = _load_json(settings.out_dir / scale_blob_fires_key(target_year), {})
    _save_json(cells_path, cells_by_fire)  # contributions first...
    # ...then the two files derived from them (the sidecar first: the summary
    # is what makes the web offer the layer at all)...
    _save_json(sizes_path, sizes_sidecar(target_year, cells_by_fire, fires_summary, state, deduped))
    _save_json(summary_path, summarize(target_year, cells_by_fire, now, deduped))
    if stored_zone is not None:
        zones[zone_state_key(target_year)] = stored_zone
    state.update(zones)
    _save_json(state_path, state)  # ...then commit state — the recovery contract
