import json
from pathlib import Path

import pytest

from pipeline.config import (
    ARCHIVE_TRACKS_INDEX,
    SCALE_BLOB_STATE_KEY,
    Settings,
    scale_blob_fires_key,
)
from pipeline.export_scale_blob import run_export, year_of_track


def _track_body(track_id: str, cells: list[str], last_bin: str) -> dict:
    return {
        "id": track_id,
        "series": [{"bin": "2026-01-01T00:00:00+00:00", "centroid": [45.0, 5.0], "new_cells": 1, "cum_cells": 1, "frp_sum": 1.0},
                   {"bin": last_bin, "centroid": [45.0, 5.0], "new_cells": 0, "cum_cells": len(cells), "frp_sum": 1.0}],
        "cells": cells,
        "cell_bins": [[last_bin, cells]],
        "frp_live": [],
    }


def test_year_of_track_reads_last_series_bin():
    body = _track_body("fire-a", ["dummy"], "2026-03-15T12:00:00+00:00")
    assert year_of_track(body) == 2026


def test_year_of_track_handles_z_suffix():
    body = {"id": "x", "series": [{"bin": "2025-12-31T23:00:00Z"}]}
    assert year_of_track(body) == 2025


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        firms_map_key=None,
        eumetsat_key=None,
        eumetsat_secret=None,
        sh_client_id=None,
        sh_client_secret=None,
        sh_proxy=False,
        sh_layer=None,
        data_dir=tmp_path / "data",
        out_dir=tmp_path / "out",
    )


def _make_local_archive(out_dir: Path, tracks: dict[str, dict]) -> None:
    index = {}
    for track_id, body in tracks.items():
        track_path = out_dir / "archive" / "tracks" / f"{track_id}.json"
        track_path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(body, sort_keys=True)
        track_path.write_text(text)
        import hashlib

        index[track_id] = hashlib.sha256(text.encode()).hexdigest()
    index_path = out_dir / ARCHIVE_TRACKS_INDEX
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index))


def test_run_export_writes_the_summary_for_tracks_in_target_year_and_no_per_hex_blob(tmp_path):
    import h3

    settings = _settings(tmp_path)
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    assert len(set(cells)) == 2
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert set(fires) == {"fire-2026"}
    assert fires["fire-2026"]["area_km2"] > 0
    state = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    assert state["fire-2026"]["year"] == 2026
    # The web packs the shape from the summary; the 57 MB per-hex file is gone.
    assert not (settings.out_dir / "archive" / "blob_2026.json").exists()

def test_run_export_skips_tracks_outside_target_year(tmp_path):
    import h3

    settings = _settings(tmp_path)
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2025": _track_body("fire-2025", cells, "2025-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    assert json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text()) == {}
    state = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    assert state["fire-2025"]["year"] == 2025  # inspected and remembered, just not in this year's summary

def test_run_export_does_not_reprocess_unchanged_digest(tmp_path, monkeypatch):
    import h3

    settings = _settings(tmp_path)
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    calls = []
    import pipeline.export_scale_blob as mod

    original = mod.year_of_track

    def spy(body):
        calls.append(body["id"])
        return original(body)

    monkeypatch.setattr(mod, "year_of_track", spy)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    assert calls == []  # unchanged digest, never re-inspected


def test_run_export_reprocesses_a_track_whose_summary_never_landed(tmp_path):
    """Self-heals a partial PUBLISH, which the local write ordering cannot cover.

    Locally the summary is written before the state, so a crash between the
    two only ever under-claims. The R2 boundary has no ordering at all:
    publish() uploads archive/ through an unordered ThreadPoolExecutor, so
    scale_blob_state.json can land in the bucket while blob_{year}_fires.json
    does not. hydrate() then restores a state marking the track processed with
    no summary entry for it — and since only a DIGEST CHANGE ever reprocesses a
    track, that fire would be missing permanently.
    """
    import h3

    settings = _settings(tmp_path)
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)
    index = json.loads((settings.out_dir / ARCHIVE_TRACKS_INDEX).read_text())

    # Exactly what a half-finished publish leaves behind: state says done at the
    # CURRENT digest (so nothing would re-trigger it), summary has no entry.
    state_path = settings.out_dir / SCALE_BLOB_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "fire-2026": {"digest": index["fire-2026"], "year": 2026},
        # A different year, and no longer in the index at all: reconciliation
        # must leave it alone. Dropping every stateful entry absent from THIS
        # year's summary would re-fetch every past year's track body forever.
        "fire-2025-retired": {"digest": "whatever", "year": 2025},
    }))
    fires_path = settings.out_dir / scale_blob_fires_key(2026)
    fires_path.write_text(json.dumps({}))

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    assert set(json.loads(fires_path.read_text())) == {"fire-2026"}, "the orphaned track must come back"
    state_final = json.loads(state_path.read_text())
    assert state_final["fire-2026"]["year"] == 2026
    assert "fire-2025-retired" in state_final  # other years untouched

def test_run_export_recovers_from_crash_between_summary_and_state_write(tmp_path, monkeypatch):
    """Simulates a crash between the blob_{year}_fires.json write and the
    scale_blob_state.json write. The summary write must survive, the state
    write must not have happened, and a subsequent run must safely reprocess
    the affected track."""
    import h3

    settings = _settings(tmp_path)
    cells_a = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks_a = {"fire-a": _track_body("fire-a", cells_a, "2026-01-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_a)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    state_path = settings.out_dir / SCALE_BLOB_STATE_KEY
    fires_path = settings.out_dir / scale_blob_fires_key(2026)
    state_before_crash = json.loads(state_path.read_text())
    assert "fire-a" in state_before_crash

    cells_b = [h3.latlng_to_cell(46.0, 6.0, 8)]
    tracks_b = {**tracks_a, "fire-b": _track_body("fire-b", cells_b, "2026-02-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_b)

    import pipeline.export_scale_blob as mod

    original_save_json = mod._save_json

    def crash_on_state_write(path, data):
        if path == state_path:
            raise RuntimeError("simulated crash before state write completes")
        original_save_json(path, data)

    monkeypatch.setattr(mod, "_save_json", crash_on_state_write)

    with pytest.raises(RuntimeError, match="simulated crash"):
        run_export(settings, target_year=2026, client=None, r2_bucket=None)

    # Summary write succeeded and now has fire-b...
    assert "fire-b" in json.loads(fires_path.read_text())
    # ...but the state write never completed, so fire-b is NOT marked processed.
    assert json.loads(state_path.read_text()) == state_before_crash

    monkeypatch.setattr(mod, "_save_json", original_save_json)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    assert set(json.loads(fires_path.read_text())) == {"fire-a", "fire-b"}
    state_final = json.loads(state_path.read_text())
    assert state_final["fire-b"]["year"] == 2026

def _write_places(settings: Settings, rows: list[tuple[str, float, float, str]]) -> None:
    places_dir = settings.data_dir / "places"
    places_dir.mkdir(parents=True, exist_ok=True)
    lines = []
    for name, lat, lon, country in rows:
        lines.append(f"1\t{name}\t{name}\t\t{lat}\t{lon}\tP\tPPL\t{country}\t\t\t\t\t\t1000\t\t\t")
    (places_dir / "cities5000.txt").write_text("\n".join(lines) + "\n")


def test_run_export_attributes_country_from_the_gazetteer(tmp_path):
    import h3

    settings = _settings(tmp_path)
    _write_places(settings, [("Nearby", 45.001, 5.001, "FR")])
    cells = [h3.latlng_to_cell(45.0, 5.0, 8), h3.latlng_to_cell(45.001, 5.001, 8)]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert fires["fire-2026"]["country"] == "FR"
    assert fires["fire-2026"]["area_km2"] > 0


def test_run_export_leaves_country_none_when_no_place_is_within_range(tmp_path):
    import h3

    settings = _settings(tmp_path)
    _write_places(settings, [("FarAway", 10.0, 10.0, "XX")])  # thousands of km away
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert fires["fire-2026"]["country"] is None


def test_run_export_area_km2_matches_the_sum_of_real_cell_areas(tmp_path):
    import h3

    settings = _settings(tmp_path)
    # grid_disk, not two nearby lat/lngs — see the comment on the
    # writes-blob test above: 45.000,5.000 and 45.001,5.001 collide into the
    # SAME res-8 cell, which would make this a 1-cell, not 2-cell, fixture.
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    assert len(set(cells)) == 2
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    expected = round(sum(h3.cell_area(c, unit="km^2") for c in cells), 1)
    assert fires["fire-2026"]["area_km2"] == expected


def test_run_export_area_km2_does_not_double_count_parent_child_cells(tmp_path):
    """A track's cells can legitimately include both a coarse Meteosat cell
    and the finer VIIRS cells nested inside it (design spec: 'What can still
    overlap: a single fire's own mixed-resolution cells'). Summing raw
    h3.cell_area over both double-counts the same physical ground."""
    import h3

    settings = _settings(tmp_path)
    parent = h3.latlng_to_cell(45.0, 5.0, 7)
    children = h3.cell_to_children(parent, 8)
    cells = [parent, *children]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    true_area = round(h3.cell_area(parent, unit="km^2"), 1)  # children exactly tile the parent
    assert fires["fire-2026"]["area_km2"] == true_area


def test_run_export_stops_early_when_the_time_budget_runs_out(tmp_path):
    """A cold start against a large real archive (19,347 tracks in prod, as
    of the first production run) can't fetch every track body serially
    within a single CI job's timeout. run_export must make partial progress
    and stop cleanly rather than get killed mid-loop with nothing written —
    a hard process kill can't be caught by the _safe() wrapper in
    scripts/refresh_remote.py, so the guard has to live inside run_export
    itself."""
    import h3

    settings = _settings(tmp_path)
    tracks = {}
    for i in range(5):
        cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0 + i, 5.0, 8), 1))[:2]
        tracks[f"fire-{i}"] = _track_body(f"fire-{i}", cells, "2026-06-01T00:00:00+00:00")
    _make_local_archive(settings.out_dir, tracks)

    # A fake clock that reports elapsed time past the budget after the 3rd
    # track's processing has started (deadline check happens once per
    # iteration, before that track's own work).
    calls = {"n": 0}

    def fake_clock() -> float:
        calls["n"] += 1
        return 0.0 if calls["n"] <= 3 else 1000.0  # first few calls "before deadline"

    run_export(settings, target_year=2026, client=None, r2_bucket=None, time_budget_s=500.0, clock=fake_clock)

    state = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    processed = len(state)
    assert 0 < processed < 5, f"expected partial progress, got {processed} of 5 processed"

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert set(fires) == set(state.keys()), "every processed fire must be in the summary"

    # A second run, unbudgeted, must pick up exactly the tracks the first
    # run didn't get to — nothing is lost, nothing is silently skipped.
    run_export(settings, target_year=2026, client=None, r2_bucket=None)
    state_final = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    assert set(state_final.keys()) == set(tracks.keys())


def test_a_fire_the_state_files_under_another_year_leaves_this_years_summary(tmp_path):
    # January: a fire in blob_2026_fires is re-archived with its last bin in
    # 2027. The fast tier's 2027 pass re-reads it first and records it as 2027;
    # the 2026 pass then sees an unchanged digest and would never look at it
    # again — leaving it in both years' summaries. The state is authoritative.
    import h3

    settings = _settings(tmp_path)
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    _make_local_archive(settings.out_dir, {"fire-x": _track_body("fire-x", cells, "2026-12-30T00:00:00+00:00")})
    run_export(settings, target_year=2026, client=None, r2_bucket=None)
    assert set(json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())) == {"fire-x"}

    _make_local_archive(settings.out_dir, {"fire-x": _track_body("fire-x", cells, "2027-01-02T00:00:00+00:00")})
    run_export(settings, target_year=2027, client=None, r2_bucket=None)  # fast tier, first
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    assert "fire-x" not in json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert set(json.loads((settings.out_dir / scale_blob_fires_key(2027)).read_text())) == {"fire-x"}
