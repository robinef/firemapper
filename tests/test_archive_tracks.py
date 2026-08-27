"""Permanent per-fire track archive: what lets a past-scar card show the same
H3 arrival-footprint detail an active fire's card shows, without keeping every
generation around for the 45-day scar lookback window (see
pipeline/config.py's ARCHIVE_TRACKS_INDEX comment for why that would be
prohibitively expensive)."""
import json

from pipeline.archive_tracks import archive_past_tracks, previous_archive_index
from pipeline.events import cluster
from tests.synth import T, hs


def _fire():
    """Four detections on day 1 — at MIN_MEMBERS, so it clears the speck
    filter. Whether this counts as "active" or "past" is entirely down to the
    `now` passed to archive_past_tracks — see the two tests below, which pass
    the same fixture through both branches."""
    return cluster([hs(45.0 + 0.005 * i, 8.0, T(1, 6 * i)) for i in range(4)], now=T(1, 18))


def test_writes_a_track_for_a_fire_quiet_past_active_max_h(tmp_path):
    out = tmp_path / "out"
    scar_events = _fire()
    eid = next(iter(scar_events))

    index = archive_past_tracks(out, scar_events, now=T(4, 0), prev_index={})

    assert index[eid]
    body = json.loads((out / "archive" / "tracks" / f"{eid}.json").read_text())
    assert body["id"] == eid
    assert body["cell_bins"]  # the whole point: per-bin H3 cells for the footprint
    assert body["frp_live"] == []  # settled scar — no live MTG series to carry


def test_still_active_fire_is_not_archived(tmp_path):
    out = tmp_path / "out"
    scar_events = _fire()
    eid = next(iter(scar_events))

    # now == the fire's own last-detection instant: 0h quiet, well under 48h.
    index = archive_past_tracks(out, scar_events, now=T(1, 18), prev_index={})

    assert eid not in index
    assert not (out / "archive" / "tracks" / f"{eid}.json").exists()


def test_unchanged_fire_is_not_rewritten_on_a_later_run(tmp_path):
    """A genuinely closed fire's cells never change again — re-running the
    archiver against the same scar_events must not touch the file a second
    time. Proven by hand-planting a sentinel body and confirming it survives."""
    out = tmp_path / "out"
    scar_events = _fire()
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
    small_members = [hs(45.0 + 0.005 * i, 8.0, T(1, 6 * i)) for i in range(4)]  # 4 distinct bins
    small = cluster(small_members, now=T(1, 18))
    eid = next(iter(small))
    index = archive_past_tracks(out, small, now=T(4, 0), prev_index={})

    # A 5th detection the next day — its own distinct bin, same event (well
    # within cluster()'s CLOSE_AFTER_H).
    grown = cluster(small_members + [hs(45.02, 8.0, T(2, 0))], now=T(2, 0))
    assert next(iter(grown)) == eid  # same event, one more detection
    index2 = archive_past_tracks(out, grown, now=T(5, 0), prev_index=index)

    assert index2[eid] != index[eid]
    body = json.loads((out / "archive" / "tracks" / f"{eid}.json").read_text())
    assert len(body["series"]) == 5  # the grown fire's fifth bin now on record


def test_previous_archive_index_round_trips(tmp_path):
    out = tmp_path / "out"
    scar_events = _fire()
    written = archive_past_tracks(out, scar_events, now=T(4, 0), prev_index={})

    assert previous_archive_index(out) == written


def test_previous_archive_index_is_empty_on_a_cold_start(tmp_path):
    assert previous_archive_index(tmp_path / "out") == {}


def test_previous_archive_index_tolerates_a_non_dict_body(tmp_path):
    """The archived-index file must never crash the run it protects — run.py
    relies on this as an unguarded fallback default (see run.py's comment on
    why the `default=` there cannot go through _safe's try/except)."""
    out = tmp_path / "out"
    from pipeline.config import ARCHIVE_TRACKS_INDEX
    path = out / ARCHIVE_TRACKS_INDEX
    path.parent.mkdir(parents=True)

    path.write_text("null")
    assert previous_archive_index(out) == {}

    path.write_text("[1, 2, 3]")
    assert previous_archive_index(out) == {}


def test_previous_archive_index_tolerates_invalid_utf8(tmp_path):
    """A truncated R2 download (hydrate() writes raw bytes with no
    validation) can land mid multi-byte UTF-8 sequence — read_text() raises
    UnicodeDecodeError, not json.JSONDecodeError. Must still never raise."""
    out = tmp_path / "out"
    from pipeline.config import ARCHIVE_TRACKS_INDEX
    path = out / ARCHIVE_TRACKS_INDEX
    path.parent.mkdir(parents=True)
    path.write_bytes(b'{"e1": "abc\xff\xfe')

    assert previous_archive_index(out) == {}


def test_a_speck_below_min_members_is_never_archived(tmp_path):
    """A single isolated detection never becomes a visible scar (build_scars'
    own MIN_MEMBERS filter drops it) — archiving it anyway would write a
    permanent file nothing ever reads, unbounded by how much sensor noise
    accumulates over time."""
    out = tmp_path / "out"
    speck = cluster([hs(45.0, 8.0, T(1, 0))], now=T(4, 0))  # 1 member, well past quiet
    eid = next(iter(speck))

    index = archive_past_tracks(out, speck, now=T(4, 0), prev_index={})

    assert eid not in index
    assert not (out / "archive" / "tracks" / f"{eid}.json").exists()
