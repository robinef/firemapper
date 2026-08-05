import json
from datetime import datetime, timezone

from pipeline.events import cluster
from pipeline.config import load_settings
from pipeline.export import export
from tests.synth import hs, T


def _settings(tmp_path):
    return load_settings(env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")})


def _frp(lon, lat, minutes_ago, now):
    t = now.timestamp() - minutes_ago * 60
    return {
        "lon": lon, "lat": lat, "frp": 30.0, "conf": 90,
        "time": datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def test_every_event_carries_has_footprint(tmp_path):
    """The map needs this on EVERY feature, not just covered ones.

    Above z9.5 the dot hands over to the footprint outline. The layer filter
    keys off has_footprint, and a missing key matches nothing — so an event
    without it would be invisible at exactly the zoom this property exists to
    protect.
    """
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12))
    feats = json.loads((gen / "events.geojson").read_text())["features"]
    assert feats
    for f in feats:
        assert isinstance(f["properties"]["has_footprint"], bool)


def test_no_isochrones_means_no_footprint_rather_than_a_crash(tmp_path):
    """With no FRP pixels there are no bands, so nothing can be covered.

    False is the safe answer: the frontend keeps drawing the dot at every
    zoom, which is exactly right when there is no outline to hand over to.
    """
    s = _settings(tmp_path)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=T(20, 12))
    gen = export(s, ev, {}, [], [], now=T(20, 12), frp_points=[])
    feats = json.loads((gen / "events.geojson").read_text())["features"]
    assert feats
    assert all(f["properties"]["has_footprint"] is False for f in feats)


def test_a_fire_the_bands_cover_is_marked_true(tmp_path):
    """The positive case, without which the other two pass on all-False.

    A dense pixel cluster sitting on the event produces an open band that
    encloses its centroid, so this is the fire whose dot the map is allowed to
    fade out at high zoom.
    """
    s = _settings(tmp_path)
    now = T(20, 12)
    ev = cluster([hs(45.0, 8.0, T(20, 0)), hs(45.005, 8.0, T(20, 6))], now=now)
    pts = [
        _frp(8.0 + i * 0.01, 45.0 + j * 0.01, 30 + i + j, now)
        for i in range(-3, 4)
        for j in range(-3, 4)
    ]
    gen = export(s, ev, {}, [], [], now=now, frp_points=pts)
    feats = json.loads((gen / "events.geojson").read_text())["features"]
    assert [f["properties"]["has_footprint"] for f in feats] == [True]


def test_a_fire_far_from_every_band_is_marked_false(tmp_path):
    """Same run, two fires: one inside the bands and one a long way off.

    Asserting both in one export is what proves the flag tracks the geometry
    rather than the run — a stamp that said True for everything would pass the
    positive test above on its own.
    """
    s = _settings(tmp_path)
    now = T(20, 12)
    ev = cluster(
        [
            hs(45.0, 8.0, T(20, 0)),
            hs(45.005, 8.0, T(20, 6)),
            hs(41.0, 2.0, T(20, 0)),
            hs(41.005, 2.0, T(20, 6)),
        ],
        now=now,
    )
    pts = [
        _frp(8.0 + i * 0.01, 45.0 + j * 0.01, 30 + i + j, now)
        for i in range(-3, 4)
        for j in range(-3, 4)
    ]
    gen = export(s, ev, {}, [], [], now=now, frp_points=pts)
    feats = json.loads((gen / "events.geojson").read_text())["features"]
    by_lon = {round(f["geometry"]["coordinates"][0], 1): f["properties"] for f in feats}
    assert by_lon[8.0]["has_footprint"] is True
    assert by_lon[2.0]["has_footprint"] is False
