import json
from pathlib import Path

from pipeline.config import ARCHIVE_TRACKS_INDEX, SCALE_BLOB_STATE_KEY, Settings, scale_blob_key
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
    cells = [h3.latlng_to_cell(45.0, 5.0, 8), h3.latlng_to_cell(45.001, 5.001, 8)]
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


def test_run_export_second_new_fire_does_not_overlap_first(tmp_path):
    import h3

    settings = _settings(tmp_path)
    cells_a = [h3.latlng_to_cell(45.0, 5.0, 8)]
    cells_b = [h3.latlng_to_cell(46.0, 6.0, 8)]  # far away geographically, but packing is position-independent
    tracks_a = {"fire-a": _track_body("fire-a", cells_a, "2026-01-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_a)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    tracks_b = {**tracks_a, "fire-b": _track_body("fire-b", cells_b, "2026-02-01T00:00:00+00:00")}
    _make_local_archive(settings.out_dir, tracks_b)
    run_export(settings, target_year=2026, client=None, r2_bucket=None)

    from pipeline.pack_blob import bounding_box, boxes_overlap

    blob = json.loads((settings.out_dir / scale_blob_key(2026)).read_text())
    by_fire: dict[str, list] = {}
    for cell in blob:
        by_fire.setdefault(cell["fire_id"], []).append(cell["vertices_m"])
    box_a = bounding_box(by_fire["fire-a"])
    box_b = bounding_box(by_fire["fire-b"])
    assert not boxes_overlap(box_a, box_b)
