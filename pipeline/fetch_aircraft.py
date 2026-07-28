"""Live firefighting aircraft from the OpenSky Network (ADS-B).

Free, no key for anonymous bbox queries. We keep only aircraft we can identify
as firefighting assets by callsign — the map must not imply an airliner is a
water bomber. Each aircraft carries `pos_time` (OpenSky `last_contact`, epoch
seconds) so the UI can show how old the position is: planes move ~6-9 km per
minute, so a stale position placed confidently would mislead.

Identification is a heuristic on the callsign, not a transponder type field, so
the UI wording says "identified as", never a bare assertion. Only telephony
families we can CITE are matched, and only when followed by a flight number —
`PELICAN 32`, not any callsign merely starting with those letters.

Verified national firefighting telephonies:
  France — Sécurité Civile
    PELICAN N → Canadair CL-415   (11 amphibious tankers)   [FR-1][FR-2]
    MILAN N   → Dash-8 Q400MR      (8 multirole tankers)     [FR-1][FR-2]
    MORANE N  → Beech King Air 200 (air coordination/lead)   [FR-2]
    DRAGON N  → EC145 / H145      (SC rescue+recon helicopter) [FR-3]
                (guarded by a French ICAO24 so the defunct "DRAGON"
                 airline telephony can't be mistaken for it)
  Italy — Protezione Civile / Vigili del Fuoco
    CAN N     → Canadair CL-415   (fleet operated by Avincis) [IT-1]

NOTE ON COUNTS: a marker is an aircraft AIRBORNE with ADS-B on right now, not
the fleet. France's ~24 Canadair + ~10 Dash-8 sit parked with transponders off
until launched, so most of the fleet is invisible between missions — expect a
handful of dots, more during an active fire, not the full roster.

Sources:
  [FR-1] FFVL Sécurité Civile bombing-safety briefing (Dash-8 = "MILAN").
  [FR-2] AerialFire, "The Fire Guards of the Sécurité Civile" (2025):
         Pélican = CL-415, Milan = Dash-8, Morane = coordination.
  [FR-3] feuxdeforet.fr / Ministère de l'Intérieur: SC "Dragon" EC145/H145.
  [IT-1] Reporting of Italian CL-415 callsign "CAN28".

Deliberately NOT matched (would risk badging non-firefighting aircraft):
  - Generic words BOMBER / CANADAIR / TANKER — mostly military/exercise/warbird.
  - Spain (43 Grupo), Greece (Hellenic AF), Croatia (855th Sqn): their fleets
    fly on military or registration-based callsigns with no stable public
    telephony we can match by prefix without false positives. Left out rather
    than guessed; add here only with a citation.
"""
from __future__ import annotations

import json
import re
from typing import Callable

OPENSKY_URL = "https://opensky-network.org/api/states/all"
# Europe + Mediterranean rim.
EUROPE = {"lamin": 34.0, "lomin": -12.0, "lamax": 60.0, "lomax": 30.0}

# Anchored: family word, optional space, then at least one digit (a flight
# number). This rejects a foreign/airline callsign that merely shares the
# leading letters (e.g. a hypothetical "MILANAIR").
CALLSIGN_FAMILIES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"^PELICAN\s?\d"), "Canadair CL-415", "water bomber"),
    (re.compile(r"^MILAN\s?\d"), "Dash-8 Q400MR", "water bomber"),
    (re.compile(r"^MORANE\s?\d"), "Beech King Air 200", "air coordination"),
    (re.compile(r"^CAN\s?\d"), "Canadair CL-415", "water bomber"),
]

# Sécurité Civile helicopters. OpenSky truncates the telephony, so accept both
# "DRAGON 34" and the shortened "DRAG75S" form. GUARDED by a French-registration
# ICAO24 (0x380000–0x3BFFFF → hex "38".."3b") so the defunct Dragonair airline
# callsign "DRAGON" — a Hong Kong ICAO24 — cannot be misread as a fire helo.
HELI_PATTERN = re.compile(r"^DRAG(ON)?\s?\w*\d")


def _is_french_icao24(icao24: str | None) -> bool:
    h = (icao24 or "").lower()
    return len(h) >= 2 and h[0] == "3" and h[1] in "89ab"


def classify(callsign: str, icao24: str | None = None) -> tuple[str, str] | None:
    cs = (callsign or "").strip().upper()
    for pattern, kind, role in CALLSIGN_FAMILIES:
        if pattern.match(cs):
            return kind, role
    if HELI_PATTERN.match(cs) and _is_french_icao24(icao24):
        return "EC145 / H145", "rescue helicopter"
    return None


def fetch_aircraft(http_text: Callable[[str], str] | None = None) -> list[dict]:
    """Return firefighting aircraft with position, heading, speed, altitude."""
    if http_text is None:
        import requests

        def http_text(url: str) -> str:  # pragma: no cover - network
            r = requests.get(url, timeout=45)
            r.raise_for_status()
            return r.text

    q = "&".join(f"{k}={v}" for k, v in EUROPE.items())
    try:
        data = json.loads(http_text(f"{OPENSKY_URL}?{q}"))
    except Exception:  # noqa: BLE001 - tracker is an overlay, never fatal
        return []

    out: list[dict] = []
    for s in data.get("states") or []:
        # State vectors can be short/malformed; skip a bad row rather than
        # letting one IndexError drop the whole layer.
        try:
            callsign = (s[1] or "").strip()
            kind = classify(callsign, s[0])
            if kind is None:
                continue
            lon, lat = s[5], s[6]
            if lon is None or lat is None:
                continue
            out.append(
                {
                    "icao24": s[0],
                    "callsign": callsign,
                    "country": s[2],
                    "lon": round(lon, 4),
                    "lat": round(lat, 4),
                    "alt_m": None if s[7] is None else round(s[7]),
                    "on_ground": bool(s[8]),
                    "speed_kmh": None if s[9] is None else round(s[9] * 3.6),
                    "heading": None if s[10] is None else round(s[10]),
                    # OpenSky last_contact (epoch s): how old this position is.
                    "pos_time": s[4],
                    "type": kind[0],
                    "role": kind[1],
                }
            )
        except (IndexError, TypeError):
            continue
    return out
