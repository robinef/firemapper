from pipeline.enrich import (
    MIN_PLACES,
    fetch_gdacs,
    gdacs_for_event,
    load_places,
    nearest_place,
)
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


def test_nearest_place_rejects_a_match_beyond_max_km():
    """An offshore false-positive hundreds of km from land must not be labelled
    with whatever town happens to be closest — that's how a mid-Atlantic sensor
    glint gets displayed to users as a fire in Cascais."""
    places = [{"name": "Cascais", "lat": 38.7, "lon": -9.4}]
    assert nearest_place(38.7, -13.2, places) is None  # ~420 km offshore


def test_nearest_place_accepts_a_match_within_max_km():
    places = [{"name": "Cascais", "lat": 38.7, "lon": -9.4}]
    p = nearest_place(38.75, -9.45, places)
    assert p["name"] == "Cascais"


def test_gdacs_parse_and_match():
    alerts = fetch_gdacs(http_get=lambda url: GDACS_RSS)
    assert len(alerts) == 1  # WF only
    members = next(iter(cluster([hs(45.0, 8.0, T(20, 0))], now=T(20, 6)).values()))
    m = gdacs_for_event(members, alerts)
    assert m == {"title": "Wildfire in Testland", "link": "https://www.gdacs.org/report?id=1"}


def _row(name, lat, lon):
    # GeoNames layout: id, name, asciiname, alternates, lat, lon, ...
    return f"1\t{name}\t{name}\t\t{lat}\t{lon}\tP\tPPL"


def _gazetteer(tmp_path, rows):
    f = tmp_path / "cities15000.txt"
    f.write_text("\n".join(rows), encoding="utf-8")
    return f


def test_load_places_skips_a_malformed_row_instead_of_dying(tmp_path):
    """One bad line in a 3 MB third-party download must not take the whole
    refresh down — it should cost that one city and nothing else."""
    rows = [_row(f"City{i}", 45.0, 5.0) for i in range(5)]
    rows.insert(3, "1\tBroken\tBroken\t\tnot-a-latitude\talso-not\tP\tPPL")
    places = load_places(_gazetteer(tmp_path, rows))
    assert [p["name"] for p in places] == [f"City{i}" for i in range(5)]


def test_load_places_refuses_an_implausibly_small_gazetteer(tmp_path):
    """GeoNames regenerates this file daily, so a pinned checksum would break
    the refresh within a day — the plausibility floor is the integrity check
    that actually holds. A truncated or swapped file must fail LOUDLY:
    silently yielding no names is exactly the regression that left every scar
    called "Burn scar · <date>" for weeks without anyone noticing."""
    import pytest

    f = _gazetteer(tmp_path, [_row("Lyon", 45.76, 4.84)])
    with pytest.raises(ValueError, match="implausible"):
        load_places(f, min_places=MIN_PLACES)


def test_load_places_accepts_a_full_gazetteer(tmp_path):
    rows = [_row(f"City{i}", 45.0, 5.0) for i in range(MIN_PLACES)]
    assert len(load_places(_gazetteer(tmp_path, rows), min_places=MIN_PLACES)) == MIN_PLACES
