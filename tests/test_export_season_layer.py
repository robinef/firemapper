import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import h3

from pipeline.config import (
    ARCHIVE_TRACKS_INDEX,
    SEASON_STATE_KEY,
    Settings,
    season_cells_key,
    season_key,
)
from pipeline.export_season import aggregate_r6, first_bin_date, run_export_season

NOW = datetime(2026, 9, 18, 10, 0, tzinfo=timezone.utc)


def _track_body(track_id: str, cells: list[str], first_bin: str, last_bin: str) -> dict:
    return {
        "id": track_id,
        "series": [
            {"bin": first_bin, "centroid": [45.0, 5.0], "new_cells": 1, "cum_cells": 1, "frp_sum": 1.0},
            {"bin": last_bin, "centroid": [45.0, 5.0], "new_cells": 0, "cum_cells": len(cells), "frp_sum": 1.0},
        ],
        "cells": cells,
        "cell_bins": [[last_bin, cells]],
        "frp_live": [],
    }


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        firms_map_key=None, eumetsat_key=None, eumetsat_secret=None,
        sh_client_id=None, sh_client_secret=None, sh_proxy=False, sh_layer=None,
        data_dir=tmp_path / "data", out_dir=tmp_path / "out",
    )


def _make_local_archive(out_dir: Path, tracks: dict[str, dict]) -> dict[str, str]:
    index = {}
    for track_id, body in tracks.items():
        path = out_dir / "archive" / "tracks" / f"{track_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(body, sort_keys=True)
        path.write_text(text)
        index[track_id] = hashlib.sha256(text.encode()).hexdigest()
    index_path = out_dir / ARCHIVE_TRACKS_INDEX
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index))
    return index


def _read(settings: Settings, key: str):
    return json.loads((settings.out_dir / key).read_text())


def _two_cells() -> list[str]:
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    assert len(set(cells)) == 2
    return cells


def test_first_bin_date_reads_the_earliest_series_bin():
    body = _track_body("a", ["x"], "2026-07-25T06:00:00+00:00", "2026-08-06T00:00:00+00:00")
    assert first_bin_date(body) == "2026-07-25"


def test_aggregate_r6_sums_real_cell_area_into_each_res6_parent():
    # Two adjacent res-8 cells may or may not share a res-6 parent (a disk
    # can straddle a parent boundary), so build the expectation by grouping
    # rather than assuming one parent.
    cells = _two_cells()
    expected: dict[str, float] = {}
    for c in cells:
        p = h3.cell_to_parent(c, 6)
        expected[p] = expected.get(p, 0.0) + h3.cell_area(c, unit="km^2")
    r6 = aggregate_r6({"a": {"digest": "d", "first": "2026-07-01", "cells": cells}})
    assert r6 == [[p, round(km2, 1)] for p, km2 in sorted(expected.items())]


def test_aggregate_r6_does_not_double_count_a_meteosat_parent_and_its_viirs_children():
    child = h3.latlng_to_cell(45.0, 5.0, 8)
    parent7 = h3.cell_to_parent(child, 7)
    r6 = aggregate_r6({"a": {"digest": "d", "first": "2026-07-01", "cells": [parent7, child]}})
    assert r6 == [[h3.cell_to_parent(child, 6), round(h3.cell_area(child, unit="km^2"), 1)]]


def test_run_export_season_writes_cells_summary_and_state_for_the_target_year(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    index = _make_local_archive(settings.out_dir, {
        "fire-2026": _track_body("fire-2026", cells, "2026-07-25T00:00:00+00:00", "2026-08-06T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    stored = _read(settings, season_cells_key(2026))
    assert stored == {"fire-2026": {"digest": index["fire-2026"], "first": "2026-07-25", "cells": cells}}
    summary = _read(settings, season_key(2026))
    assert summary["year"] == 2026
    assert summary["generated_at"] == "2026-09-18T10:00:00Z"
    assert summary["floor"] == "2026-07-25"
    assert summary["fires"] == 1
    assert summary["km2"] == round(sum(h3.cell_area(c, unit="km^2") for c in cells), 1)
    assert summary["r6"] == aggregate_r6(stored)
    assert _read(settings, SEASON_STATE_KEY) == {"fire-2026": {"digest": index["fire-2026"], "year": 2026}}


def test_run_export_season_skips_tracks_outside_the_target_year_but_records_them(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    index = _make_local_archive(settings.out_dir, {
        "fire-2025": _track_body("fire-2025", cells, "2025-08-01T00:00:00+00:00", "2025-08-10T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_cells_key(2026)) == {}
    summary = _read(settings, season_key(2026))
    assert summary["fires"] == 0 and summary["km2"] == 0 and summary["r6"] == [] and summary["floor"] is None
    # Recorded so the next run does not re-fetch it.
    assert _read(settings, SEASON_STATE_KEY) == {"fire-2025": {"digest": index["fire-2025"], "year": 2025}}


def test_run_export_season_does_not_reprocess_an_unchanged_digest(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    run_export_season(settings, target_year=2026, now=NOW)
    floor_before = _read(settings, season_key(2026))["floor"]

    import pipeline.export_season as mod
    calls = []
    original = mod._load_track_body

    def spy(out_dir, track_id, client, r2_bucket):
        calls.append(track_id)
        return original(out_dir, track_id, client, r2_bucket)

    monkeypatch.setattr(mod, "_load_track_body", spy)
    run_export_season(settings, target_year=2026, now=NOW)

    assert calls == []
    # The floor survives a run that touched no track: it comes from the
    # persisted per-fire `first`, not from bodies read this run.
    assert _read(settings, season_key(2026))["floor"] == floor_before == "2026-07-01"


def test_run_export_season_floor_moves_when_the_earliest_fire_is_replaced(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    _make_local_archive(settings.out_dir, {
        "early": _track_body("early", cells[:1], "2026-06-01T00:00:00+00:00", "2026-06-03T00:00:00+00:00"),
        "late": _track_body("late", cells[1:], "2026-08-01T00:00:00+00:00", "2026-08-03T00:00:00+00:00"),
    })
    run_export_season(settings, target_year=2026, now=NOW)
    assert _read(settings, season_key(2026))["floor"] == "2026-06-01"

    # "early" is re-archived with a later first bin (its digest changes).
    _make_local_archive(settings.out_dir, {
        "early": _track_body("early", cells[:1], "2026-07-15T00:00:00+00:00", "2026-07-16T00:00:00+00:00"),
        "late": _track_body("late", cells[1:], "2026-08-01T00:00:00+00:00", "2026-08-03T00:00:00+00:00"),
    })
    run_export_season(settings, target_year=2026, now=NOW)
    assert _read(settings, season_key(2026))["floor"] == "2026-07-15"


def test_run_export_season_is_a_noop_without_an_archive_index(tmp_path):
    settings = _settings(tmp_path)
    run_export_season(settings, target_year=2026, now=NOW)
    assert not (settings.out_dir / season_key(2026)).exists()


def test_a_malformed_track_is_skipped_and_recorded_without_poisoning_the_run(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    good = _track_body("good", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    bad = {"id": "bad", "series": [], "cells": cells, "cell_bins": [], "frp_live": []}
    index = _make_local_archive(settings.out_dir, {"good": good, "bad": bad})

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    state = _read(settings, SEASON_STATE_KEY)
    assert state["good"] == {"digest": index["good"], "year": 2026}
    assert state["bad"] == {"digest": index["bad"], "year": None}
