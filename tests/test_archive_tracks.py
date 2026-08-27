"""Permanent per-fire track archive: what lets a past-scar card show the same
H3 arrival-footprint detail an active fire's card shows, without keeping every
generation around for the 45-day scar lookback window (see
pipeline/config.py's ARCHIVE_TRACKS_INDEX comment for why that would be
prohibitively expensive)."""
import json

from pipeline.archive_tracks import archive_past_tracks, previous_archive_index
from pipeline.events import cluster
from tests.synth import T, hs


def _quiet_fire():
    """Two detections on day 1; a `now` three days later is well past
    ACTIVE_MAX_H (48h), so this fire is a "past" scar."""
    return cluster([hs(45.0, 8.0, T(1, 0)), hs(45.005, 8.0, T(1, 6))], now=T(1, 12))


def _active_fire():
    """Detections right up to `now` — still inside ACTIVE_MAX_H."""
    return cluster([hs(45.0, 8.0, T(1, 0)), hs(45.005, 8.0, T(1, 6))], now=T(1, 12))


def test_writes_a_track_for_a_fire_quiet_past_active_max_h(tmp_path):
    out = tmp_path / "out"
    scar_events = _quiet_fire()
    eid = next(iter(scar_events))

    index = archive_past_tracks(out, scar_events, now=T(4, 0), prev_index={})

    assert index[eid]
    body = json.loads((out / "archive" / "tracks" / f"{eid}.json").read_text())
    assert body["id"] == eid
    assert body["cell_bins"]  # the whole point: per-bin H3 cells for the footprint
    assert body["frp_live"] == []  # settled scar — no live MTG series to carry


def test_still_active_fire_is_not_archived(tmp_path):
    out = tmp_path / "out"
    scar_events = _active_fire()
    eid = next(iter(scar_events))

    # now == the fire's own last-detection instant: 0h quiet, well under 48h.
    index = archive_past_tracks(out, scar_events, now=T(1, 6), prev_index={})

    assert eid not in index
    assert not (out / "archive" / "tracks" / f"{eid}.json").exists()


def test_unchanged_fire_is_not_rewritten_on_a_later_run(tmp_path):
    """A genuinely closed fire's cells never change again — re-running the
    archiver against the same scar_events must not touch the file a second
    time. Proven by hand-planting a sentinel body and confirming it survives."""
    out = tmp_path / "out"
    scar_events = _quiet_fire()
    eid = next(iter(scar_events))

    index = archive_past_tracks(out, scar_events, now=T(4, 0), prev_index={})
    track_path = out / "archive" / "tracks" / f"{eid}.json"
    track_path.write_text('{"sentinel": true}')

    index2 = archive_past_tracks(out, scar_events, now=T(4, 6), prev_index=index)

    assert index2 == index
    assert json.loads(track_path.read_text()) == {"sentinel": True}


def test_changed_fire_content_is_rewritten(tmp_path):
    """Growing the same fire between runs (one more detection) must replace
    its archived track, since its digest changed."""
    out = tmp_path / "out"
    small = cluster([hs(45.0, 8.0, T(1, 0)), hs(45.005, 8.0, T(1, 6))], now=T(1, 12))
    eid = next(iter(small))
    index = archive_past_tracks(out, small, now=T(4, 0), prev_index={})

    grown = cluster(
        [hs(45.0, 8.0, T(1, 0)), hs(45.005, 8.0, T(1, 6)), hs(45.008, 8.0, T(1, 12))],
        now=T(1, 18),
    )
    assert next(iter(grown)) == eid  # same event, one more detection
    index2 = archive_past_tracks(out, grown, now=T(4, 0), prev_index=index)

    assert index2[eid] != index[eid]
    body = json.loads((out / "archive" / "tracks" / f"{eid}.json").read_text())
    assert len(body["series"]) == 3  # the grown fire's third 6h bin now on record


def test_previous_archive_index_round_trips(tmp_path):
    out = tmp_path / "out"
    scar_events = _quiet_fire()
    written = archive_past_tracks(out, scar_events, now=T(4, 0), prev_index={})

    assert previous_archive_index(out) == written


def test_previous_archive_index_is_empty_on_a_cold_start(tmp_path):
    assert previous_archive_index(tmp_path / "out") == {}
