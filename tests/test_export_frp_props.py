import json
from datetime import datetime, timezone

from pipeline.config import load_settings
from pipeline.export import export


def _now():
    return datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)


def _frp(lon, lat, minutes_ago):
    t = _now().timestamp() - minutes_ago * 60
    return {
        "lon": lon, "lat": lat, "frp": 30.0, "conf": 90,
        "time": datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def test_dir_key_absent_rather_than_null(tmp_path):
    """A null bearing must not survive into the artifact.

    The map draws arrows for any feature that *has* a `dir` key, so a null
    would become an arrow rotated to 0 degrees — a due-north spread direction
    that was never measured.
    """
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    # A lone pixel has no neighbours, so it can have no gradient.
    gen = export(
        s, {}, {}, [], [], now=_now(), frp_points=[_frp(8.0, 45.0, 30)]
    )
    feats = json.loads((gen / "frp.geojson").read_text())["features"]
    assert len(feats) == 1
    props = feats[0]["properties"]
    assert "dir" not in props
    assert props["age_min"] == 30


def test_dir_present_when_gradient_exists(tmp_path):
    s = load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})
    # A north-running line getting fresher northward gives a real gradient.
    pts = [_frp(8.0, 45.0 + 0.01 * k, 300 - 60 * k) for k in range(5)]
    gen = export(s, {}, {}, [], [], now=_now(), frp_points=pts)
    feats = json.loads((gen / "frp.geojson").read_text())["features"]
    dirs = [f["properties"].get("dir") for f in feats]
    assert any(d is not None for d in dirs)
    assert all(d is None or 0 <= d <= 360 for d in dirs)
