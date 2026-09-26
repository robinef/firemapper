"""OpenStreetMap-confirmed static cells for the season layer: the shipped file,
the union loader the refresh uses, and the candidate rule
scripts/make_osm_static_zone.py applies (the Overpass call itself is not
exercised: the script is a one-off and its output is the committed file)."""
from __future__ import annotations

import json

import h3

from pipeline import export_season as es
from pipeline.events import STATIC_RING_K
from scripts import make_osm_static_zone as mk

PLANT = h3.latlng_to_cell(50.8, 19.1, 8)
FIELD = h3.latlng_to_cell(40.0, -4.0, 8)


def _fire(cells, first="2026-03-01"):
    return {"cells": cells, "first": first, "digest": "x"}


def test_the_refresh_masks_both_committed_lists(tmp_path, monkeypatch):
    sp, osm = tmp_path / "sp.json", tmp_path / "osm.json"
    sp.write_text(json.dumps({"2026": [FIELD]}))
    osm.write_text(json.dumps({"2026": [PLANT]}))
    monkeypatch.setattr(es, "SP_STATIC_CELLS_FILE", sp)
    monkeypatch.setattr(es, "OSM_STATIC_CELLS_FILE", osm)
    monkeypatch.setattr(es.sp_static_zone, "__defaults__", (sp,))
    expected = set(h3.grid_disk(FIELD, STATIC_RING_K)) | set(h3.grid_disk(PLANT, STATIC_RING_K))
    assert es.extra_static_zone(2026) == expected
    assert es.extra_static_zone(2027) == set()


def test_the_shipped_file_covers_2026_only_with_valid_res8_cells():
    data = json.loads(es.OSM_STATIC_CELLS_FILE.read_text())
    assert list(data) == ["2026"]
    assert data["2026"] == sorted(set(data["2026"]))
    assert all(h3.is_valid_cell(c) and h3.get_resolution(c) == 8 for c in data["2026"])
    assert 30 < len(data["2026"]) < 500  # the measured build: 71


def test_candidates_are_small_early_fires_on_a_shared_cell_outside_the_front():
    shared = [f"f{i}" for i in range(mk.MIN_SHARING_FIRES)]
    cells = {fid: _fire([PLANT]) for fid in shared}
    cells["late"] = _fire([PLANT], first=mk.RAW_STORE_START)
    cells["big"] = _fire([PLANT] + list(h3.grid_ring(PLANT, 1))[: mk.MAX_CELLS])
    cells["alone"] = _fire([FIELD])
    cells["front"] = _fire([PLANT])
    fires = {fid: [0.7, "PL", "2026-03-01", "x"] for fid in cells}
    fires["front"][1] = "UA"
    assert sorted(mk.candidates(cells, fires)) == shared


def test_solar_and_wind_farms_are_not_heat_sources():
    assert mk.is_heat_source({"landuse": "industrial"})
    assert mk.is_heat_source({"power": "plant", "plant:source": "coal"})
    assert not mk.is_heat_source({"power": "plant", "plant:source": "solar"})
    assert not mk.is_heat_source({"power": "plant", "name": "Planta Solar Bienvenida"})
    assert not mk.is_heat_source({"power": "plant", "plant:source": "wind"})
