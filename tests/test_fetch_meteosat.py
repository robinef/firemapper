from pipeline.config import load_settings
from pipeline.events import cluster
import json

from pipeline.fetch_meteosat import (
    fetch_frp_points,
    fetch_meteosat,
    liveness_for_events,
    mtg_frp_extent,
)
from tests.synth import T, hs


def test_missing_credentials_returns_none(tmp_path):
    s = load_settings(env={"DATA_DIR": str(tmp_path)})
    assert fetch_meteosat(s) is None  # degraded mode, no crash


def test_injected_pixels_appended(tmp_path):
    s = load_settings(env={
        "DATA_DIR": str(tmp_path),
        "EUMETSAT_CONSUMER_KEY": "k", "EUMETSAT_CONSUMER_SECRET": "s",
    })
    px = [{"lat": 45.0, "lon": 8.0, "acq_time": T(20, 0), "frp": 250.0}]
    assert fetch_meteosat(s, fetch_pixels=lambda: px) == 1
    assert fetch_meteosat(s, fetch_pixels=lambda: px) == 0  # dedup


def test_liveness_matching():
    ev = cluster([hs(45.0, 8.0, T(20, 0))], now=T(20, 6))
    eid = next(iter(ev))
    met = [
        {"lat": 45.0, "lon": 8.0, "acq_time": T(20, 5), "frp": 300.0, "tier": "meteosat"},
        {"lat": 46.5, "lon": 10.0, "acq_time": T(20, 5), "frp": 300.0, "tier": "meteosat"},
    ]
    live = liveness_for_events(ev, met)
    assert eid in live and len(live[eid]["frp_series"]) == 1


CAPS = """<WMS_Capabilities><Layer><Name>other:thing</Name>
<Dimension name="time" units="ISO8601">1999-01-01/1999-01-02/PT1H</Dimension></Layer>
<Layer><Name>mtg_fd:frp</Name><Title>Fire Radiative Power (FRP)</Title>
<Dimension name="time" default="x" units="ISO8601" nearestValue="1">2026-07-23T00:00:00.000Z/2026-07-24T07:30:00.000Z/PT10M</Dimension>
</Layer></WMS_Capabilities>"""


def test_mtg_frp_extent_parses_live_window():
    ext = mtg_frp_extent(http_text=lambda url: CAPS)
    assert ext == {
        "start": "2026-07-23T00:00:00.000Z",
        "end": "2026-07-24T07:30:00.000Z",
        "step": "PT10M",
    }


FRP_FC = {
    "type": "FeatureCollection",
    "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.15012, 44.81634]},
         "properties": {"FRP": 44.16, "Confidence": 66, "time": "2026-07-24T08:20:00Z"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-1.2, 44.9]},
         "properties": {"FRP": 12.0, "Confidence": 10, "time": "2026-07-24T08:20:00Z"}},
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[]]},
         "properties": {"FRP": 99.0}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 45]},
         "properties": {"Confidence": 80}},
    ],
}


def test_frp_url_sorts_newest_first():
    # The service returns features oldest-first and count caps the result, so
    # without a descending time sort the freshest detections get truncated.
    from pipeline.fetch_meteosat import _wfs_points_url

    url = _wfs_points_url((-25.0, 34.0, 45.0, 72.0), 30000)
    assert "sortBy=time+D" in url


def test_fetch_frp_points_parses_rounds_and_filters():
    pts = fetch_frp_points(
        (-25.0, 34.0, 45.0, 72.0),
        http_text=lambda url: json.dumps(FRP_FC),
        min_confidence=50,
    )
    # low-confidence, non-Point and FRP-less features dropped
    assert len(pts) == 1
    assert pts[0] == {
        "lon": -1.1501, "lat": 44.8163, "frp": 44.2, "conf": 66,
        "time": "2026-07-24T08:20:00Z",
    }


def test_fetch_frp_points_returns_empty_on_failure():
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    assert fetch_frp_points((-25.0, 34.0, 45.0, 72.0), http_text=boom) == []


def test_mtg_frp_extent_returns_none_when_unreachable():
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    assert mtg_frp_extent(http_text=boom) is None
