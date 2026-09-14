"""Permanent per-scar footprint archive: what lets an EFFIS-sourced past-scar
card show its real burned-area polygon on the map, instead of nothing (EFFIS
scars carry no track_gen/cell_bins — see pipeline/fetch_effis.py). Mirrors
pipeline/archive_tracks.py's permanent, id-keyed, write-once archive."""
import json
from pathlib import Path

from pipeline.archive_footprints import (
    archive_effis_footprints,
    previous_footprints_index,
    stamp_footprint_flags,
)


def _scar(sid="562583", geometry=None):
    return {
        "id": sid,
        "geometry": geometry or {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
    }


def test_writes_a_footprint_for_a_scar_with_geometry(tmp_path):
    out = tmp_path / "out"

    index = archive_effis_footprints(out, [_scar()], prev_index={})

    assert index["562583"]
    body = json.loads((out / "archive" / "footprints" / "562583.json").read_text())
    assert body["type"] == "Feature"
    assert body["properties"]["id"] == "562583"
    assert body["geometry"]["type"] == "Polygon"


def test_scar_without_geometry_is_not_archived(tmp_path):
    out = tmp_path / "out"
    scar = {"id": "999", "geometry": None}

    index = archive_effis_footprints(out, [scar], prev_index={})

    assert "999" not in index
    assert not (out / "archive" / "footprints" / "999.json").exists()


def test_a_traversal_id_is_never_archived(tmp_path):
    """EFFIS is an external feed (fetch_effis_season.py's _rows_from_records
    relays `id` verbatim, with no format check) — a malicious or malformed id
    must never be trusted to build a filesystem path."""
    out = tmp_path / "out"
    scar = _scar(sid="../../../../tmp/evil")

    index = archive_effis_footprints(out, [scar], prev_index={})

    assert "../../../../tmp/evil" not in index
    assert not (out.parent / "tmp" / "evil.json").exists()
    assert not any((out / "archive").rglob("evil.json"))


def test_an_absolute_path_id_is_never_archived(tmp_path):
    out = tmp_path / "out"
    scar = _scar(sid="/tmp/evil")

    index = archive_effis_footprints(out, [scar], prev_index={})

    assert "/tmp/evil" not in index
    assert not Path("/tmp/evil.json").exists()


def test_unchanged_footprint_is_not_rewritten_on_a_later_run(tmp_path):
    out = tmp_path / "out"
    index = archive_effis_footprints(out, [_scar()], prev_index={})
    path = out / "archive" / "footprints" / "562583.json"
    path.write_text('{"sentinel": true}')

    index2 = archive_effis_footprints(out, [_scar()], prev_index=index)

    assert index2 == index
    assert json.loads(path.read_text()) == {"sentinel": True}


def test_previous_footprints_index_round_trips(tmp_path):
    out = tmp_path / "out"
    written = archive_effis_footprints(out, [_scar()], prev_index={})

    assert previous_footprints_index(out) == written


def test_previous_footprints_index_is_empty_on_a_cold_start(tmp_path):
    assert previous_footprints_index(tmp_path / "out") == {}


def test_previous_footprints_index_tolerates_a_non_dict_body(tmp_path):
    out = tmp_path / "out"
    from pipeline.config import ARCHIVE_FOOTPRINTS_INDEX
    path = out / ARCHIVE_FOOTPRINTS_INDEX
    path.parent.mkdir(parents=True)

    path.write_text("null")
    assert previous_footprints_index(out) == {}

    path.write_text("[1, 2, 3]")
    assert previous_footprints_index(out) == {}


def test_previous_footprints_index_tolerates_invalid_utf8(tmp_path):
    out = tmp_path / "out"
    from pipeline.config import ARCHIVE_FOOTPRINTS_INDEX
    path = out / ARCHIVE_FOOTPRINTS_INDEX
    path.parent.mkdir(parents=True)
    path.write_bytes(b'{"e1": "abc\xff\xfe')

    assert previous_footprints_index(out) == {}


def test_stamp_footprint_flags_marks_an_archived_scar(tmp_path):
    """The public scar dict (what ends up in manifest.imagery.scars) must
    never carry the raw geometry — only a boolean flag web/src/firecard.ts's
    openScar uses to decide whether to fetch the archived polygon."""
    scars = [_scar("562583")]
    index = archive_effis_footprints(tmp_path / "out", scars, prev_index={})

    stamp_footprint_flags(scars, index)

    assert scars[0]["footprint"] is True
    assert "geometry" not in scars[0]


def test_stamp_footprint_flags_leaves_an_unarchived_scar_alone(tmp_path):
    """A scar whose geometry failed to archive (or never had one) gets no
    footprint flag — openScar must not try to fetch a file that was never
    written."""
    scar = {"id": "999", "geometry": None}

    stamp_footprint_flags([scar], index={})

    assert "footprint" not in scar
    assert "geometry" not in scar
