"""Incremental track publishing.

publish was 74% of every refresh and ~98.7% of what it uploaded was
byte-identical to what the bucket already held (measured across
gen-20260805T100327Z and gen-20260805T101433Z: 12390 of 12556 events had
identical cells, and 19 of 19 sampled track files were byte-identical).

Unlike the hydrate case those objects are NOT waste — the site fetches
tracks/<id>.json per fire on click — so they must stay reachable. Only the
re-uploading is waste.
"""
from __future__ import annotations

import json
from datetime import timedelta

from pipeline.config import GENERATIONS_KEPT, TRACK_MAP, TRACK_REWRITE_EVERY, load_settings
from pipeline.export import export, validate_generation
from pipeline.events import cluster
from tests.synth import T, hs


def _settings(tmp_path):
    return load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})


def _fires(n: int, t):
    """n well-separated fires, so clustering keeps them distinct."""
    return [hs(40.0 + i * 0.5, 5.0 + i * 0.5, t) for i in range(n)]


def _gen_of(gen, eid: str) -> str:
    return json.loads((gen / "events.geojson").read_text()) and next(
        f["properties"]["track_gen"]
        for f in json.loads((gen / "events.geojson").read_text())["features"]
        if f["properties"]["id"] == eid
    )


def test_every_feature_points_at_a_generation_that_holds_its_track(tmp_path):
    """The whole contract in one assertion. `loadTrack` swallows failures, so a
    pointer at a missing object shows up as a card without its sparkline and
    nothing in the console — it has to be caught here."""
    s = _settings(tmp_path)
    ev = cluster(_fires(6, T(20, 0)), now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))

    fc = json.loads((gen / "events.geojson").read_text())
    assert fc["features"], "no features to check"
    for f in fc["features"]:
        p = f["properties"]
        assert "track_gen" in p, "feature carries no track_gen"
        track = s.out_dir / p["track_gen"] / "tracks" / f"{p['id']}.json"
        assert track.exists(), f"track_gen points at a missing object: {track}"


def test_an_unchanged_track_is_not_rewritten(tmp_path):
    """The point of the change: a second publish of identical data must not
    write the track again, and must keep pointing at the generation that has
    it."""
    s = _settings(tmp_path)
    hots = _fires(6, T(20, 0))
    ev = cluster(hots, now=T(20, 12))
    gen1 = export(s, ev, {}, [], [], now=T(20, 12))
    first = {p.name for p in (gen1 / "tracks").glob("*.json")}
    assert first, "first generation wrote no tracks"

    # Same events, next generation. Nothing changed, so nothing should be
    # written — except whatever the aged-rewrite bucket happens to select.
    gen2 = export(s, ev, {}, [], [], now=T(20, 13))
    second = {p.name for p in (gen2 / "tracks").glob("*.json")}
    assert len(second) < len(first), "every track was rewritten unchanged"

    fc = json.loads((gen2 / "events.geojson").read_text())
    carried = [
        f for f in fc["features"] if f["properties"]["track_gen"] == gen1.name
    ]
    assert carried, "no feature carried a pointer back to the older generation"
    for f in carried:
        assert (gen1 / "tracks" / f"{f['properties']['id']}.json").exists()


def test_a_changed_track_is_rewritten_into_the_new_generation(tmp_path):
    s = _settings(tmp_path)
    hots = _fires(6, T(20, 0))
    ev1 = cluster(hots, now=T(20, 12))
    export(s, ev1, {}, [], [], now=T(20, 12))

    # One fire grows: a new detection in the same cluster changes its track.
    grown = hots + [hs(40.0, 5.002, T(20, 6))]
    ev2 = cluster(grown, now=T(20, 13))
    gen2 = export(s, ev2, {}, [], [], now=T(20, 13))

    fc = json.loads((gen2 / "events.geojson").read_text())
    changed = [f for f in fc["features"] if f["properties"]["cum_cells"] > 1]
    assert changed, "no fire actually grew — fixture is wrong"
    for f in changed:
        p = f["properties"]
        assert p["track_gen"] == gen2.name, "a changed track kept an old pointer"
        assert (gen2 / "tracks" / f"{p['id']}.json").exists()


def test_only_reachable_tracks_are_written(tmp_path):
    """Track ids reach the client solely through events.geojson features
    (web/src/firecard.ts:344). events.geojson drops events older than
    RECENT_DAYS, so tracks for those are unreachable — on the measured
    generation that was 2730 of 12556 objects published for nothing."""
    s = _settings(tmp_path)
    old = hs(40.0, 5.0, T(11, 0))      # 9 days back: clustered, but past RECENT_DAYS
    new = hs(45.0, 9.0, T(20, 0))
    ev = cluster([old, new], now=T(20, 12))
    assert len(ev) == 2, "fixture should hold one stale and one fresh event"
    gen = export(s, ev, {}, [], [], now=T(20, 12))

    shown = {f["properties"]["id"] for f in json.loads((gen / "events.geojson").read_text())["features"]}
    written = {p.stem for p in (gen / "tracks").glob("*.json")}
    assert len(shown) == 1, "the stale event should not be in events.geojson"
    assert written <= shown, f"wrote unreachable tracks: {written - shown}"


def test_the_index_still_covers_every_event_not_just_the_reachable_ones(tmp_path):
    """tracks_index.json feeds the merge lineage, which looks for events that
    have DISAPPEARED. Shrinking it to the reachable set would silently drop
    merges for events that aged out of events.geojson but are still clustered."""
    s = _settings(tmp_path)
    old = hs(40.0, 5.0, T(11, 0))
    new = hs(45.0, 9.0, T(20, 0))
    ev = cluster([old, new], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))

    index = json.loads((gen / "tracks_index.json").read_text())
    assert set(index) == set(ev), "index no longer mirrors the full event set"


def test_the_aged_rewrite_spreads_instead_of_stampeding(tmp_path):
    """"Rewrite when older than N" alone has a thundering herd: on run 1 every
    track originates in the same generation, so all of them age out on the same
    later run and it pays the full old cost. Bucketing on a stable hash of the
    id spreads ~1/N across every run from run 1."""
    s = _settings(tmp_path)
    ev = cluster(_fires(40, T(20, 0)), now=T(20, 12))
    export(s, ev, {}, [], [], now=T(20, 12))

    counts = []
    for i in range(1, TRACK_REWRITE_EVERY + 1):
        gen = export(s, ev, {}, [], [], now=T(20, 12) + timedelta(hours=i))
        counts.append(len(list((gen / "tracks").glob("*.json"))))

    total = len(json.loads((s.out_dir / "manifest.json").read_text()) and ev)
    assert max(counts) < total, f"a run rewrote everything: {counts}"
    # Over N generations every track must be refreshed at least once, or the
    # retention bound does not hold.
    assert sum(counts) >= total, f"tracks went un-refreshed over N runs: {counts}"


def test_a_corrupt_track_map_is_refused_before_publish(tmp_path):
    """Same asymmetry as tracks_index.json. Absent means "rewrite everything",
    which is safe and merely slow. Present but unparseable would be trusted."""
    s = _settings(tmp_path)
    ev = cluster(_fires(3, T(20, 0)), now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))
    assert validate_generation(gen) == []

    (gen / TRACK_MAP).write_text("{not json")
    assert validate_generation(gen) == [f"invalid json: {TRACK_MAP}"]

    (gen / TRACK_MAP).unlink()
    assert validate_generation(gen) == []


def test_pointers_survive_pruning_over_many_generations(tmp_path):
    """THE invariant, and the only test that can catch a prune/age mismatch.

    A track lives in whichever generation last wrote it. Prune deletes old
    generations. If a track can go longer un-rewritten than prune keeps, a
    pointer outlives its object and the fire card loses its sparkline —
    silently, since loadTrack swallows the failure.
    """
    from pipeline.export import prune_generations

    s = _settings(tmp_path)
    ev = cluster(_fires(25, T(20, 0)), now=T(20, 12))

    for i in range(25):
        gen = export(s, ev, {}, [], [], now=T(20, 0) + timedelta(hours=i))
        prune_generations(s.out_dir)   # default retention, as production uses

        fc = json.loads((gen / "events.geojson").read_text())
        for f in fc["features"]:
            p = f["properties"]
            track = s.out_dir / p["track_gen"] / "tracks" / f"{p['id']}.json"
            assert track.exists(), (
                f"generation {i}: {p['id']} points at {p['track_gen']}, pruned away"
            )
