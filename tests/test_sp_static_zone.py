"""NASA-flagged static cells for the season layer: the file, its loader, and
the rule scripts/make_sp_static_zone.py applies to a backfill build's tally."""
from __future__ import annotations

import json

import h3

from pipeline.events import STATIC_RING_K
from pipeline.export_season import SP_STATIC_CELLS_FILE, sp_static_zone
from scripts import make_sp_static_zone as mk

PLANT = h3.latlng_to_cell(45.0, 5.0, 8)


def test_the_loader_adds_the_live_ring_around_each_flagged_cell(tmp_path):
    p = tmp_path / "sp.json"
    p.write_text(json.dumps({"2026": [PLANT]}))
    assert sp_static_zone(2026, p) == set(h3.grid_disk(PLANT, STATIC_RING_K))


def test_another_year_or_a_broken_file_adds_nothing(tmp_path):
    p = tmp_path / "sp.json"
    p.write_text(json.dumps({"2026": [PLANT, "not-a-cell"]}))
    assert sp_static_zone(2027, p) == set()
    assert "not-a-cell" not in sp_static_zone(2026, p)
    p.write_text("{truncated")
    assert sp_static_zone(2026, p) == set()
    assert sp_static_zone(2026, tmp_path / "missing.json") == set()


def test_the_shipped_file_covers_2026_only_with_valid_res8_cells():
    data = json.loads(SP_STATIC_CELLS_FILE.read_text())
    assert list(data) == ["2026"]
    assert data["2026"] == sorted(set(data["2026"]))
    assert all(h3.is_valid_cell(c) and h3.get_resolution(c) == 8 for c in data["2026"])
    assert len(data["2026"]) > 1000  # the measured build: 1,592


def test_the_rule_needs_a_flagged_majority_on_enough_distinct_days():
    tally = {
        "plant": {"2": 30, "0": 2, "flagged_days": 20},
        "few_days": {"2": 5, "flagged_days": mk.MIN_FLAGGED_DAYS - 1},
        "mostly_fire": {"2": 4, "0": 6, "flagged_days": 4},
        "half": {"2": 5, "0": 5, "flagged_days": mk.MIN_FLAGGED_DAYS},
    }
    assert mk.static_cells(tally) == ["half", "plant"]
