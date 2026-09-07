import random

import h3

from pipeline.enrich import (
    MIN_PLACES,
    Places,
    fetch_gdacs,
    gdacs_for_event,
    load_places,
    nearest_place,
    place_for,
)
from pipeline.events import cluster
from pipeline.metrics import haversine_m
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
    f = tmp_path / "cities5000.txt"
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


def test_load_places_returns_an_indexed_gazetteer(tmp_path):
    f = tmp_path / "cities5000.txt"
    f.write_text(GEONAMES_TSV)
    places = load_places(f)
    assert isinstance(places, Places)
    assert len(places) == 2 and {p["name"] for p in places} == {"Testville", "FarCity"}


def test_indexed_nearest_place_matches_the_linear_scan():
    """The 1° grid index is an optimisation, not a semantics change: for
    inland points with a town within reach it must return exactly what the
    brute-force scan returns. cities5000 tripled the gazetteer and the scan
    was already ~20 s per run for the live events alone."""
    random.seed(3)
    raw = [{"name": f"P{i}", "lat": random.uniform(40, 55), "lon": random.uniform(-5, 20)}
           for i in range(3000)]
    idx = Places(raw)
    for _ in range(300):
        lat, lon = random.uniform(41, 54), random.uniform(-4, 19)
        assert nearest_place(lat, lon, idx) == nearest_place(lat, lon, raw)


def test_indexed_nearest_place_still_finds_a_town_outside_the_neighbourhood():
    # Nothing in the 3×3 grid cells around the point → fall back to the scan,
    # so a lone town 80 km away is still found (and the 100 km cutoff still
    # applies beyond that).
    idx = Places([{"name": "Lone", "lat": 45.0, "lon": 8.99}])
    p = nearest_place(45.0, 10.01, idx)  # 80 km east, but 1° cells 8 vs 10 → outside the 3×3
    assert p["name"] == "Lone" and 75 < p["distance_km"] < 85
    assert nearest_place(47.0, 8.99, idx) is None  # ~220 km


def _line_fire(lat, lon0, n, step=0.01):
    """`n` detections along a line of cells eastward from lon0 (~0.8 km apart)."""
    ms = [hs(lat, lon0 + step * i, T(20, 0)) for i in range(n)]
    for m in ms:
        m["cell"] = h3.latlng_to_cell(m["lat"], m["lon"], 8)
    return ms


def test_place_for_prefers_a_town_the_burn_reaches_over_one_nearer_its_centroid():
    """A 300 km² fire's centroid can sit closer to a town across a bay than
    to the towns it actually burned up to (Gironde 2026: labelled
    Gujan-Mestras, south shore of the Bassin, while the front stopped at
    Andernos). Label by the town nearest any burnt cell, not the centroid."""
    fire = _line_fire(45.0, 8.00, 20)  # ~16 km long, centroid near lon 8.095
    edge = {"name": "EdgeTown", "lat": 45.0, "lon": 8.20}     # ~0.8 km past the last cell
    mid = {"name": "MidTown", "lat": 45.06, "lon": 8.095}     # ~6.7 km north of the centroid
    places = Places([edge, mid])
    cen_lat = sum(m["lat"] for m in fire) / len(fire)
    cen_lon = sum(m["lon"] for m in fire) / len(fire)
    assert nearest_place(cen_lat, cen_lon, places)["name"] == "MidTown"  # the old rule
    p = place_for(fire, places)
    assert p["name"] == "EdgeTown"
    assert p["distance_km"] < 1.5  # distance to the nearest burnt cell, not the centroid


def test_place_for_accepts_a_plain_list_of_places():
    fire = _line_fire(45.0, 8.00, 3)
    assert place_for(fire, [{"name": "T", "lat": 45.0, "lon": 8.03}])["name"] == "T"


def test_place_for_falls_back_to_the_centroid_rule_when_no_town_is_near_the_burn():
    fire = _line_fire(45.0, 8.00, 3)
    far = Places([{"name": "Far", "lat": 45.3, "lon": 8.0}])  # ~33 km, well outside ring 1 at res 6
    p = place_for(fire, far)
    assert p["name"] == "Far" and 30 < p["distance_km"] < 36
    assert place_for(fire, Places([{"name": "X", "lat": 47.0, "lon": 8.0}])) is None  # > 100 km
    assert place_for(fire, Places([])) is None


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
    f = tmp_path / "cities5000.txt"
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
