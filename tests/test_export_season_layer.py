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
    assert _read(settings, SEASON_STATE_KEY)["big"] == {
        "digest": index["big"], "year": 2026, "static": False,
    }


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
    assert sidecar["fires"]["fr"] == [km2(cells), "FR", "2026-07-25", None]
    # The nested fire counts its ground once, like true_area_km2 (and the web).
    assert sidecar["fires"]["nested"] == [round(h3.cell_area(child, unit="km^2"), 3), None, "2026-07-02", None]
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


# --- static heat-source zone from the raw detections -----------------------
# The archived track bodies cannot carry this signal (cell_bins records a
# cell once per track, on its first bin), so the zone comes from the raw
# hotspot archive through the LIVE rule, events.static_classification.

PLANT = h3.latlng_to_cell(52.48, 4.60, 8)  # a steelworks-sized source
FAR = h3.latlng_to_cell(44.0, 3.0, 8)  # a real fire's ground, far away


def _ring1(cell: str) -> list[str]:
    return sorted(set(h3.grid_disk(cell, 1)) - {cell})


def _rows(cell: str, n_days: int, tier: str = "viirs", start_day: int = 1) -> list[dict]:
    from datetime import timedelta
    lat, lon = h3.cell_to_latlng(cell)
    first = datetime(2026, 7, start_day, 13, 0, tzinfo=timezone.utc)
    return [
        {"lat": lat, "lon": lon, "acq_time": first + timedelta(days=d), "tier": tier,
         "satellite": "N", "confidence": "n", "frp": 5.0, "src_id": f"{cell}-{tier}-{d}"}
        for d in range(n_days)
    ]


def _plant_zone(days: int = 25) -> set[str]:
    from pipeline.events import static_classification
    return static_classification(_rows(PLANT, days))[1]


def _fire(tid: str, cells: list[str], day: int = 1) -> dict:
    return _track_body(tid, cells, f"2026-07-{day:02d}T00:00:00+00:00", f"2026-07-{day + 2:02d}T00:00:00+00:00")


def _all_published_cells(settings: Settings) -> set[str]:
    cells = _read(settings, season_cells_key(2026))
    return {c for e in cells.values() for c in e["cells"]}


def test_the_zone_removes_a_plant_cell_and_its_ring_from_every_fire_including_earlier_ones(tmp_path):
    settings = _settings(tmp_path)
    ring = _ring1(PLANT)
    early = [PLANT, ring[0], FAR]
    _make_local_archive(settings.out_dir, {"early": _fire("early", early)})
    run_export_season(settings, target_year=2026, now=NOW)  # no zone known yet
    assert PLANT in _all_published_cells(settings)
    late_far = h3.latlng_to_cell(44.2, 3.2, 8)
    _make_local_archive(settings.out_dir, {
        "early": _fire("early", early),
        "late": _fire("late", [ring[1], late_far], day=5),
    })

    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    cells = _read(settings, season_cells_key(2026))
    assert cells["early"]["cells"] == [FAR]
    assert cells["late"]["cells"] == [late_far]
    sizes = _read(settings, season_sizes_key(2026))["fires"]
    assert sizes["early"][0] == round(h3.cell_area(FAR, unit="km^2"), 3)
    zone_r6 = {h3.cell_to_parent(c, 6) for c in [PLANT, *ring]} - {h3.cell_to_parent(c, 6) for c in (FAR, late_far)}
    assert not zone_r6 & {cell for cell, _ in _read(settings, season_key(2026))["r6"]}


def test_a_real_fire_detected_on_one_to_three_days_per_cell_loses_nothing(tmp_path):
    from pipeline.events import static_classification
    settings = _settings(tmp_path)
    fire = sorted(h3.grid_disk(FAR, 5))[:60]
    rows = _rows(PLANT, 25)
    for i, c in enumerate(fire):
        rows += _rows(c, 1 + i % 3, start_day=1 + i % 20)
    zone = static_classification(rows)[1]
    _make_local_archive(settings.out_dir, {"big": _fire("big", fire), "plant": _fire("plant", [PLANT])})

    run_export_season(settings, target_year=2026, now=NOW, static_zone=zone)

    cells = _read(settings, season_cells_key(2026))
    assert cells["big"]["cells"] == fire
    assert "plant" not in cells


def test_a_fire_made_only_of_zone_cells_is_excluded_and_counted(tmp_path, capsys):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "plant": _fire("plant", [PLANT, *_ring1(PLANT)[:2]]),
        "good": _fire("good", [FAR]),
    })

    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert set(_read(settings, season_sizes_key(2026))["fires"]) == {"good"}
    assert _read(settings, season_key(2026))["fires"] == 1
    err = capsys.readouterr().err
    assert "static_zone_fires_excluded=1 " in err
    assert "static_zone_cells_removed=3" in err


def test_a_zone_emptied_fire_is_not_reprocessed_every_run(tmp_path, capsys):
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {"plant": _fire("plant", [PLANT]), "good": _fire("good", [FAR])})
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())
    capsys.readouterr()

    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    import re
    assert not re.search(r"processed=[1-9]", capsys.readouterr().err)  # nothing re-read
    assert set(_read(settings, season_cells_key(2026))) == {"good"}


def test_cells_come_back_when_the_zone_no_longer_covers_them(tmp_path):
    # The raw store only grows, but the zone can still shrink: a change to
    # STATIC_CELL_DAYS / MAX_FIRE_DAYS / the ring, or purged rows. A cell it no
    # longer covers must reappear, including in a fire it had emptied.
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {
        "mixed": _fire("mixed", [PLANT, FAR]),
        "plant": _fire("plant", [PLANT]),
    })
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    run_export_season(settings, target_year=2026, now=NOW, static_zone=set())

    cells = _read(settings, season_cells_key(2026))
    assert sorted(cells["mixed"]["cells"]) == sorted([PLANT, FAR])
    assert cells["plant"]["cells"] == [PLANT]
    assert cells["plant"]["first"] == "2026-07-01"


def test_a_run_without_a_zone_leaves_the_last_filtering_in_place(tmp_path):
    # None = "the raw store could not be read this run", not "no plants":
    # re-publishing the plants for one run would flicker them back on.
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {"mixed": _fire("mixed", [PLANT, FAR])})
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    run_export_season(settings, target_year=2026, now=NOW, static_zone=None)

    assert _read(settings, season_cells_key(2026))["mixed"]["cells"] == [FAR]


def test_no_zone_publishes_exactly_what_it_did_before(tmp_path):
    outputs = []
    for name, kwargs in (("a", {}), ("b", {"static_zone": None})):
        settings = _settings(tmp_path / name)
        _make_local_archive(settings.out_dir, {"mixed": _fire("mixed", [PLANT, FAR]), "good": _fire("good", [FAR])})
        run_export_season(settings, target_year=2026, now=NOW, **kwargs)
        outputs.append([
            (settings.out_dir / k).read_bytes()
            for k in (season_cells_key(2026), season_sizes_key(2026), season_key(2026), SEASON_STATE_KEY)
        ])
    assert outputs[0] == outputs[1]
    cells = _read(settings, season_cells_key(2026))
    assert cells["mixed"] == {"digest": cells["mixed"]["digest"], "first": "2026-07-01", "cells": [PLANT, FAR]}
    assert all(set(e) <= {"digest", "year", "static", "place"} for e in _read(settings, SEASON_STATE_KEY).values())


def test_a_lost_state_upload_heals_a_zone_emptied_fire(tmp_path):
    # publish() is unordered: the filtered cells file can land while the state
    # that records "emptied by the zone" does not. The reconcile then sees a
    # wanted fire missing from the cells file, re-reads it, and empties it again.
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {"plant": _fire("plant", [PLANT]), "good": _fire("good", [FAR])})
    run_export_season(settings, target_year=2026, now=NOW)
    state_path = settings.out_dir / SEASON_STATE_KEY
    old_state = state_path.read_text()
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())
    state_path.write_text(old_state)

    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    assert set(_read(settings, season_cells_key(2026))) == {"good"}
    assert _read(settings, SEASON_STATE_KEY)["plant"].get("zone_empty") is True


def test_the_zone_follows_the_live_threshold(monkeypatch):
    import pipeline.events as events
    assert PLANT in _plant_zone(25)
    monkeypatch.setattr(events, "STATIC_CELL_DAYS", 26)
    assert _plant_zone(25) == set()


def test_meteosat_rows_never_classify_a_cell():
    from pipeline.events import static_classification
    assert static_classification(_rows(PLANT, 40, tier="meteosat")) == (set(), set())


def test_season_static_zone_reads_the_target_years_polar_rows_from_the_raw_store(tmp_path):
    from pipeline.export_season import season_static_zone
    from pipeline.store import append_hotspots
    settings = _settings(tmp_path)
    store = settings.data_dir / "raw" / "hotspots.parquet"
    store.parent.mkdir(parents=True)
    last_year = [dict(r, acq_time=r["acq_time"].replace(year=2025), src_id="old-" + r["src_id"]) for r in _rows(FAR, 25)]
    append_hotspots(_rows(PLANT, 25) + last_year, store)

    zone = season_static_zone(settings, 2026)

    assert zone == set(h3.grid_disk(PLANT, 1))


def test_season_static_zone_is_none_without_a_raw_store(tmp_path, capsys):
    from pipeline.export_season import season_static_zone
    assert season_static_zone(_settings(tmp_path), 2026) is None
    assert "no raw hotspot store" in capsys.readouterr().err


def test_the_zone_starts_exactly_at_the_live_day_count():
    from pipeline.config import STATIC_CELL_DAYS
    assert PLANT in _plant_zone(STATIC_CELL_DAYS)
    assert _plant_zone(STATIC_CELL_DAYS - 1) == set()


def _store_with_plant_days(settings: Settings, offsets: list[int]) -> None:
    from datetime import timedelta
    from pipeline.store import append_hotspots
    lat, lon = h3.cell_to_latlng(PLANT)
    start = datetime(2026, 1, 10, 13, 0, tzinfo=timezone.utc)
    rows = [
        {"lat": lat, "lon": lon, "acq_time": start + timedelta(days=d), "tier": "viirs",
         "satellite": "N", "confidence": "n", "frp": 5.0, "src_id": f"p-{d}"}
        for d in offsets
    ]
    store = settings.data_dir / "raw" / "hotspots.parquet"
    store.parent.mkdir(parents=True, exist_ok=True)
    append_hotspots(rows, store)


def test_the_season_zone_counts_days_per_live_window_not_per_year(tmp_path):
    from pipeline.export_season import season_static_zone
    settings = _settings(tmp_path)
    _store_with_plant_days(settings, [round(i * 200 / 24) for i in range(25)])  # 25 days over 200

    assert season_static_zone(settings, 2026) == set()


def test_the_season_zone_window_is_the_live_max_fire_days(tmp_path, monkeypatch):
    import pipeline.export_season as mod
    from pipeline.config import STATIC_CELL_DAYS
    settings = _settings(tmp_path)
    _store_with_plant_days(settings, [i * 3 for i in range(STATIC_CELL_DAYS)])  # spans 57 days
    assert PLANT in mod.season_static_zone(settings, 2026)

    monkeypatch.setattr(mod, "MAX_FIRE_DAYS", 50)

    assert mod.season_static_zone(settings, 2026) == set()


def test_a_run_without_a_zone_filters_re_read_fires_by_the_last_good_zone(tmp_path):
    # The raw store unreadable for one run must not publish a plant just
    # because its track was re-archived (new digest) that same run.
    settings = _settings(tmp_path)
    far2 = h3.latlng_to_cell(44.3, 3.3, 8)
    _make_local_archive(settings.out_dir, {"mixed": _fire("mixed", [PLANT, FAR]), "plant": _fire("plant", [PLANT])})
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())
    _make_local_archive(settings.out_dir, {  # both bodies change
        "mixed": _fire("mixed", [PLANT, FAR, far2]),
        "plant": _fire("plant", [PLANT, _ring1(PLANT)[0]]),
    })

    run_export_season(settings, target_year=2026, now=NOW, static_zone=None)

    cells = _read(settings, season_cells_key(2026))
    assert cells["mixed"]["cells"] == [FAR, far2]
    assert "plant" not in cells
    assert _read(settings, SEASON_STATE_KEY)["plant"]["zone_empty"] is True


def test_the_last_good_zone_is_kept_in_state_under_a_reserved_key(tmp_path):
    from pipeline.export_season import ZONE_STATE_KEY
    settings = _settings(tmp_path)
    _make_local_archive(settings.out_dir, {"good": _fire("good", [FAR])})
    run_export_season(settings, target_year=2026, now=NOW, static_zone=_plant_zone())

    run_export_season(settings, target_year=2026, now=NOW, static_zone=None)  # idle, no zone

    stored = _read(settings, SEASON_STATE_KEY)[ZONE_STATE_KEY]
    assert stored == {"cells": sorted(_plant_zone()), "computed_at": "2026-09-18T10:00:00Z"}
    assert set(_read(settings, season_cells_key(2026))) == {"good"}


# --- nearest-town place (archived season fires get a name) -----------------
# A tiny synthetic GeoNames cities5000 extract — never real data. Column
# layout mirrors tests/test_enrich.py's GEONAMES_TSV: geonameid, name,
# asciiname, alternatenames, lat, lon, feature class, feature code, country.
GAZETTEER_TSV = "1\tTestburg\tTestburg\t\t45.02\t5.02\tP\tPPL\tFR\t\t\t\t\t\t1000\t\t\t\n"


def _write_gazetteer(settings: Settings, text: str = GAZETTEER_TSV) -> None:
    path = settings.data_dir / "places" / "cities5000.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_a_new_fire_gets_a_place_from_the_gazetteer(tmp_path):
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()  # centred on (45.0, 5.0), a few km from Testburg
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, SEASON_STATE_KEY)["fire-a"]["place"] == "Testburg"
    assert _read(settings, season_sizes_key(2026))["fires"]["fire-a"][3] == "Testburg"


def test_a_fire_beyond_max_place_km_from_any_town_gets_a_null_place(tmp_path):
    from pipeline.enrich import MAX_PLACE_KM
    from pipeline.metrics import haversine_m
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    far_origin = h3.latlng_to_cell(40.0, 5.0, 8)
    far_cells = sorted(h3.grid_disk(far_origin, 1))[:2]
    assert len(set(far_cells)) == 2
    assert haversine_m(45.02, 5.02, 40.0, 5.0) / 1000 > MAX_PLACE_KM  # sanity: really beyond the cutoff
    _make_local_archive(settings.out_dir, {
        "fire-far": _track_body("fire-far", far_cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, SEASON_STATE_KEY)["fire-far"]["place"] is None
    assert _read(settings, season_sizes_key(2026))["fires"]["fire-far"][3] is None


def test_a_missing_gazetteer_leaves_the_fire_unplaced_until_a_run_that_has_one(tmp_path):
    # No gazetteer this run: the export must not fail, the sidecar carries
    # null — and the state entry must NOT record a place at all. A stored
    # null would be permanent (nothing re-reads an unchanged fire), where an
    # absent key is exactly what the migration loop fills on the next run.
    settings = _settings(tmp_path)  # no gazetteer file written at all
    cells = _two_cells()
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)  # must not raise

    assert "place" not in _read(settings, SEASON_STATE_KEY)["fire-a"]
    assert _read(settings, season_sizes_key(2026))["fires"]["fire-a"][3] is None

    _write_gazetteer(settings)
    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, SEASON_STATE_KEY)["fire-a"]["place"] == "Testburg"
    assert _read(settings, season_sizes_key(2026))["fires"]["fire-a"][3] == "Testburg"


def test_the_sizes_sidecar_carries_the_fourth_place_element(tmp_path):
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })

    run_export_season(settings, target_year=2026, now=NOW)

    entry = _read(settings, season_sizes_key(2026))["fires"]["fire-a"]
    assert len(entry) == 4
    assert entry[3] == "Testburg"


def test_a_reprocessed_fire_keeps_its_place_when_the_gazetteer_is_unavailable(tmp_path):
    # fire-a is already published and named "Testburg" (gazetteer present).
    # Its track body then changes (new digest) on a run where the gazetteer
    # happens to be missing. That must not blank the name that was already
    # computed — the gazetteer being unavailable this run is not the same
    # thing as the fire genuinely having no nearby town.
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    run_export_season(settings, target_year=2026, now=NOW)
    assert _read(settings, SEASON_STATE_KEY)["fire-a"]["place"] == "Testburg"

    # The track body changes (a new detection widens the cell set), which
    # changes its digest and brings it back into to_process. The gazetteer is
    # transiently unavailable for this run only.
    wider_cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:3]
    _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", wider_cells, "2026-07-01T00:00:00+00:00", "2026-07-04T00:00:00+00:00"),
    })
    (settings.data_dir / "places" / "cities5000.txt").unlink()

    run_export_season(settings, target_year=2026, now=NOW)

    assert _read(settings, SEASON_STATE_KEY)["fire-a"]["place"] == "Testburg"
    assert _read(settings, season_sizes_key(2026))["fires"]["fire-a"][3] == "Testburg"


def test_the_migration_fills_place_for_an_existing_entry_without_re_reading_its_body(tmp_path, monkeypatch):
    # A legacy state/cells pair from before this feature shipped: the fire is
    # already published, its digest matches (so it is not in to_process this
    # run), and its state entry has no "place" key yet.
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "year": 2026, "static": False},
    }))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "first": "2026-07-01", "cells": cells},
    }))
    import pipeline.export_season as mod

    def _boom(*a):
        raise AssertionError("should not re-read the body to compute a migrated place")

    monkeypatch.setattr(mod, "_load_track_body", _boom)

    run_export_season(settings, target_year=2026, now=NOW)  # must not call _load_track_body

    assert _read(settings, SEASON_STATE_KEY)["fire-a"]["place"] == "Testburg"


def test_the_run_log_counts_migrated_places(tmp_path, capsys):
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
    })
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"fire-a": {"digest": index["fire-a"], "year": 2026, "static": False}}))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "first": "2026-07-01", "cells": cells},
    }))

    run_export_season(settings, target_year=2026, now=NOW)

    assert "placed=1" in capsys.readouterr().err


def test_the_migration_respects_the_time_budget(tmp_path):
    settings = _settings(tmp_path)
    _write_gazetteer(settings)
    cells = _two_cells()
    other_cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.5, 8), 1))[:2]
    index = _make_local_archive(settings.out_dir, {
        "fire-a": _track_body("fire-a", cells, "2026-07-01T00:00:00+00:00", "2026-07-03T00:00:00+00:00"),
        "fire-b": _track_body("fire-b", other_cells, "2026-07-05T00:00:00+00:00", "2026-07-06T00:00:00+00:00"),
    })
    state_path = settings.out_dir / SEASON_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "year": 2026, "static": False},
        "fire-b": {"digest": index["fire-b"], "year": 2026, "static": False},
    }))
    (settings.out_dir / season_cells_key(2026)).write_text(json.dumps({
        "fire-a": {"digest": index["fire-a"], "first": "2026-07-01", "cells": cells},
        "fire-b": {"digest": index["fire-b"], "first": "2026-07-05", "cells": other_cells},
    }))
    ticks = iter([0.0, 0.0, 100.0])  # deadline check passes once, then fails

    run_export_season(settings, target_year=2026, now=NOW, time_budget_s=10.0, clock=lambda: next(ticks))

    state = _read(settings, SEASON_STATE_KEY)
    assert sum("place" in e for e in state.values()) == 1

    run_export_season(settings, target_year=2026, now=NOW)  # finishes over the next run's normal budget

    state = _read(settings, SEASON_STATE_KEY)
    assert "place" in state["fire-a"] and "place" in state["fire-b"]
