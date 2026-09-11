import json
from pathlib import Path

import pytest

from pipeline.config import (
    ARCHIVE_TRACKS_INDEX,
    SCALE_BLOB_STATE_KEY,
    Settings,
    scale_blob_fires_key,
    scale_blob_key,
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


def test_run_export_writes_blob_for_tracks_in_target_year(tmp_path):
    import h3

    settings = _settings(tmp_path)
    # grid_disk, not two nearby lat/lngs: 45.000,5.000 and 45.001,5.001 land
    # in the SAME res-8 cell (see the comment on the crash-recovery test
    # below), which would make len(blob) == 2 fail against a 1-cell fixture.
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    assert len(set(cells)) == 2
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    assert len(blob) == 2
    assert all(cell["fire_id"] == "fire-2026" for cell in blob)
    assert all(len(cell["vertices_m"]) >= 5 for cell in blob)

    state = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    assert state["fire-2026"]["year"] == 2026


def test_run_export_skips_tracks_outside_target_year(tmp_path):
    import h3

    settings = _settings(tmp_path)
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2025": _track_body("fire-2025", cells, "2025-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    assert blob == []
    state = json.loads((settings.out_dir / SCALE_BLOB_STATE_KEY).read_text())
    assert state["fire-2025"]["year"] == 2025  # inspected and remembered, just not in this year's blob


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


def test_run_export_second_new_fire_never_moves_or_overlaps_the_first(tmp_path):
    import h3

    settings = _settings(tmp_path)
    cells_a = [h3.latlng_to_cell(45.0, 5.0, 8)]
    cells_b = [h3.latlng_to_cell(46.0, 6.0, 8)]  # far away geographically, but packing is position-independent
    tracks_a = {"fire-a": _track_body("fire-a", cells_a, "2026-01-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_a)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob_after_a = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    fire_a_before = [cell["vertices_m"] for cell in blob_after_a if cell["fire_id"] == "fire-a"]

    tracks_b = {**tracks_a, "fire-b": _track_body("fire-b", cells_b, "2026-02-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_b)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    by_fire: dict[str, list] = {}
    for cell in blob:
        by_fire.setdefault(cell["fire_id"], []).append(cell["vertices_m"])

    # fire-a, already published, must not have been repacked or moved by
    # fire-b's arrival — a spiral fill only ever appends.
    assert by_fire["fire-a"] == fire_a_before

    # No two hexes (from either fire) share a position — a gap-free spiral
    # fill is collision-free by construction; this confirms it held here.
    def centroid(poly):
        return (round(sum(x for x, _ in poly) / len(poly), 3), round(sum(y for _, y in poly) / len(poly), 3))

    all_centroids = [centroid(poly) for polys in by_fire.values() for poly in polys]
    assert len(set(all_centroids)) == len(all_centroids)


def test_run_export_reprocesses_a_track_whose_cells_never_reached_the_blob(tmp_path):
    """Self-heals a partial PUBLISH, which the local write ordering cannot cover.

    Locally the blob is written before the state, so a crash between the two
    only ever under-claims. The R2 boundary has no ordering at all: publish()
    uploads archive/ through an unordered ThreadPoolExecutor, so
    scale_blob_state.json can land in the bucket while blob_{year}.json does
    not. hydrate() then restores a state marking the track processed with no
    geometry to show for it — and since only a DIGEST CHANGE ever reprocesses a
    track, that fire would be missing from the blob permanently.
    """
    import h3

    settings = _settings(tmp_path)
    # grid_disk, not two nearby lat/lngs: 45.000,5.000 and 45.001,5.001 land in
    # the SAME res-8 cell, which would make the no-duplicates assertion below
    # fail against a fixture that was duplicated to begin with.
    cells = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 1))[:2]
    assert len(set(cells)) == 2
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)
    index = json.loads((settings.out_dir / ARCHIVE_TRACKS_INDEX).read_text())

    # Exactly what a half-finished publish leaves behind: state says done at the
    # CURRENT digest (so nothing would re-trigger it), blob has none of its cells.
    state_path = settings.out_dir / SCALE_BLOB_STATE_KEY
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "fire-2026": {"digest": index["fire-2026"], "year": 2026},
        # A different year, and no longer in the index at all: reconciliation
        # must leave it alone. Dropping every stateful entry with no cells in
        # THIS year's blob would re-fetch every past year's track body forever.
        "fire-2025-retired": {"digest": "whatever", "year": 2025},
    }))
    blob_path = settings.out_dir / scale_blob_key(2026)
    blob_path.parent.mkdir(parents=True, exist_ok=True)
    blob_path.write_text(json.dumps([]))

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob = json.loads(blob_path.read_text())
    assert {cell["fire_id"] for cell in blob} == {"fire-2026"}, "the orphaned track must come back"
    assert len(blob) == len(cells)
    assert len({cell["cell_id"] for cell in blob}) == len(cells)  # no duplicates from the redo

    state_final = json.loads(state_path.read_text())
    assert state_final["fire-2026"]["year"] == 2026
    assert "fire-2025-retired" in state_final  # other years untouched


def test_run_export_recovers_from_crash_between_blob_and_state_write(tmp_path, monkeypatch):
    """Simulates a crash between the blob_{year}.json write and the
    scale_blob_state.json write (export_scale_blob.py:107-108). The blob
    write must survive, the state write must not have happened, and a
    subsequent run must safely reprocess the affected track without
    duplicating or corrupting its cells."""
    import h3

    settings = _settings(tmp_path)
    cells_a = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks_a = {"fire-a": _track_body("fire-a", cells_a, "2026-01-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_a)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    state_path = settings.out_dir / SCALE_BLOB_STATE_KEY
    blob_path = settings.out_dir / scale_blob_key(2026)
    state_before_crash = json.loads(state_path.read_text())
    assert "fire-a" in state_before_crash

    cells_b = [h3.latlng_to_cell(46.0, 6.0, 8)]  # far from fire-a; packing is position-independent
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

    # Blob write succeeded and now contains fire-b's cells...
    blob_after_crash = json.loads(blob_path.read_text())
    fire_ids_after_crash = {cell["fire_id"] for cell in blob_after_crash}
    assert "fire-b" in fire_ids_after_crash

    # ...but the state write never completed, so fire-b is NOT marked processed.
    state_after_crash = json.loads(state_path.read_text())
    assert "fire-b" not in state_after_crash
    assert state_after_crash == state_before_crash  # untouched by the aborted write

    monkeypatch.setattr(mod, "_save_json", original_save_json)

    # Next run (state file unmutated from before the crash) must safely reprocess fire-b.
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob_final = json.loads(blob_path.read_text())
    fire_b_cells = [cell for cell in blob_final if cell["fire_id"] == "fire-b"]
    assert len(fire_b_cells) == len(cells_b)  # no duplication from the crashed attempt
    assert len({cell["cell_id"] for cell in fire_b_cells}) == len(fire_b_cells)  # no corrupted repeats

    state_final = json.loads(state_path.read_text())
    assert "fire-b" in state_final
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


def test_run_export_fires_summary_reconciles_like_the_blob(tmp_path):
    """A partial publish could land scale_blob_state.json with a track marked
    processed while blob_{year}_fires.json never made it (same R2-boundary risk
    the cell blob already self-heals from). A state entry with no corresponding
    fires-summary entry must also be treated as unprocessed."""
    import h3

    settings = _settings(tmp_path)
    cells = [h3.latlng_to_cell(45.0, 5.0, 8)]
    tracks = {"fire-2026": _track_body("fire-2026", cells, "2026-06-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks)
    index = json.loads((settings.out_dir / ARCHIVE_TRACKS_INDEX).read_text())

    # Simulate: blob + state already written for this track, but the fires
    # summary never landed (a partial publish).
    (settings.out_dir / scale_blob_key(2026)).parent.mkdir(parents=True, exist_ok=True)
    (settings.out_dir / scale_blob_key(2026)).write_text(json.dumps(
        [{"fire_id": "fire-2026", "cell_id": cells[0], "res": 8, "vertices_m": [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 1.5]]}]
    ))
    (settings.out_dir / SCALE_BLOB_STATE_KEY).parent.mkdir(parents=True, exist_ok=True)
    (settings.out_dir / SCALE_BLOB_STATE_KEY).write_text(json.dumps(
        {"fire-2026": {"digest": index["fire-2026"], "year": 2026}}
    ))

    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    fires = json.loads((settings.out_dir / scale_blob_fires_key(2026)).read_text())
    assert "fire-2026" in fires  # reprocessed, not left permanently missing


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


def test_run_export_reprocessing_a_middle_fire_does_not_overlap_a_later_untouched_fire(tmp_path):
    """start_index for newly-(re)packed fires must be the true highest
    occupied spiral position, not a sum of currently-tracked fires' hex
    counts — summing undercounts whenever a fire earlier in the spiral gets
    reprocessed (a digest change, an expected occurrence per the design doc)
    while a fire packed after it is left untouched: the untouched fire's
    cells no longer correspond to a contiguous range starting at 0, so a
    naive sum silently reuses positions it still occupies."""
    import h3

    settings = _settings(tmp_path)
    # fire-a: enough cells to be packed first (larger fires are placed
    # first in a fresh batch) and to leave room for a real collision if
    # start_index is wrong. fire-c: packed after fire-a, in a later run,
    # never touched again.
    cells_a = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 2))[:5]
    cells_c = sorted(h3.grid_disk(h3.latlng_to_cell(50.0, 10.0, 8), 2))[:4]
    tracks_a = {"fire-a": _track_body("fire-a", cells_a, "2026-01-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_a)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    tracks_ac = {**tracks_a, "fire-c": _track_body("fire-c", cells_c, "2026-02-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_ac)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob_before = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    fire_c_before = [cell["vertices_m"] for cell in blob_before if cell["fire_id"] == "fire-c"]

    # fire-a's content changes (grew/corrected) — same track id, different
    # cells, so a new digest. fire-c is untouched.
    cells_a_grown = sorted(h3.grid_disk(h3.latlng_to_cell(45.0, 5.0, 8), 2))[:8]
    tracks_grown = {
        "fire-a": _track_body("fire-a", cells_a_grown, "2026-01-02T00:00:00+00:00"),
        "fire-c": tracks_ac["fire-c"],
    }
    _make_local_archive(settings.out_dir, tracks_grown)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    blob_after = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    by_fire: dict[str, list] = {}
    for cell in blob_after:
        by_fire.setdefault(cell["fire_id"], []).append(cell["vertices_m"])

    # fire-c, never touched, must be byte-for-byte unchanged.
    assert by_fire["fire-c"] == fire_c_before

    def centroid(poly):
        return (round(sum(x for x, _ in poly) / len(poly), 3), round(sum(y for _, y in poly) / len(poly), 3))

    all_centroids = [centroid(poly) for polys in by_fire.values() for poly in polys]
    assert len(set(all_centroids)) == len(all_centroids), "repacked fire-a must not collide with untouched fire-c"
