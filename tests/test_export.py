import json

from pipeline.config import load_settings
from pipeline.events import cluster
from pipeline.export import export, prune_generations, validate_generation
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
