"""One-off: find the 2026 season's Jan-Jun plant residue that NASA's SP flag
misses (scripts/make_sp_static_zone.py) and confirm it against OpenStreetMap,
writing pipeline/osm_static_cells.json, which the season export masks the same
way (export_season.sp_static_zone, called with OSM_STATIC_CELLS_FILE).

A candidate is a fire that
- starts before RAW_STORE_START (before that the raw-store zone cannot see it;
  the backfill clustered SP rows, which geolocate differently from NRT),
- has at most MAX_CELLS cells, and
- sits on a res-8 cell shared by at least MIN_SHARING_FIRES season fires.
Ukraine and Russia are left out: cells recur there because the front line
does, and industry sits on it.

A candidate is kept when OpenStreetMap maps an industrial site within
RADIUS_M of it (landuse=industrial, man_made=works, a flare/chimney/kiln/
petroleum well, or a power plant that is not solar or wind; a grass fire
next to a solar farm is a real fire).

Measured 2026-09-26 against the published season (27,164 fires), 400 m:
non-UA/RU candidates 70% near mapped industry (Kirkuk refinery, Huta
Czestochowa, Hanson Cement, MOL flare, Lafarge), against 9% of 200 random
Jul-Sep small fires and 3% of 100 fires >= 50 cells.

    uv run python -m scripts.make_osm_static_zone season_2026_cells.json season_2026_sizes.json
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import h3

from pipeline.export_season import OSM_STATIC_CELLS_FILE

YEAR = 2026
RAW_STORE_START = "2026-06-30"
MAX_CELLS = 3
MIN_SHARING_FIRES = 3
RADIUS_M = 400
EXCLUDED_COUNTRIES = {"UA", "RU"}
NOT_HEAT = {"solar", "wind"}
OVERPASS = "https://overpass-api.de/api/interpreter"
BATCH = 25


def res8(cell: str) -> str:
    return h3.cell_to_parent(cell, 8) if h3.get_resolution(cell) > 8 else cell


def candidates(cells: dict[str, dict], fires: dict[str, list]) -> dict[str, list[str]]:
    """fire id -> its res-8 cells, for every fire the rule above selects."""
    sharing: dict[str, set[str]] = defaultdict(set)
    for fid, body in cells.items():
        for c in body["cells"]:
            sharing[res8(c)].add(fid)
    out = {}
    for fid, body in cells.items():
        own = sorted({res8(c) for c in body["cells"]})
        country = (fires.get(fid) or [None, None])[1]
        if (
            body["first"] < RAW_STORE_START
            and len(body["cells"]) <= MAX_CELLS
            and country not in EXCLUDED_COUNTRIES
            and any(len(sharing[c]) >= MIN_SHARING_FIRES for c in own)
        ):
            out[fid] = own
    return out


def is_heat_source(tags: dict) -> bool:
    if tags.get("power") == "plant":
        source = tags.get("plant:source", "") + " " + tags.get("name", "").lower()
        return not any(s in source for s in NOT_HEAT)
    return True


def _query(points: list[tuple[str, float, float]]) -> dict[str, list[dict]]:
    r = RADIUS_M
    body = "".join(
        f"( wr(around:{r},{a},{o})[landuse=industrial]; wr(around:{r},{a},{o})[man_made=works];"
        f' nwr(around:{r},{a},{o})[man_made~"^(flare|chimney|kiln|petroleum_well)$"];'
        f" wr(around:{r},{a},{o})[power=plant]; );out tags 10;"
        f'make mark k="{key}";out;'
        for key, a, o in points
    )
    request = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": "[out:json][timeout:300];" + body}).encode(),
        headers={"User-Agent": "firemapper-static-zone/1"},
    )
    found: dict[str, list[dict]] = {}
    current: list[dict] = []
    for e in json.load(urllib.request.urlopen(request, timeout=320))["elements"]:
        if e.get("type") == "mark":
            found[e["tags"]["k"]], current = current, []
        else:
            current.append(e.get("tags", {}))
    return found


def near_industry(points: dict[str, tuple[float, float]]) -> set[str]:
    keys = sorted(points)
    hits: set[str] = set()
    for i in range(0, len(keys), BATCH):
        batch = [(k, *points[k]) for k in keys[i : i + BATCH]]
        for attempt in range(4):
            try:
                found = _query(batch)
                break
            except Exception as exc:  # Overpass 429/504 under load
                print(f"[retry] batch {i}: {exc}", file=sys.stderr, flush=True)
                time.sleep(30 * (attempt + 1))
        else:
            raise SystemExit(f"Overpass failed on batch {i}; nothing written")
        if len(found) != len(batch):
            raise SystemExit(f"batch {i}: {len(found)} of {len(batch)} answers; nothing written")
        hits |= {k for k, tags in found.items() if any(is_heat_source(t) for t in tags)}
        time.sleep(2)
    return hits


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    cells = json.loads(Path(argv[0]).read_text())
    fires = json.loads(Path(argv[1]).read_text())["fires"]
    picked = candidates(cells, fires)
    points = {fid: h3.cell_to_latlng(own[0]) for fid, own in picked.items()}
    hits = near_industry(points)
    zone = sorted({c for fid in hits for c in picked[fid]})
    OSM_STATIC_CELLS_FILE.write_text(json.dumps({str(YEAR): zone}, indent=0) + "\n")
    print(
        f"[info] {len(picked)} candidates, {len(hits)} near industry, "
        f"{len(zone)} cells -> {OSM_STATIC_CELLS_FILE}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
