"""One-off: turn a backfill build's sp_type_cells.json (scripts/backfill_season.py)
into pipeline/sp_static_cells.json, the NASA-flagged static cells the season
export masks on top of its raw-store zone (export_season.sp_static_zone).

A cell is kept when NASA flags (SP `type` != 0) at least MIN_FLAGGED_SHARE of
its SP rows, on at least MIN_FLAGGED_DAYS distinct days. Measured 2026-09-26
against the published 2026 season (27,568 fires), with the STATIC_RING_K ring
the loader adds:

- Jan to mid-Jul: 262 fires emptied, 10 trimmed (none above 4 cells); all
  three Kryvyi Rih ore-plant fires and 184 of the 410 fires sitting on a cell
  that recurs in >= 3 separate H1 fires (the plant-residue proxy) are caught.
- mid-Jul on: 246 fires emptied, nearly all at named plants the live zone's
  ring misses (Fos, Gravenchon, Donges, Dalmine, Paio Pires, Orkanger,
  Ostrava, Zenica, Syrian/Iraqi oil fields); 18 trimmed, the largest a
  69-cell fire at Giarre (Etna) losing 2 cells.

Looser rules (1-2 flagged days, or share >= 0.5 without the day floor) trim
28-45-cell real fires in the Danube delta and Krasnodar; stricter ones
(share 1.0) miss most of the plant residue.

    uv run python -m scripts.make_sp_static_zone <build dir>/sp_type_cells.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pipeline.export_season import SP_STATIC_CELLS_FILE

YEAR = 2026
MIN_FLAGGED_SHARE = 0.5
MIN_FLAGGED_DAYS = 3


def flagged_share(counts: dict) -> float:
    total = sum(n for k, n in counts.items() if k != "flagged_days")
    return 1 - counts.get("0", 0) / total if total else 0.0


def static_cells(type_cells: dict[str, dict]) -> list[str]:
    return sorted(
        cell for cell, counts in type_cells.items()
        if flagged_share(counts) >= MIN_FLAGGED_SHARE and counts.get("flagged_days", 0) >= MIN_FLAGGED_DAYS
    )


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    cells = static_cells(json.loads(Path(argv[0]).read_text()))
    SP_STATIC_CELLS_FILE.write_text(json.dumps({str(YEAR): cells}, indent=0) + "\n")
    print(f"[info] {len(cells)} cells for {YEAR} -> {SP_STATIC_CELLS_FILE}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
