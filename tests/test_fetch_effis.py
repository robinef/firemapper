"""Response-body parsing for the EFFIS WFS wire format.

fetch_effis_ba no longer touches the network (see
test_fetch_effis_snapshot_backed.py); _features_from_text is what still reads
EFFIS responses, on behalf of fetch_effis_season, so the guard against a
down backend is asserted here where the behaviour actually lives.
"""
import json

from pipeline.fetch_effis import _features_from_text

# Two burned-area polygons, synthetic. Fire dates are years in the past so
# nothing here depends on the machine clock.
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


def test_geojson_body_yields_its_features():
    feats = _features_from_text(_GEOJSON)
    assert len(feats) == 2
    assert feats[0]["properties"]["province"] == "Gironde"
    assert feats[1]["properties"]["FIREDATE"] == "2021-08-05"


def test_oracle_exception_report_yields_no_features():
    assert _features_from_text(_EXCEPTION_XML) == []


def test_garbage_body_yields_no_features():
    assert _features_from_text("not json or xml {[") == []


def test_empty_body_yields_no_features():
    assert _features_from_text("") == []
