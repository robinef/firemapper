import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import h3

from pipeline.config import (
    ARCHIVE_TRACKS_INDEX,
    SEASON_STATE_KEY,
    Settings,
    scale_blob_fires_key,
    season_cells_key,
    season_key,
    season_sizes_key,
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


def test_aggregate_r6_counts_shared_ground_once_across_fires():
    # Two fires that burned the same cell: the ground burned once, so the
    # published km2 must count that cell's area once, not once per fire.
    shared, other = _two_cells()
    r6 = aggregate_r6({
        "a": {"digest": "d", "first": "2026-07-01", "cells": [shared]},
        "b": {"digest": "e", "first": "2026-07-02", "cells": [shared, other]},
    })
    expected: dict[str, float] = {}
    for c in (shared, other):
        p = h3.cell_to_parent(c, 6)
        expected[p] = expected.get(p, 0.0) + h3.cell_area(c, unit="km^2")
    assert r6 == [[p, round(km2, 1)] for p, km2 in sorted(expected.items())]


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
    assert _read(settings, SEASON_STATE_KEY) == {
        "fire-2026": {"digest": index["fire-2026"], "year": 2026, "static": False},
    }


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
    assert state["good"] == {"digest": index["good"], "year": 2026, "static": False}
    assert state["bad"] == {"digest": index["bad"], "year": None}


def test_a_non_dict_track_body_is_skipped_like_any_malformed_body(tmp_path):
    settings = _settings(tmp_path)
    good = _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    index = _make_local_archive(settings.out_dir, {"good": good, "list-body": ["not", "a", "dict"]})

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert _read(settings, SEASON_STATE_KEY)["list-body"] == {"digest": index["list-body"], "year": None}


def test_a_track_body_whose_series_holds_non_dicts_is_skipped_like_any_malformed_body(tmp_path):
    settings = _settings(tmp_path)
    good = _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    # A dict body, so the isinstance guard lets it through — the TypeError
    # raised by indexing a str with "bin" is what the except tuple must catch.
    weird = {"id": "weird-series", "series": ["x"], "cells": _two_cells(), "cell_bins": [], "frp_live": []}
    index = _make_local_archive(settings.out_dir, {"good": good, "weird-series": weird})

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert _read(settings, SEASON_STATE_KEY)["weird-series"] == {
        "digest": index["weird-series"], "year": None,
    }


def test_self_heal_reprocesses_a_fire_missing_from_the_cells_file(tmp_path):
    settings = _settings(tmp_path)
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    # A state that claims fire-a is done, with no cells file at all (the
    # partial-publish shape: state landed in R2, cells did not).
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"fire-a": {"digest": index["fire-a"], "year": 2026}}))

    run_export_season(settings, target_year=2026, now=NOW)

    assert "fire-a" in _read(settings, season_cells_key(2026))


def test_self_heal_reprocesses_a_fire_whose_cells_entry_has_a_stale_digest(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    # New state + OLD cells entry for the same id: the unordered-upload race.
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"fire-a": {"digest": index["fire-a"], "year": 2026}}))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "fire-a": {"digest": "stale-digest", "first": "2026-01-01", "cells": cells[:1]},
    }))

    run_export_season(settings, target_year=2026, now=NOW)

    stored = _read(settings, season_cells_key(2026))["fire-a"]
    assert stored["digest"] == index["fire-a"]
    assert stored["cells"] == cells
    assert stored["first"] == "2026-07-01"


def test_self_heal_drops_a_ghost_contribution_from_a_fire_demoted_out_of_the_target_year(tmp_path):
    settings = _settings(tmp_path)
    cells = _two_cells()
    # fire-a is now a 2025 track, but the state still says 2025 with a
    # matching digest while the cells file still holds its 2026-era
    # contribution (state landed, cells did not). Nothing re-reads it unless
    # the self-heal reconciles "wanted" against "stored".
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2025-08-01T00:00:00+00:00", "2025-08-03T00:00:00+00:00"),
    })
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"fire-a": {"digest": index["fire-a"], "year": 2025}}))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "first": "2026-07-01", "cells": cells},
    }))

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_cells_key(2026)) == {}
    assert _read(settings, SEASON_STATE_KEY)["fire-a"] == {"digest": index["fire-a"], "year": 2025}
    summary = _read(settings, season_key(2026))
    assert summary["fires"] == 0 and summary["km2"] == 0


def test_crash_between_cells_and_state_write_recovers_on_the_next_run(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    import pipeline.export_season as mod
    original = mod._save_json

    def crash_on_state(path, data):
        if path.name == Path(SEASON_STATE_KEY).name:
            raise RuntimeError("simulated crash")
        original(path, data)

    monkeypatch.setattr(mod, "_save_json", crash_on_state)
    try:
        run_export_season(settings, target_year=2026, now=NOW)
    except RuntimeError:
        pass
    monkeypatch.setattr(mod, "_save_json", original)

    run_export_season(settings, target_year=2026, now=NOW)

    assert "fire-a" in _read(settings, season_cells_key(2026))
    assert "fire-a" in _read(settings, SEASON_STATE_KEY)


def test_time_budget_stops_early_and_the_rest_is_processed_next_run(tmp_path, monkeypatch):
    import pipeline.export_season as mod

    monkeypatch.setattr(mod, "FETCH_BATCH", 1)
    settings = _settings(tmp_path)
    cells = _two_cells()
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells[:1], "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
        "fire-b": _track_body("fire-b", cells[1:], "2026-07-05T00:00:00+00:00", "2026-07-06T00:00:00+00:00"),
    })
    ticks = iter([0.0, 0.0, 100.0, 100.0, 100.0])  # deadline check passes once, then fails

    run_export_season(settings, target_year=2026, now=NOW, time_budget_s=10.0, clock=lambda: next(ticks))

    first = _read(settings, season_cells_key(2026))
    assert len(first) == 1

    run_export_season(settings, target_year=2026, now=NOW)
    assert set(_read(settings, season_cells_key(2026))) == {"fire-a", "fire-b"}


def test_bodies_are_fetched_from_r2_when_not_local(tmp_path):
    """A fresh runner has the index but no track bodies; they come from R2
    (export_scale_blob._load_track_body), through the thread pool."""
    settings = _settings(tmp_path)
    body = _track_body("fire-r2", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    text = json.dumps(body, sort_keys=True)
    index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps({"fire-r2": hashlib.sha256(text.encode()).hexdigest()}))

    class _Body:
        def __init__(self, data): self._data = data
        def read(self): return self._data

    class FakeS3:
        def get_object(self, Bucket, Key):
            assert Key == "data/archive/tracks/fire-r2.json"
            return {"Body": _Body(text.encode())}

    run_export_season(settings, target_year=2026, client=FakeS3(), r2_bucket="b", now=NOW)

    assert "fire-r2" in _read(settings, season_cells_key(2026))


def test_a_track_whose_series_bin_is_unparsable_is_skipped_without_aborting_the_run(tmp_path):
    # year_of_track and first_bin_date only slice the bin string; _span_days
    # parses it. A bin that slices fine but does not parse must be counted
    # malformed like any other bad body, not raise out of the whole run.
    settings = _settings(tmp_path)
    good = _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    bad = {
        "id": "bad-bin",
        "series": [{"bin": "not-a-date"}, {"bin": "2026-07-03T00:00:00+00:00"}],
        "cells": _two_cells(), "cell_bins": [], "frp_live": [],
    }
    index = _make_local_archive(settings.out_dir, {"good": good, "bad-bin": bad})

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert _read(settings, SEASON_STATE_KEY)["bad-bin"] == {"digest": index["bad-bin"], "year": None}


# --- static heat-source gate ------------------------------------------------

def _disk_cells(n: int) -> list[str]:
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 6))[:n]
    assert len(set(cells)) == n
    return cells


def _static_body(track_id: str, n_cells: int, span_days: int) -> dict:
    from datetime import timedelta
    first = datetime(2026, 7, 1, tzinfo=timezone.utc)
    last = first + timedelta(days=span_days)
    return _track_body(track_id, _disk_cells(n_cells), first.isoformat(), last.isoformat())


def test_a_long_lived_tiny_track_is_excluded_as_a_static_source_and_recorded(tmp_path):
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    index = _make_local_archive(settings.out_dir, {
        "plant": _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1),
        "good": _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert _read(settings, SEASON_STATE_KEY)["plant"] == {"digest": index["plant"], "year": 2026, "static": True}
    assert _read(settings, season_key(2026))["fires"] == 1


def test_a_long_lived_large_track_is_kept(tmp_path):
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    index = _make_local_archive(settings.out_dir, {
        "big": _static_body("big", SEASON_STATIC_MAX_CELLS + 1, SEASON_STATIC_SPAN_DAYS + 1),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"big"}
    assert _read(settings, SEASON_STATE_KEY)["big"] == {"digest": index["big"], "year": 2026, "static": False}


def test_a_short_tiny_track_is_kept(tmp_path):
    from pipeline.config import SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "small": _static_body("small", 1, SEASON_STATIC_SPAN_DAYS),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"small"}


def test_the_static_gate_counts_unique_cells(tmp_path):
    # A track body lists a cell once per claim it can repeat; the gate is
    # about how much ground the source covers, so duplicates must not push a
    # plant over the cell cap.
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    body = _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1)
    body["cells"] = body["cells"] + body["cells"][:1]
    _make_local_archive(settings.out_dir, {"plant": body})

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_cells_key(2026)) == {}


def test_self_heal_removes_a_published_track_the_state_now_calls_static(tmp_path):
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    body = _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1)
    index = _make_local_archive(settings.out_dir, {"plant": body})
    # State (committed last) already says static, but the cells file that
    # should have dropped it failed to land: the unordered-upload race.
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"plant": {"digest": index["plant"], "year": 2026, "static": True}}))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "plant": {"digest": index["plant"], "first": "2026-07-01", "cells": body["cells"]},
    }))

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_cells_key(2026)) == {}
    assert _read(settings, SEASON_STATE_KEY)["plant"] == {"digest": index["plant"], "year": 2026, "static": True}


def test_a_track_recorded_before_the_gate_existed_is_reclassified(tmp_path, monkeypatch):
    # Prod's state already holds the static tracks as ordinary {digest, year}
    # entries with unchanged digests. Without a re-check the gate would never
    # see them and they would stay published forever.
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    plant = _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1)
    good = _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    index = _make_local_archive(settings.out_dir, {"plant": plant, "good": good})
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "plant": {"digest": index["plant"], "year": 2026},
        "good": {"digest": index["good"], "year": 2026},
    }))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "plant": {"digest": index["plant"], "first": "2026-07-01", "cells": plant["cells"]},
        "good": {"digest": index["good"], "first": "2026-07-01", "cells": good["cells"]},
    }))

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    state = _read(settings, SEASON_STATE_KEY)
    assert state["plant"] == {"digest": index["plant"], "year": 2026, "static": True}
    assert state["good"] == {"digest": index["good"], "year": 2026, "static": False}


def test_a_pre_gate_track_keeps_its_contribution_until_it_is_reprocessed(tmp_path, monkeypatch):
    # The re-check is a one-off pass over every 2026 track and can take more
    # than one run's budget. A track not yet reached must stay published —
    # dropping it first would blank most of the season for a cycle.
    import pipeline.export_season as mod
    settings = _settings(tmp_path)
    good = _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00")
    index = _make_local_archive(settings.out_dir, {"good": good})
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"good": {"digest": index["good"], "year": 2026}}))
    stored = {"good": {"digest": index["good"], "first": "2026-07-01", "cells": good["cells"]}}
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps(stored))
    monkeypatch.setattr(mod, "_load_track_body", lambda *a: None)  # every fetch fails this run

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_cells_key(2026)) == stored
    assert _read(settings, season_key(2026))["fires"] == 1


def test_the_run_log_counts_static_exclusions(tmp_path, capsys):
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "plant": _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1),
        "good": _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert "static_excluded=1 " in capsys.readouterr().err


# --- per-fire sizes sidecar -------------------------------------------------

def _write_fires_summary(settings: Settings, year: int, summary: dict) -> None:
    path = settings.out_dir / scale_blob_fires_key(year)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary))


def test_the_sizes_sidecar_holds_each_fires_area_country_and_first_date(tmp_path):
    from pipeline.geo_local import dedup_nested_cells, true_area_km2
    settings = _settings(tmp_path)
    cells = _two_cells()
    child = h3.latlng_to_cell(45.0, 5.0, 8)
    nested = [h3.cell_to_parent(child, 7), child]  # a Meteosat parent over its VIIRS child
    _make_local_archive(settings.out_dir, {
        "fr": _track_body("fr", cells, "2026-07-25T00:00:00+00:00", "2026-08-06T00:00:00+00:00"),
        "nested": _track_body("nested", nested, "2026-07-02T00:00:00+00:00", "2026-07-04T00:00:00+00:00"),
    })
    _write_fires_summary(settings, 2026, {"fr": {"country": "FR", "area_km2": 1.5}})

    run_export_season(settings, target_year=2026, now=NOW)

    sidecar = _read(settings, season_sizes_key(2026))
    assert sidecar["year"] == 2026
    assert set(sidecar["fires"]) == {"fr", "nested"}
    km2 = lambda cs: round(sum(h3.cell_area(c, unit="km^2") for c in dedup_nested_cells(cs)), 3)
    assert sidecar["fires"]["fr"] == [km2(cells), "FR", "2026-07-25"]
    # The nested fire counts its ground once, like true_area_km2 (and the web).
    assert sidecar["fires"]["nested"] == [round(h3.cell_area(child, unit="km^2"), 3), None, "2026-07-02"]
    for fid, cs in (("fr", cells), ("nested", nested)):
        assert round(sidecar["fires"][fid][0], 1) == true_area_km2(cs)


def test_the_sizes_sidecar_has_null_countries_without_a_fires_summary(tmp_path):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "fr": _track_body("fr", _two_cells(), "2026-07-25T00:00:00+00:00", "2026-08-06T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_sizes_key(2026))["fires"]["fr"][1] is None


def test_the_sizes_sidecar_reads_the_target_years_fires_summary(tmp_path):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "fr": _track_body("fr", _two_cells(), "2026-07-25T00:00:00+00:00", "2026-08-06T00:00:00+00:00"),
    })
    _write_fires_summary(settings, 2025, {"fr": {"country": "ES", "area_km2": 1.5}})

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, season_sizes_key(2026))["fires"]["fr"][1] is None


def test_the_sizes_sidecar_leaves_out_static_tracks(tmp_path):
    from pipeline.config import SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "plant": _static_body("plant", SEASON_STATIC_MAX_CELLS, SEASON_STATIC_SPAN_DAYS + 1),
        "good": _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_sizes_key(2026))["fires"]) == {"good"}


def test_the_sizes_sidecar_is_rewritten_from_the_stored_cells_on_a_run_that_read_nothing(tmp_path):
    # Like the summary, the sidecar is derived from the whole cells file, not
    # from this run's bodies: an idle run must not publish an empty sidecar.
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "good": _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    run_export_season(settings, target_year=2026, now=NOW)
    (settings.out_dir / season_sizes_key(2026)).unlink()

    run_export_season(settings, target_year=2026, now=NOW)

    assert set(_read(settings, season_sizes_key(2026))["fires"]) == {"good"}


def test_the_sizes_sidecar_is_written_after_the_cells_and_before_the_summary(tmp_path, monkeypatch):
    import pipeline.export_season as mod
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "good": _track_body("good", _two_cells(), "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    order = []
    original = mod._save_json

    def record(path, data):
        order.append(path.name)
        original(path, data)

    monkeypatch.setattr(mod, "_save_json", record)
    run_export_season(settings, target_year=2026, now=NOW)

    assert order == [
        Path(season_cells_key(2026)).name,
        Path(season_sizes_key(2026)).name,
        Path(season_key(2026)).name,
        Path(SEASON_STATE_KEY).name,
    ]
