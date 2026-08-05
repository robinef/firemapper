import json
import shutil
from datetime import timedelta

from pipeline.config import load_settings
from pipeline.events import cluster
from pipeline.events import METEOSAT_CELL_KM2
from pipeline.export import (
    _previous_ids_cells,
    export,
    prune_generations,
    size_class,
    validate_generation,
)
from pipeline.metrics import CELL_KM2
from tests.synth import T, hs


def _settings(tmp_path):
    return load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})


def test_export_writes_manifest_last_and_validates(tmp_path):
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    gen = export(s, ev, liveness={}, places=[], alerts=[], now=T(20, 12))
    man = json.loads((s.out_dir / "manifest.json").read_text())
    # Minor bumps must stay loadable by a 1.x client, so pin the MAJOR only.
    assert man["schema_version"].split(".")[0] == "1"
    assert man["generation"] == gen.name
    assert validate_generation(gen) == []
    fc = json.loads((gen / "events.geojson").read_text())
    f = fc["features"][0]["properties"]
    assert f["status"] == "active" and f["area_km2"] == 1.4
    assert (gen / f"tracks/{f['id']}.json").exists()


def test_partial_generation_never_published(tmp_path):
    s = _settings(tmp_path)
    bad = s.out_dir / "gen-partial"
    bad.mkdir(parents=True)
    (bad / "events.geojson").write_text("{not json")
    assert validate_generation(bad) != []
    assert not (s.out_dir / "manifest.json").exists()


def test_merge_lineage_vs_previous_generation(tmp_path):
    s = _settings(tmp_path)
    a, c = [hs(45.0, 8.0, T(20, 0))], [hs(45.012, 8.0, T(20, 6))]
    ev0 = cluster(a + c, now=T(20, 12))
    assert len(ev0) == 2
    export(s, ev0, {}, [], [], now=T(20, 12))
    ev1 = cluster(a + c + [hs(45.005, 8.0, T(20, 12))], now=T(21, 0))
    assert len(ev1) == 1
    gen = export(s, ev1, {}, [], [], now=T(21, 0))
    lineage = json.loads((gen / "lineage.json").read_text())
    gone = set(ev0) - set(ev1)
    assert len(gone) == 1
    assert lineage["merged"] == {gone.pop(): next(iter(ev1))}


def test_prune_keeps_three(tmp_path):
    s = _settings(tmp_path)
    for i in range(5):
        (s.out_dir / f"gen-2026072{i}T000000Z").mkdir(parents=True)
    prune_generations(s.out_dir, keep=3)
    assert len(list(s.out_dir.glob("gen-*"))) == 3


def test_publishes_after_two_consecutive_upstream_failures(tmp_path):
    """The 2026-07-31 prod freeze, end to end.

    EUMETView 400s, so frp fails and wind (sampled AT the fire pixels) inherits
    the failure. Run 1 has no carry source in budget, so it publishes both as
    failed and writes no wind.geojson. Run 2 must still publish: the only carry
    candidate is run 1's own FAILED wind layer, which holds nothing to copy.
    Judging that carryable is what made export refuse the whole generation and
    froze the live map for hours over one upstream fault.
    """
    from pipeline.fetch_result import FetchResult

    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    failed = lambda t: FetchResult("failed", [], t)  # noqa: E731

    gen1 = export(
        s, ev, {}, [], [], now=T(20, 12),
        results={"frp": failed(T(20, 12)), "wind": failed(T(20, 12))},
    )
    man1 = json.loads((s.out_dir / "manifest.json").read_text())
    assert man1["layers"]["wind"]["status"] == "failed"
    assert (gen1 / "wind.geojson").exists()  # written empty, so a carry has a file

    # Two hours later, still failing. Must publish rather than raise.
    gen2 = export(
        s, ev, {}, [], [], now=T(20, 14),
        results={"frp": failed(T(20, 14)), "wind": failed(T(20, 14))},
    )
    man2 = json.loads((s.out_dir / "manifest.json").read_text())
    assert man2["generation"] == gen2.name != gen1.name
    assert man2["layers"]["wind"]["status"] == "failed"
    assert validate_generation(gen2) == []


def test_size_class_follows_the_nwcg_standard(tmp_path):
    """Size classes use the NWCG fire size standard (nwcg.gov/node/432922),
    the US interagency scale every federal incident record uses:

        A <=0.25 ac   B <10 ac    C <100 ac   D <300 ac
        E <1000 ac    F <5000 ac  G 5000+ ac

    In km2 (1 ac = 0.00404686 km2) the top three boundaries are 1.2 / 4 / 20.

    The previous thresholds — major >=50, medium >=15 — were calibrated for
    megafires and put nearly the whole distribution in one bucket. `major >= 50`
    sits ABOVE NWCG's largest class.

    Classes A-C cannot occur here: the smallest footprint we can express is one
    H3 cell, already 0.7 km2 (VIIRS) or 5.2 km2 (Meteosat).

    This exercises the `cells=None` path — plain NWCG on a bare area. In
    production `size_class` is always given a cell count, and a one-cell
    footprint is not sized at all; see
    test_a_single_sensor_pixel_is_not_a_thousand_acre_fire for why, and for the
    distribution this actually produces.
    """
    from pipeline.export import size_class

    assert size_class(0.7) == "minor"     # below NWCG F
    assert size_class(4.04) == "minor"    # just under 1000 ac (4.047 km2)
    assert size_class(4.05) == "medium"   # NWCG F opens at 1000 ac
    assert size_class(20.1) == "medium"   # just under 5000 ac (20.23 km2)
    assert size_class(20.2) == "major"    # NWCG G opens at 5000 ac
    assert size_class(167.3) == "major"   # largest live fire on 2026-08-04


def test_size_class_boundaries_are_the_acre_conversions(tmp_path):
    """Pinned so a later tweak cannot quietly drift off the published scale."""
    from pipeline.export import MEDIUM_KM2, MAJOR_KM2

    acre_km2 = 0.00404686
    assert MEDIUM_KM2 == round(1000 * acre_km2, 2)  # NWCG F
    assert MAJOR_KM2 == round(5000 * acre_km2, 1)   # NWCG G


def test_a_single_sensor_pixel_is_not_a_thousand_acre_fire():
    """Measured in production 2026-08-04: `cum_cells == 1` split 1118 minor and
    1117 medium. Identical footprint — one cell — opposite class.

    area_km2 is cells x SENSOR cell size: 0.7 km2 for VIIRS, 5.2 km2 for
    Meteosat. NWCG's F boundary is 4.05 km2, which falls BETWEEN the two, so a
    single Meteosat pixel — the smallest thing that sensor can express — claimed
    NWCG class F. The class tracked which satellite saw the fire, not how big it
    was. (The invented 15/50 thresholds this replaced avoided it by accident:
    15 sits above the coarse quantum.)

    A one-cell footprint means "detected, not measured". NWCG applies once at
    least two cells actually resolve an extent.
    """
    assert size_class(METEOSAT_CELL_KM2, cells=1) == "minor"
    assert size_class(CELL_KM2, cells=1) == "minor"
    # Two Meteosat cells DO resolve an extent, and 10.4 km2 is genuinely NWCG F.
    assert size_class(2 * METEOSAT_CELL_KM2, cells=2) == "medium"
    # A single cell is never promoted, however the area was arrived at.
    assert size_class(500.0, cells=1) == "minor"


def test_size_class_still_follows_nwcg_once_the_extent_is_resolved():
    assert size_class(4.05, cells=2) == "medium"   # NWCG F, 1000 acres
    assert size_class(4.04, cells=2) == "minor"
    assert size_class(20.2, cells=5) == "major"    # NWCG G, 5000 acres
    assert size_class(20.19, cells=5) == "medium"


def test_size_class_defaults_to_measured_when_the_count_is_unknown():
    """Callers that have no cell count (tests, ad-hoc use) keep NWCG semantics
    rather than silently getting everything as minor."""
    assert size_class(20.2) == "major"
    assert size_class(4.05) == "medium"


def test_export_sizes_on_distinct_cells_not_on_detection_count(tmp_path):
    """Guards the CALL SITE, which the pure-function tests above cannot reach.

    Replacing `cells=len({m["cell"] for m in members})` with `cells=len(members)`
    passed all 201 tests while silently restoring the very bug this fixes: a
    single Meteosat pixel re-reported eleven times has one cell but eleven
    members, so counting members promotes it straight back to `medium`.

    One pixel seen repeatedly is still one pixel.
    """
    # Eleven Meteosat detections on ONE pixel, over two hours. Built through
    # cluster() so the members carry the same bin/cell shape production has.
    rows = [hs(44.0, -1.0, T(20, 0) + timedelta(minutes=10 * i), tier="meteosat") for i in range(11)]
    ev = cluster(rows, now=T(20, 3))
    (members,) = ev.values()
    assert len({m["cell"] for m in members}) == 1 and len(members) == 11

    s = _settings(tmp_path)
    gen = export(s, ev, liveness={}, places=[], alerts=[], now=T(20, 3))
    props = json.loads((gen / "events.geojson").read_text())["features"][0]["properties"]

    assert props["cum_cells"] == 1, "eleven detections, one cell"
    assert props["area_km2"] == METEOSAT_CELL_KM2
    assert props["size_class"] == "minor", (
        "a single Meteosat pixel is not a 1000-acre fire, however often it is seen"
    )


def test_generation_carries_a_track_index(tmp_path):
    """Every generation publishes the id -> cells projection its successor needs.

    `_previous_ids_cells` is the only consumer of a previous generation's
    tracks, and it wants two of the five keys in a ~6 KB track file. Writing
    that projection once, at export, is what lets hydrate skip ~9300 downloads.
    """
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.012, 8.0, T(20, 6))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))

    index = json.loads((gen / "tracks_index.json").read_text())
    assert set(index) == set(ev)
    # The projection must agree with the tracks it replaces, key for key.
    for eid in ev:
        track = json.loads((gen / "tracks" / f"{eid}.json").read_text())
        assert index[eid] == track["cells"]


def test_track_index_is_preferred_over_reading_every_track(tmp_path):
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))

    # Prove the index is what gets read: contradict the tracks on disk and the
    # index must win. If this passes with the tracks deleted but fails here,
    # the fallback is being used and hydrate's saving is imaginary.
    (gen / "tracks_index.json").write_text(json.dumps({"sentinel": ["8811aaa"]}))
    assert _previous_ids_cells(s.out_dir) == {"sentinel": {"8811aaa"}}


def test_track_index_falls_back_to_tracks_when_absent(tmp_path):
    """The generation live at deploy time has no index, and hydrate downloads
    its tracks precisely because of that. Losing the fallback would blank the
    merge lineage for exactly one generation — silently."""
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.012, 8.0, T(20, 6))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))
    (gen / "tracks_index.json").unlink()

    prev = _previous_ids_cells(s.out_dir)
    assert set(prev) == set(ev)
    for eid in ev:
        assert prev[eid] == set(json.loads((gen / "tracks" / f"{eid}.json").read_text())["cells"])


def test_merge_lineage_survives_a_tracks_free_hydrate(tmp_path):
    """End-to-end guard at the CALL SITE, not the helper.

    This is the same shape hydrate now produces: a previous generation whose
    tracks/ was never downloaded. `merged` lineage is the only consumer of
    those cells, so if the index is not wired into export() this test — and
    only this test — catches it. A helper-level test passes either way.
    """
    s = _settings(tmp_path)
    a, c = [hs(45.0, 8.0, T(20, 0))], [hs(45.012, 8.0, T(20, 6))]
    ev0 = cluster(a + c, now=T(20, 12))
    assert len(ev0) == 2
    gen0 = export(s, ev0, {}, [], [], now=T(20, 12))

    # Exactly what hydrate leaves behind once it skips the tracks prefix.
    shutil.rmtree(gen0 / "tracks")

    ev1 = cluster(a + c + [hs(45.005, 8.0, T(20, 12))], now=T(21, 0))
    assert len(ev1) == 1
    gen1 = export(s, ev1, {}, [], [], now=T(21, 0))
    lineage = json.loads((gen1 / "lineage.json").read_text())
    gone = set(ev0) - set(ev1)
    assert len(gone) == 1
    assert lineage["merged"] == {gone.pop(): next(iter(ev1))}


def test_a_corrupt_track_index_is_refused_before_publish(tmp_path):
    """The validator's asymmetry, pinned.

    Hydrate skips a generation's tracks exactly when the index is present, so
    an unparseable index is trusted and then read by the NEXT refresh, which
    dies. Refusing to publish keeps the previous consistent pair live.

    A MISSING index is the opposite: nothing is skipped, the tracks are read as
    before. Failing a run over that would turn a harmless state into an outage.
    """
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))
    assert validate_generation(gen) == []

    (gen / "tracks_index.json").write_text("{not json")
    assert validate_generation(gen) == ["invalid json: tracks_index.json"]

    (gen / "tracks_index.json").unlink()
    assert validate_generation(gen) == []
