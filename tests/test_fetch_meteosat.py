from pipeline.config import load_settings
from pipeline.events import cluster
import json
from urllib.parse import quote

from pipeline.fetch_meteosat import (
    FRP_ATTEMPTS,
    FRP_BACKOFF_S,
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


def test_frp_url_windows_by_time_and_never_sorts():
    """Recency must come from the filter, not a sort.

    The service answers ANY sortBy on this layer with a server-side
    NullPointerException (HTTP 400) — deterministically, as of 2026-08-04 — so a
    sorted request is a dead request. A bounded time window makes `count`
    irrelevant instead, because the whole window fits under it.
    """
    from datetime import datetime, timezone

    from pipeline.fetch_meteosat import _wfs_points_url

    since = datetime(2026, 8, 4, 2, 30, tzinfo=timezone.utc)
    url = _wfs_points_url((-25.0, 34.0, 45.0, 72.0), 20000, since)
    assert "sortBy" not in url
    assert "CQL_FILTER=" in url
    assert quote("time AFTER 2026-08-04T02:30:00Z") in url


def test_frp_url_puts_the_bbox_inside_the_filter():
    """GeoServer answers a `bbox` parameter alongside CQL_FILTER with a 500, so
    the spatial constraint has to be a BBOX() predicate in the same filter — and
    BBOX() takes lon/lat, unlike the EPSG-urn bbox parameter it replaces."""
    from datetime import datetime, timezone

    from pipeline.fetch_meteosat import _wfs_points_url

    url = _wfs_points_url((-25.0, 34.0, 45.0, 72.0), 20000, datetime(2026, 8, 4, tzinfo=timezone.utc))
    assert "&bbox=" not in url
    assert quote("BBOX(geom,-25.0,34.0,45.0,72.0)") in url


def test_frp_window_is_measured_from_now():
    """The window is relative, so a fixed `now` must move the filter with it."""
    from datetime import datetime, timezone

    seen: list[str] = []

    def capture(url: str) -> str:
        seen.append(url)
        return json.dumps({"type": "FeatureCollection", "features": []})

    fetch_frp_points(
        (-25.0, 34.0, 45.0, 72.0),
        http_text=capture,
        window_h=6,
        now=datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc),
    )
    assert quote("time AFTER 2026-08-04T06:00:00Z") in seen[0]


def test_frp_warns_when_the_window_overflows_the_cap(capsys):
    """A truncated window is stale data wearing a fresh label: the server cuts
    from the OLD end, so the caller must be told rather than quietly publishing
    the wrong half."""
    fc = {
        "type": "FeatureCollection",
        "numberMatched": 32397,
        "features": FRP_FC["features"],
    }
    fetch_frp_points(
        (-25.0, 34.0, 45.0, 72.0), http_text=lambda url: json.dumps(fc), count=20000
    )
    assert "truncated" in capsys.readouterr().err


def test_frp_is_quiet_when_the_whole_window_fits(capsys):
    fc = {
        "type": "FeatureCollection",
        "numberMatched": len(FRP_FC["features"]),
        "features": FRP_FC["features"],
    }
    fetch_frp_points((-25.0, 34.0, 45.0, 72.0), http_text=lambda url: json.dumps(fc))
    assert "truncated" not in capsys.readouterr().err


def test_frp_detects_truncation_without_numbermatched(capsys):
    """WFS 2.0 permits numberMatched="unknown", and GeoServer sends exactly that
    when skip-number-matched is on — a server-side toggle we do not control. If
    that were the only detector it would go quiet precisely when the server stops
    cooperating, so hitting the cap must be sufficient on its own."""
    feats = FRP_FC["features"]
    for matched in ("unknown", None):
        fc = {"type": "FeatureCollection", "features": feats}
        if matched is not None:
            fc["numberMatched"] = matched
        fetch_frp_points(
            (-25.0, 34.0, 45.0, 72.0),
            http_text=lambda url: json.dumps(fc),
            count=len(feats),  # returned == cap, i.e. truncated by definition
        )
        assert "truncated" in capsys.readouterr().err, f"matched={matched!r}"


def test_frp_window_is_bounded_against_the_freshness_budget():
    """The window is how much history the heatmap paints at full weight, while
    observed_at reports only the newest timestamp — so the layer always claims to
    be minutes old however wide this gets. Keep the two visibly related: a window
    many times the budget would render hours of history under a "live" label."""
    from pipeline.fetch_meteosat import FRP_WINDOW_H
    from pipeline.freshness import MAX_AGE_S

    assert FRP_WINDOW_H * 3600 <= 6 * MAX_AGE_S["frp"]


def test_frp_treats_a_naive_now_as_utc():
    """Matches fetch_result.newest_timestamp. Reading a naive stamp as local time
    would slide the whole window by the runner's UTC offset."""
    from datetime import datetime

    seen: list[str] = []

    def capture(url: str) -> str:
        seen.append(url)
        return json.dumps({"type": "FeatureCollection", "features": []})

    fetch_frp_points(
        (-25.0, 34.0, 45.0, 72.0),
        http_text=capture,
        window_h=6,
        now=datetime(2026, 8, 4, 12, 0),  # naive
    )
    assert quote("time AFTER 2026-08-04T06:00:00Z") in seen[0]


def test_frp_url_never_names_a_crs_in_the_bbox():
    """An explicit CRS operand looks more rigorous and silently moves the query.
    With BBOX(...,'EPSG:4326') the server honours that CRS's official lat/lon
    axis order, turning this box into lat -25..45, lon 34..72. Verified live on
    2026-08-04: 5862 features without the operand, 1521 with — both HTTP 200, so
    nothing surfaces the wrong region."""
    from datetime import datetime, timezone

    from pipeline.fetch_meteosat import _wfs_points_url

    url = _wfs_points_url(
        (-25.0, 34.0, 45.0, 72.0), 20000, datetime(2026, 8, 4, tzinfo=timezone.utc)
    )
    assert "EPSG%3A4326" not in url.split("CQL_FILTER=")[1]


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


def test_fetch_frp_points_raises_on_failure():
    """Must NOT return []. Swallowing the error here made an outage identical to
    "no fires burning", and on 2026-07-30 that published an empty intensity
    layer over good data on the live map. attempt() classifies it instead."""
    import pytest

    def boom(url: str) -> str:
        raise RuntimeError("offline")

    with pytest.raises(RuntimeError, match="offline"):
        fetch_frp_points((-25.0, 34.0, 45.0, 72.0), http_text=boom)


def test_mtg_frp_extent_returns_none_when_unreachable():
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    assert mtg_frp_extent(http_text=boom) is None


def test_fetch_frp_points_retries_a_transient_failure():
    """EUMETView's GeoServer throws an intermittent NullPointerException (HTTP
    400) on a request it serves fine moments later; measured roughly one call in
    three while the service was otherwise up. One flake must not cost the whole
    intensity layer for that refresh."""
    calls = []

    def flaky(url: str) -> str:
        calls.append(url)
        if len(calls) < 3:
            raise RuntimeError("NoApplicableCode: java.lang.NullPointerException")
        return json.dumps(FRP_FC)

    slept: list[float] = []
    pts = fetch_frp_points(
        (-25.0, 34.0, 45.0, 72.0),
        http_text=flaky,
        min_confidence=50,
        sleep=slept.append,
    )
    assert len(calls) == 3
    assert len(pts) == 1
    assert slept == [FRP_BACKOFF_S, FRP_BACKOFF_S * 2]  # backs off between tries


def test_fetch_frp_points_still_raises_once_retries_are_spent():
    """Retrying must not turn a real outage into silence — the carry-forward
    contract in attempt() depends on this still raising."""
    import pytest

    calls = []

    def boom(url: str) -> str:
        calls.append(url)
        raise RuntimeError("offline")

    with pytest.raises(RuntimeError, match="offline"):
        fetch_frp_points((-25.0, 34.0, 45.0, 72.0), http_text=boom, sleep=lambda _: None)
    assert len(calls) == FRP_ATTEMPTS
