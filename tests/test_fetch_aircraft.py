import json

from pipeline.fetch_aircraft import classify, fetch_aircraft


def test_classify_verified_families_and_types():
    # Types are cited (FR Sécurité Civile / IT Protezione Civile), not guessed.
    assert classify("PELICAN32") == ("Canadair CL-415", "water bomber")
    assert classify("MILAN78") == ("Dash-8 Q400MR", "water bomber")  # Dash, not Canadair
    assert classify("MORANE10")[1] == "air coordination"
    assert classify("CAN28") == ("Canadair CL-415", "water bomber")


def test_classify_requires_a_flight_number():
    # Family word alone (or family + letters) must NOT match — anchoring guards
    # against an airline/foreign callsign that merely shares the leading letters.
    assert classify("MILAN") is None
    assert classify("MILANAIR") is None
    assert classify("PELICANJET9") is None


def test_classify_rejects_generic_and_unverified():
    # These previously risked badging military/unknown aircraft as bombers.
    assert classify("BOMBER1") is None
    assert classify("CANADAIR3") is None
    assert classify("AFR1234") is None
    assert classify("RYR9GT") is None
    assert classify("") is None


def test_dragon_helicopter_requires_french_icao24():
    # French Sécurité Civile "Dragon" helo (icao24 in the French state range).
    assert classify("DRAGO2B", "3b7b84") == ("EC145 / H145", "rescue helicopter")
    assert classify("DRAG75S", "3b7b98")[1] == "rescue helicopter"
    # The defunct Dragonair airline also used "DRAGON" — a Hong Kong icao24
    # (0x780000+). It must NOT be badged a fire helicopter.
    assert classify("DRAGON123", "780abc") is None
    assert classify("DRAGON123", None) is None


def _state(icao, cs, lon, lat, alt, ground, vel, hdg, last_contact=1_700_000_100):
    # OpenSky state-vector positional layout (index 4 = last_contact).
    return [icao, cs, "France", 1_700_000_000, last_contact, lon, lat, alt, ground, vel, hdg, 0]


FAKE = {
    "states": [
        _state("3b7b3e", "PELICAN32 ", -0.71, 44.83, None, True, None, None),
        _state("aaa111", "AFR23", 2.0, 45.0, 10000, False, 240, 90),  # airliner, dropped
        _state("bbb222", "MILAN78", 1.4, 43.6, 900, False, 130, 210, last_contact=1_700_000_050),
        _state("ccc333", "PELICAN9", None, None, 0, True, 0, 0),  # no position, dropped
        ["short", "MILAN5"],  # malformed short row → skipped, not fatal
    ]
}


def test_fetch_keeps_only_identified_firefighters_with_position():
    ac = fetch_aircraft(http_text=lambda url: json.dumps(FAKE))
    assert sorted(a["callsign"] for a in ac) == ["MILAN78", "PELICAN32"]


def test_fetch_maps_fields_units_and_position_time():
    ac = fetch_aircraft(http_text=lambda url: json.dumps(FAKE))
    milan = next(a for a in ac if a["callsign"] == "MILAN78")
    assert milan["type"] == "Dash-8 Q400MR"
    assert milan["on_ground"] is False
    assert milan["speed_kmh"] == round(130 * 3.6)
    assert milan["heading"] == 210
    assert milan["pos_time"] == 1_700_000_050  # staleness must be carryable
    pel = next(a for a in ac if a["callsign"] == "PELICAN32")
    assert pel["on_ground"] is True and pel["alt_m"] is None


def test_fetch_survives_network_error():
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    assert fetch_aircraft(http_text=boom) == []


def test_fetch_survives_empty_states():
    assert fetch_aircraft(http_text=lambda url: json.dumps({"states": None})) == []
    assert fetch_aircraft(http_text=lambda url: json.dumps({})) == []
