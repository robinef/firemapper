from pipeline.enrich import fetch_gdacs, gdacs_for_event, load_places, nearest_place
from pipeline.events import cluster
from tests.synth import T, hs

GEONAMES_TSV = (
    "1\tTestville\tTestville\t\t45.05\t8.05\tP\tPPL\tIT\t\t\t\t\t\t1000\t\t\t\n"
    "2\tFarCity\tFarCity\t\t60.0\t20.0\tP\tPPL\tSE\t\t\t\t\t\t1000\t\t\t\n"
)

GDACS_RSS = """<?xml version="1.0"?><rss><channel>
<item><title>Wildfire in Testland</title><link>https://www.gdacs.org/report?id=1</link>
<gdacs:eventtype xmlns:gdacs="http://www.gdacs.org">WF</gdacs:eventtype>
<geo:Point xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><geo:lat>45.01</geo:lat><geo:long>8.01</geo:long></geo:Point>
<pubDate>Mon, 20 Jul 2026 06:00:00 GMT</pubDate></item>
<item><title>Flood somewhere</title><link>https://x</link>
<gdacs:eventtype xmlns:gdacs="http://www.gdacs.org">FL</gdacs:eventtype>
<geo:Point xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><geo:lat>45.0</geo:lat><geo:long>8.0</geo:long></geo:Point>
<pubDate>Mon, 20 Jul 2026 06:00:00 GMT</pubDate></item>
</channel></rss>"""


def test_load_places_filters_and_parses(tmp_path):
    f = tmp_path / "cities15000.txt"
    f.write_text(GEONAMES_TSV)
    places = load_places(f)
    assert {p["name"] for p in places} == {"Testville", "FarCity"}


def test_nearest_place():
    places = [{"name": "Testville", "lat": 45.05, "lon": 8.05}, {"name": "FarCity", "lat": 60.0, "lon": 20.0}]
    p = nearest_place(45.0, 8.0, places)
    assert p["name"] == "Testville" and p["distance_km"] < 10


def test_gdacs_parse_and_match():
    alerts = fetch_gdacs(http_get=lambda url: GDACS_RSS)
    assert len(alerts) == 1  # WF only
    members = next(iter(cluster([hs(45.0, 8.0, T(20, 0))], now=T(20, 6)).values()))
    m = gdacs_for_event(members, alerts)
    assert m == {"title": "Wildfire in Testland", "link": "https://www.gdacs.org/report?id=1"}
