import json
from datetime import datetime, timezone

import pytest

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


NOW = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
EPOCH_NOW = int(NOW.timestamp())


def _state(icao, cs, lon, lat, alt, ground, vel, hdg, time_position=None):
    # OpenSky state-vector positional layout: index 3 = time_position (when the
    # POSITION was fixed), index 4 = last_contact (when the transponder was
    # last heard). Only index 3 says how old the position is.
    return [
        icao, cs, "France",
        EPOCH_NOW - 60 if time_position is None else time_position,
        EPOCH_NOW,  # heard just now in every case
        lon, lat, alt, ground, vel, hdg, 0,
    ]


def _fake():
    return {
        "states": [
            # grounded at base — dropped: a parked plane is not fighting a fire
            _state("3b7b3e", "PELICAN32 ", -0.71, 44.83, None, True, None, None),
            _state("aaa111", "AFR23", 2.0, 45.0, 10000, False, 240, 90),  # airliner, dropped
            _state("bbb222", "MILAN78", 1.4, 43.6, 900, False, 130, 210,
                   time_position=EPOCH_NOW - 50),
            _state("ccc333", "PELICAN9", None, None, 0, True, 0, 0),  # no position, dropped
            ["short", "MILAN5"],  # malformed short row → skipped, not fatal
        ]
    }


def test_fetch_keeps_only_airborne_identified_firefighters():
    ac = fetch_aircraft(http_text=lambda url: json.dumps(_fake()), now=NOW)
    assert sorted(a["callsign"] for a in ac) == ["MILAN78"]


def test_fetch_maps_fields_units_and_position_time():
    ac = fetch_aircraft(http_text=lambda url: json.dumps(_fake()), now=NOW)
    milan = next(a for a in ac if a["callsign"] == "MILAN78")
    assert milan["type"] == "Dash-8 Q400MR"
    assert milan["speed_kmh"] == round(130 * 3.6)
    assert milan["heading"] == 210
    # position age comes from time_position, never from last_contact
    assert milan["pos_time"] == EPOCH_NOW - 50


def test_fetch_raises_on_network_error():
    """A transport failure must NOT look like an empty sky. It propagates so
    attempt() can classify it `failed` and carry the previous snapshot; an
    earlier version returned [] here and published an empty layer over good
    data during an upstream outage."""
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    with pytest.raises(RuntimeError, match="offline"):
        fetch_aircraft(http_text=boom)


def test_fetch_survives_empty_states():
    assert fetch_aircraft(http_text=lambda url: json.dumps({"states": None})) == []
    assert fetch_aircraft(http_text=lambda url: json.dumps({})) == []


# --- freshness: the 20-minute promise is only true if the timestamps mean what
# the UI says they mean ---

def _plain_state(callsign="PELICAN 32", *, time_position, last_contact, on_ground=False):
    # OpenSky state vector: 0 icao24, 1 callsign, 2 country, 3 time_position,
    # 4 last_contact, 5 lon, 6 lat, 7 baro_alt, 8 on_ground, 9 velocity, 10 heading
    return ["3a1b2c", callsign, "France", time_position, last_contact,
            2.5, 44.0, 1200.0, on_ground, 90.0, 180.0]


def _fetch(states, **kw):
    return fetch_aircraft(lambda url: json.dumps({"states": states}), now=NOW, **kw)


def test_pos_time_is_time_position_not_last_contact():
    rows = _fetch([_plain_state(time_position=EPOCH_NOW - 60, last_contact=EPOCH_NOW)])
    assert rows[0]["pos_time"] == EPOCH_NOW - 60


def test_stale_position_with_recent_contact_is_dropped():
    """A transponder heard 5 s ago can still be reporting a 40-minute-old fix."""
    rows = _fetch([_plain_state(time_position=EPOCH_NOW - 2400, last_contact=EPOCH_NOW - 5)])
    assert rows == []


def test_on_ground_aircraft_are_excluded():
    rows = _fetch([_plain_state(time_position=EPOCH_NOW - 30, last_contact=EPOCH_NOW, on_ground=True)])
    assert rows == []


def test_missing_time_position_is_dropped():
    rows = _fetch([_plain_state(time_position=None, last_contact=EPOCH_NOW)])
    assert rows == []


def test_position_inside_the_budget_is_kept():
    rows = _fetch([_plain_state(time_position=EPOCH_NOW - 1199, last_contact=EPOCH_NOW)])
    assert len(rows) == 1
    assert rows[0]["callsign"] == "PELICAN 32"
