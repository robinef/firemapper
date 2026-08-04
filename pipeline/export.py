from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path

from .config import SCHEMA_VERSION, Settings
from .fetch_result import FetchResult
from .freshness import carried_entry, layer_entry, should_carry
from .enrich import gdacs_for_event, nearest_place
from .events import lifecycle, reactivation_links
import h3

from .events import METEOSAT_CELL_KM2, METEOSAT_RES
from .isochrones import isochrone_features
from .metrics import CELL_KM2, area_km2, bins_series, local_spread_vectors, movement, status

RECENT_DAYS = 7


def dedupe_frp_points(aged: list[dict]) -> list[dict]:
    """Collapse repeat observations of the same MTG pixel into one record.

    MTG re-reports each burning pixel every ~10 minutes, so a single location
    can appear >100 times. Left stacked, every copy draws its own arrow at the
    same spot and inflates heatmap density with observation count rather than
    fire extent. Keep the freshest age, the peak FRP, and how many times and
    how long the pixel burned.
    """
    by_loc: dict[tuple[float, float], dict] = {}
    for p in aged:
        key = (p["lon"], p["lat"])
        cur = by_loc.get(key)
        age = p.get("age_min")
        if cur is None:
            by_loc[key] = {**p, "n": 1, "first_min": age}
            continue
        cur["n"] += 1
        cur["frp"] = max(cur["frp"], p["frp"])
        if age is not None:
            if cur["age_min"] is None or age < cur["age_min"]:
                cur["age_min"] = age
                cur["time"] = p.get("time")
            if cur["first_min"] is None or age > cur["first_min"]:
                cur["first_min"] = age
    return list(by_loc.values())


def _cell_bins(members: list[dict]) -> list[list]:
    """[[bin_iso, [new H3 cells that bin]], ...] sorted by bin — aligned with
    bins_series. Accumulating these up to bin i gives the fire's footprint then."""
    seen: set = set()
    by_bin: dict[str, list[str]] = {}
    for m in sorted(members, key=lambda m: m["acq_time"]):
        b = m["bin"].isoformat()
        by_bin.setdefault(b, [])
        if m["cell"] not in seen:
            seen.add(m["cell"])
            by_bin[b].append(m["cell"])
    return [[b, by_bin[b]] for b in sorted(by_bin)]


def _events_features(events, liveness, places, alerts, now):
    feats = []
    reacts = reactivation_links(events, now)
    for eid, members in events.items():
        newest = max(m["acq_time"] for m in members)
        if now - newest > timedelta(days=RECENT_DAYS):
            continue
        met = liveness.get(eid)
        met_latest = datetime.fromisoformat(met["latest"]) if met else None
        life = lifecycle(members, met_latest, now)
        series = bins_series(members)
        # Marker sits at the centroid of the WHOLE fire, not just the newest
        # bin — the latter drifts to the active edge and lands the dot off the
        # burn. cell size follows the clustering resolution (Meteosat res 7).
        cen = [
            sum(m["lat"] for m in members) / len(members),
            sum(m["lon"] for m in members) / len(members),
        ]
        cell_km2 = METEOSAT_CELL_KM2 if h3.get_resolution(members[0]["cell"]) == METEOSAT_RES else CELL_KM2
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [cen[1], cen[0]]},
                "properties": {
                    "id": eid, "status": life,
                    "lifecycle_age_h": round((now - newest).total_seconds() / 3600, 1),
                    "started": min(m["acq_time"] for m in members).isoformat(),
                    "area_km2": (a := area_km2(members, cell_km2)),
                    # Drives scale-dependent display: big fires show
                    # Europe-wide, smaller ones reveal as you zoom in, so no
                    # scale is cluttered (multi-scale generalisation). See
                    # size_class() for why the boundaries are NWCG's.
                    "size_class": size_class(a, cells=len({m["cell"] for m in members})),
                    "cum_cells": series[-1]["cum_cells"],
                    "movement": movement(series, now), "state": status(series, now),
                    "freshness": {"viirs": newest.isoformat(), "meteosat": met["latest"] if met else None},
                    "place": (place := nearest_place(cen[0], cen[1], places)),
                    # Flat copy for map labels: MapLibre stringifies nested
                    # objects, so ["get", "name"] needs a top-level key.
                    "name": place["name"] if place else None,
                    "gdacs": gdacs_for_event(members, alerts),
                    "reactivation_of": reacts.get(eid), "merged_into": None,
                },
            }
        )
    return feats


def _previous_ids_cells(out_dir: Path) -> dict[str, set[str]] | None:
    man = out_dir / "manifest.json"
    if not man.exists():
        return None
    gen = out_dir / json.loads(man.read_text())["generation"]
    prev: dict[str, set[str]] = {}
    tracks = gen / "tracks"
    if not tracks.exists():
        return prev
    for tr in tracks.glob("*.json"):
        d = json.loads(tr.read_text())
        prev[d["id"]] = set(d.get("cells", []))
    return prev


def _previous_manifest(out_dir: Path) -> dict:
    man = out_dir / "manifest.json"
    if not man.exists():
        return {}
    try:
        return json.loads(man.read_text())
    except json.JSONDecodeError:
        return {}


def _carry_layer_files(previous_generation: Path, gen: Path, filenames: list[str]) -> bool:
    """Copy a previous generation's files for a layer whose fetch failed.

    Returns False when the files are not there to copy, so the caller can fall
    back to publishing what it has rather than silently dropping the layer.
    """
    available = [n for n in filenames if (previous_generation / n).exists()]
    if len(available) != len(filenames):
        return False
    for name in filenames:
        shutil.copy2(previous_generation / name, gen / name)
    return True


# Size classes follow the NWCG fire size standard (https://www.nwcg.gov/node/432922),
# the US interagency scale used in federal incident records. Boundaries are its
# acre thresholds converted to km2 (1 acre = 0.00404686 km2):
#
#   A <=0.25 ac   B <10 ac   C <100 ac   D <300 ac   E <1000 ac   F <5000 ac   G 5000+
#
# We map only the top three. Classes A-C are below what this pipeline can
# resolve: an H3 res-7 cell is ~5 km2, so a single detection already reports
# ~0.7 km2.
#
# The previous thresholds (major >=50, medium >=15) were invented rather than
# borrowed, and were calibrated for megafires: of 2828 live fires on 2026-08-04,
# 1335 fell in "minor", 8 in "medium", 1 in "major" — and major >= 50 sits ABOVE
# NWCG's largest class. Binned by NWCG the same data spreads D 1552 / E 1078 /
# F 192 / G 6, which is what makes the per-class zoom gates behave.
#
# Caveat worth keeping in mind: NWCG classes describe surveyed incident
# perimeters, ours are H3 cell counts quantised to ~5 km2. Borrowing the
# boundaries is defensible and citable; the low end reads coarse.
MEDIUM_KM2 = 4.05   # NWCG F, 1000 acres
MAJOR_KM2 = 20.2    # NWCG G, 5000 acres


def size_class(area_km2_value: float, cells: int | None = None) -> str:
    """NWCG size class, collapsed to the three this pipeline can resolve.

    A one-cell footprint is never sized. area_km2 is cells x SENSOR cell size —
    0.7 km2 for VIIRS, 5.2 km2 for Meteosat — and NWCG's F boundary of 4.05 km2
    falls BETWEEN the two. So a single Meteosat pixel, the smallest thing that
    sensor can express, came out as class F while a single VIIRS pixel came out
    minor. Measured in production 2026-08-04: of the events with exactly one
    cell, 1118 were minor and 1117 medium — identical footprint, opposite class,
    decided by which satellite happened to see the fire.

    One cell means detected, not measured: the true burned area is anywhere
    between a fraction of a km2 and the whole cell. NWCG applies from two cells
    up, where the extent is actually resolved.

    `cells=None` keeps plain NWCG semantics for callers that have no count.
    """
    if cells is not None and cells <= 1:
        return "minor"
    if area_km2_value >= MAJOR_KM2:
        return "major"
    if area_km2_value >= MEDIUM_KM2:
        return "medium"
    return "minor"


def validate_generation(
    gen: Path, layers: dict | None = None, carry_available: set[str] | None = None
) -> list[str]:
    problems = []
    for name in ("events.geojson", "stats.json", "lineage.json"):
        p = gen / name
        if not p.exists():
            problems.append(f"missing {name}")
            continue
        try:
            json.loads(p.read_text())
        except json.JSONDecodeError:
            problems.append(f"invalid json: {name}")

    # A failed layer that could have been carried but was not is a bug in the
    # carry path, and publishing it would put an empty layer on the live map —
    # the exact regression this design exists to prevent. Refuse instead.
    for key in sorted(carry_available or set()):
        if (layers or {}).get(key, {}).get("status") == "failed":
            problems.append(f"{key} failed but a carry was available and unused")
    return problems


def prune_generations(out_dir: Path, keep: int = 3) -> None:
    gens = sorted(out_dir.glob("gen-*"))
    for g in (gens[:-keep] if len(gens) > keep else []):
        shutil.rmtree(g)


def export(
    settings: Settings, events, liveness, places, alerts, now,
    live_frp=None, frp_points=None, wind=None, aircraft=None,
    imagery=None, timeline=None, day_slices=None, results=None,
) -> Path:
    out = settings.out_dir
    results = results or {}
    gen = out / f"gen-{now.strftime('%Y%m%dT%H%M%SZ')}"
    (gen / "tracks").mkdir(parents=True, exist_ok=True)
    (gen / "slices").mkdir(exist_ok=True)

    prev = _previous_ids_cells(out)

    feats = _events_features(events, liveness, places, alerts, now)
    (gen / "events.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats})
    )

    cur_cells = {eid: {m["cell"] for m in ms} for eid, ms in events.items()}
    for eid, ms in events.items():
        (gen / "tracks" / f"{eid}.json").write_text(
            json.dumps(
                {
                    "id": eid, "series": bins_series(ms), "cells": sorted(cur_cells[eid]),
                    # New H3 cells introduced per 6 h bin (aligned with `series`),
                    # so the card can rebuild the fire's footprint AS OF any bin.
                    "cell_bins": _cell_bins(ms),
                    "frp_live": liveness.get(eid, {}).get("frp_series", []),
                }
            )
        )

    by_bin: dict[str, dict[str, int]] = {}
    for ms in events.values():
        for m in ms:
            if now - m["acq_time"] <= timedelta(days=RECENT_DAYS):
                b = by_bin.setdefault(m["bin"].isoformat(), {})
                b[m["cell"]] = b.get(m["cell"], 0) + 1
    for biso, cells in by_bin.items():
        safe = biso.replace(":", "").replace("+0000", "Z").replace("+00:00", "Z")
        (gen / "slices" / f"{safe}.json").write_text(json.dumps({"cells": sorted(cells.items())}))
    slice_bins = sorted(by_bin.keys())

    # Live FRP pixels as points — rendered client-side as a weighted heatmap
    # instead of the WMS's fixed ~2 km squares.
    # age_min is precomputed here because MapLibre style expressions have no
    # concept of "now" — the map cannot derive recency from a timestamp itself.
    aged = []
    for p in frp_points or []:
        age_min = None
        if p.get("time"):
            try:
                seen = datetime.fromisoformat(p["time"].replace("Z", "+00:00"))
                age_min = max(0, round((now - seen).total_seconds() / 60))
            except ValueError:
                age_min = None
        aged.append({**p, "age_min": age_min})

    # One record per pixel, then a local spread bearing for each, so every
    # arrow sits on its own location.
    pixels = dedupe_frp_points(aged)
    vectors = local_spread_vectors(pixels)
    frp_feats = []
    for i, p in enumerate(pixels):
        props = {
            "frp": p["frp"], "t": p.get("time"), "age_min": p["age_min"],
            "n": p["n"], "first_min": p["first_min"],
        }
        # Omit `dir` entirely when there is no gradient. The map filters arrows
        # on ["has", "dir"]; a null left in place would render as a 0° arrow,
        # inventing a due-north spread that was never measured.
        if vectors[i] is not None:
            props["dir"] = vectors[i][0]
            if vectors[i][1] is not None:
                props["spd"] = vectors[i][1]  # km/h, local edge speed
        frp_feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                "properties": props,
            }
        )
    (gen / "frp.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": frp_feats})
    )

    # True isochrone bands (dissolved unions), not per-point blobs.
    iso_feats = isochrone_features(pixels)
    (gen / "isochrones.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": iso_feats})
    )

    # Wind. `from_deg` is the meteorological convention (where wind comes
    # FROM); `to_deg` is what an arrow must be rotated by to show where it is
    # blowing TO. Getting these backwards would point every arrow at the fire's
    # upwind side, so both are stored explicitly rather than flipped in the UI.
    wind_feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [w["lon"], w["lat"]]},
            "properties": {
                "from_deg": w["dir"], "to_deg": round((w["dir"] + 180) % 360, 1),
                "kmh": w["kmh"], "gust_kmh": w["gust_kmh"],
                "temp_c": w.get("temp_c"), "rh": w.get("rh"), "t": w.get("time"),
            },
        }
        for w in (wind or [])
    ]
    (gen / "wind.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": wind_feats})
    )

    # Live firefighting aircraft (OpenSky ADS-B snapshot).
    ac_feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [a["lon"], a["lat"]]},
            "properties": {k: v for k, v in a.items() if k not in ("lon", "lat")},
        }
        for a in (aircraft or [])
    ]
    (gen / "aircraft.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": ac_feats})
    )

    detections: dict[str, int] = {}
    for ms in events.values():
        for m in ms:
            d = m["acq_time"].date().isoformat()
            detections[d] = detections.get(d, 0) + 1
    (gen / "stats.json").write_text(json.dumps({"detections": detections}))

    # Per-day detection slices (h3 cell + count) — one file per day, loaded when
    # a histogram day is clicked to paint that day's fires across Europe.
    day_dates: list[str] = []
    if day_slices:
        (gen / "days").mkdir(exist_ok=True)
        for date, cells in day_slices.items():
            (gen / "days" / f"{date}.json").write_text(json.dumps(cells))
        day_dates = sorted(day_slices)

    merged: dict[str, str] = {}
    if prev:
        for old_id, old_cells in prev.items():
            if old_id in events or not old_cells:
                continue
            for eid, cells in cur_cells.items():
                if len(old_cells & cells) / len(old_cells) >= 0.5:
                    merged[old_id] = eid
                    break
    (gen / "lineage.json").write_text(
        json.dumps({"merged": merged, "reactivated": reactivation_links(events, now)})
    )

    # Per-layer freshness. A failed fetch keeps the previous generation's file
    # (marked "carried") instead of publishing an empty layer; a CONFIRMED empty
    # replaces it, so a quiet world never looks like an outage and vice versa.
    previous_manifest = _previous_manifest(out)
    previous_layers = previous_manifest.get("layers") or {}
    previous_generation = (
        out / previous_manifest["generation"]
        if previous_manifest.get("generation")
        and (out / previous_manifest["generation"]).exists()
        else None
    )

    layers: dict[str, dict] = {}
    # Layers a carry was possible for, so the validator can catch a failed
    # carry rather than letting an empty layer reach the map.
    carry_available: set[str] = set()
    newest_detection = max(
        (m["acq_time"] for ms in events.values() for m in ms), default=None
    )
    layers["events"] = layer_entry(
        "events",
        FetchResult("ok" if events else "empty", events, now, newest_detection),
        now=now, source="viirs+mtg",
    )

    for key, source, filenames in (
        ("frp", "mtg-fci", ["frp.geojson", "isochrones.geojson"]),
        ("wind", "open-meteo", ["wind.geojson"]),
        ("aircraft", "opensky", ["aircraft.geojson"]),
        ("timeline", "archive", []),
        ("imagery", "gibs+effis", []),
    ):
        result = results.get(key)
        if result is None:
            continue
        carryable = previous_generation is not None and should_carry(
            key, result, previous_layers.get(key), now
        )
        if carryable:
            carry_available.add(key)
        if carryable and _carry_layer_files(previous_generation, gen, filenames):
            layers[key] = carried_entry(previous_layers[key], now=now)
            carry_available.discard(key)  # carried successfully, nothing to flag
            print(f"[warn] {key}: fetch failed, carrying the previous generation")
            continue
        layers[key] = layer_entry(key, result, now=now, source=source)

    # Carried layers whose payload lives in the manifest itself, not a file.
    if layers.get("timeline", {}).get("status") == "carried":
        timeline = previous_manifest.get("timeline") or timeline
    if layers.get("imagery", {}).get("status") == "carried":
        imagery = previous_manifest.get("imagery") or imagery

    layers["gibs_tiles"] = layer_entry(
        "gibs_tiles", FetchResult("ok", None, now, now), now=now, source="nasa-gibs",
    )

    problems = validate_generation(gen, layers=layers, carry_available=carry_available)
    if problems:
        raise RuntimeError(f"generation invalid, not publishing: {problems}")
    # Atomic publish: write to a temp file then os.replace so a polling client
    # never observes a truncated manifest.
    tmp = out / "manifest.json.tmp"
    tmp.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION, "generated_at": now.isoformat(),
                "generation": gen.name,
                # Reported, not asserted: the old hardcoded `"viirs": True`
                # claimed a tier the live site did not actually have.
                "tiers": {
                    "viirs": any(
                        m["tier"] != "meteosat" for ms in events.values() for m in ms
                    ),
                    "meteosat": bool(liveness),
                },
                "layers": layers,
                "slice_bins": slice_bins,
                "live_frp": live_frp,
                "frp_points": len(frp_feats),
                "wind_points": len(wind_feats),
                "aircraft": len(ac_feats),
                "imagery": imagery,
                "timeline": timeline,
                "day_slice_dates": day_dates,
                "isochrone_bands": len(iso_feats),
            }
        )
    )
    os.replace(tmp, out / "manifest.json")
    prune_generations(out)
    return gen
