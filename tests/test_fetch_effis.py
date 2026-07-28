import json

from pipeline.fetch_effis import fetch_effis_ba


class _Settings:
    pass


# Two burned-area polygons. Fire dates are years in the past so `after` is always
# firedate + 14 (well before today-1) regardless of the machine clock.
_GEOJSON = json.dumps({
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"firedate": "2022-07-10", "area_ha": 1000,
                           "province": "Gironde"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[8.0, 45.0], [8.2, 45.0],
                                 [8.2, 45.2], [8.0, 45.2], [8.0, 45.0]]],
            },
        },
        {
            "type": "Feature",
            "properties": {"FIREDATE": "2021-08-05", "area": 500},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-1.0, 40.0], [-0.6, 40.0],
                                 [-0.6, 40.4], [-1.0, 40.4], [-1.0, 40.0]]],
            },
        },
    ],
})

# Real-world OWS body EFFIS returns when its Oracle backend is unreachable.
_EXCEPTION_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" '
    'version="2.0.0" xml:lang="en">\n'
    '  <ows:Exception exceptionCode="NoApplicableCode">\n'
    '    <ows:ExceptionText>OracleSpatial error: could not open connection - '
    'Connection failure</ows:ExceptionText>\n'
    '  </ows:Exception>\n'
    '</ows:ExceptionReport>\n'
)


def test_geojson_features_become_scars():
    scars = fetch_effis_ba(_Settings(), http_get=lambda url: _GEOJSON)
    assert len(scars) == 2

    # Sorted by area desc → the 1000 ha Gironde scar first.
    a, b = scars
    assert a["kind"] == "past" and b["kind"] == "past"

    # Centroid = bbox midpoint of the polygon.
    assert a["lon"] == 8.1 and a["lat"] == 45.1
    assert b["lon"] == -0.8 and b["lat"] == 40.2

    # Dates: before = firedate - 6, after = firedate + 14 (settled).
    assert a["started"] == "2022-07-10"
    assert a["before"] == "2022-07-04"
    assert a["after"] == "2022-07-24"
    assert a["label"] == "Gironde · 2022"

    # No place attribute → generic dated label.
    assert b["started"] == "2021-08-05"
    assert b["before"] == "2021-07-30"
    assert b["after"] == "2021-08-19"
    assert b["label"] == "Burn scar · 2021-08-05"

    # The internal sort key never leaks into the manifest.
    assert "_area_ha" not in a and "_area_ha" not in b


def test_limit_caps_results():
    scars = fetch_effis_ba(_Settings(), http_get=lambda url: _GEOJSON, limit=1)
    assert len(scars) == 1
    assert scars[0]["label"] == "Gironde · 2022"  # largest area kept


def test_oracle_exception_report_yields_empty():
    scars = fetch_effis_ba(_Settings(), http_get=lambda url: _EXCEPTION_XML)
    assert scars == []


def test_http_error_yields_empty():
    def boom(url: str) -> str:
        raise RuntimeError("connection reset")

    assert fetch_effis_ba(_Settings(), http_get=boom) == []


def test_garbage_body_yields_empty():
    assert fetch_effis_ba(_Settings(), http_get=lambda url: "not json or xml {[") == []
