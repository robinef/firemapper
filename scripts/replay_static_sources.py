"""Verification for the static heat-source filter: replays events.cluster()
against a real hotspot archive and checks the classification against a
labelled expectation list — real fires that must survive, known industrial
sources that must be dropped — rather than a subjective "looks right" read.

    uv run python -m scripts.replay_static_sources <hotspots.parquet> [--now ISO]

Exits non-zero on any label mismatch. Also times cluster() with and without
the filter on the same input and fails if filtering costs more than
RUNTIME_BUDGET_PCT.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config import H3_RES, SCAR_WINDOW_DAYS
from pipeline.enrich import MIN_PLACES, Places, load_places, place_for
from pipeline.events import _cluster_one, cluster, static_cells
from pipeline.store import read_hotspots

RUNTIME_BUDGET_PCT = 20

# Labelled by hand against archive/hotspots-gen-20260907T083037Z.parquet
# (sha256 recorded in the PR). Matched by place name substring (case-sensitive)
# since ids are not stable across archive snapshots.
MUST_DROP = [
    "Meiderich", "IJmuiden", "Burglesum", "Cherepovets", "Lipetsk", "Linz",
    "Fos-sur-Mer", "Giarre", "Kirkuk",
]
MUST_KEEP = ["Arès", "Nevesinje", "Bela Crkva", "Dobropillya"]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    store = Path(argv[1])
    now = datetime.now(timezone.utc)
    if "--now" in argv:
        now = datetime.fromisoformat(argv[argv.index("--now") + 1])

    rows = [r for r in read_hotspots(store) if r["tier"] != "meteosat"]
    for r in rows:
        if r["acq_time"].tzinfo is None:
            r["acq_time"] = r["acq_time"].replace(tzinfo=timezone.utc)

    places_path = Path(__file__).parent.parent / "data" / "places" / "cities5000.txt"
    # Same min_places floor production uses (config.MIN_PLACES): a truncated
    # gazetteer must raise loudly here too, not silently mislabel everything
    # and let a name-substring check pass or fail for the wrong reason.
    places = load_places(places_path, min_places=MIN_PLACES) if places_path.exists() else Places([])

    report: dict = {}
    t0 = time.time()
    cluster(rows, now, window_days=SCAR_WINDOW_DAYS, report=report)
    filtered_s = time.time() - t0

    static_events = report.get("static_events", {})
    print(f"static heat sources: {len(static_events)} events, "
          f"{len(report.get('static_cells', set()))} cells")

    seen_names = []
    for eid, members in static_events.items():
        cells = len({m["cell"] for m in members})
        days = len({m["acq_time"].date() for m in members})
        p = place_for(members, places) if len(places) else None
        name = p["name"] if p else "(unnamed)"
        seen_names.append(name)
        print(json.dumps({
            "id": eid, "place": name, "cells": cells, "distinct_days": days,
            "members": len(members),
        }))

    ok = True
    for must in MUST_DROP:
        if not any(must in n for n in seen_names):
            print(f"[FAIL] expected to drop a source matching {must!r}, none found")
            ok = False

    # Everything else (unfiltered) must still contain each MUST_KEEP fire.
    # `rows` is already non-meteosat (line 47); reuse it rather than re-filter.
    # This pass doubles as the runtime baseline below — no separate 3rd pass.
    t0 = time.time()
    unfiltered = _cluster_one(rows, H3_RES, bridge=True)
    baseline_s = time.time() - t0
    kept_names = []
    for eid, members in unfiltered.items():
        if eid in static_events or len(members) < 4:
            continue
        p = place_for(members, places) if len(places) else None
        if p:
            kept_names.append(p["name"])
    for must in MUST_KEEP:
        if not any(must in n for n in kept_names):
            print(f"[FAIL] expected to keep a fire matching {must!r}, none found among kept events")
            ok = False

    static = static_cells(rows, H3_RES)
    print(f"cells classified static: {len(static)}")

    slower_pct = 100 * (filtered_s - baseline_s) / baseline_s if baseline_s else 0
    print(f"runtime: filtered {filtered_s:.1f}s vs baseline {baseline_s:.1f}s ({slower_pct:+.0f}%)")
    if slower_pct > RUNTIME_BUDGET_PCT:
        print(f"[FAIL] filtering is {slower_pct:.0f}% slower, budget is {RUNTIME_BUDGET_PCT}%")
        ok = False

    if ok:
        print("PASS")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
