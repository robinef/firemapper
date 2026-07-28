from pipeline.config import load_settings
from pipeline.fetch_firms import append_hotspots
from pipeline.run import process
from tests.synth import T, hs


def test_process_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.run.fetch_gdacs", lambda: [])
    monkeypatch.setattr("pipeline.run.mtg_frp_extent", lambda: None)
    monkeypatch.setattr("pipeline.run.fetch_frp_points", lambda bbox: [])
    monkeypatch.setattr("pipeline.run.fetch_wind", lambda pts: [])
    monkeypatch.setattr("pipeline.run.fetch_aircraft", lambda: [])
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    rows = [
        hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6)),
        hs(45.0, 8.0, T(20, 5), tier="meteosat", frp=200),
    ]
    append_hotspots(rows, s.data_dir / "raw" / "hotspots.parquet")
    gen = process(s, now=T(20, 12))
    assert (s.out_dir / "manifest.json").exists()
    assert (gen / "events.geojson").exists()
