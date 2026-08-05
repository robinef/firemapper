"""Aggregate the EFFIS perimeter archive into a season total.

Geography is decided by the country attribute ONLY. There is deliberately no
geometric fallback: config.EUROPE_BBOX starts at 34 degrees north and admits
Algiers (36.7N), Tunis (36.8N) and Rabat (34.0N), and no latitude cut separates
Tunis from Sicily. A perimeter whose country we cannot resolve is excluded and
counted as unassigned — never guessed into a number people will quote.
"""
from __future__ import annotations

import unicodedata
from pathlib import Path

from .store import connect

# Canonical name -> every spelling we accept for it. ISO-2, ISO-3, the EU's
# non-ISO "EL" for Greece and "UK" for the United Kingdom, and local names.
_COUNTRY_ALIASES: dict[str, tuple[str, ...]] = {
    "Albania": ("AL", "ALB", "albania", "shqiperia"),
    "Andorra": ("AD", "AND", "andorra"),
    "Austria": ("AT", "AUT", "austria", "osterreich"),
    "Belarus": ("BY", "BLR", "belarus"),
    "Belgium": ("BE", "BEL", "belgium", "belgie", "belgique"),
    "Bosnia and Herzegovina": ("BA", "BIH", "bosnia and herzegovina", "bosna i hercegovina"),
    "Bulgaria": ("BG", "BGR", "bulgaria"),
    "Croatia": ("HR", "HRV", "croatia", "hrvatska"),
    "Cyprus": ("CY", "CYP", "cyprus", "kypros"),
    "Czechia": ("CZ", "CZE", "czechia", "czech republic"),
    "Denmark": ("DK", "DNK", "denmark", "danmark"),
    "Estonia": ("EE", "EST", "estonia", "eesti"),
    "Finland": ("FI", "FIN", "finland", "suomi"),
    "France": ("FR", "FRA", "france"),
    "Germany": ("DE", "DEU", "germany", "deutschland"),
    "Greece": ("GR", "EL", "GRC", "greece", "ellada", "hellas"),
    "Hungary": ("HU", "HUN", "hungary", "magyarorszag"),
    "Iceland": ("IS", "ISL", "iceland", "island"),
    "Ireland": ("IE", "IRL", "ireland", "eire"),
    "Italy": ("IT", "ITA", "italy", "italia"),
    "Kosovo": ("XK", "XKX", "kosovo"),
    "Latvia": ("LV", "LVA", "latvia", "latvija"),
    "Liechtenstein": ("LI", "LIE", "liechtenstein"),
    "Lithuania": ("LT", "LTU", "lithuania", "lietuva"),
    "Luxembourg": ("LU", "LUX", "luxembourg"),
    "Malta": ("MT", "MLT", "malta"),
    "Monaco": ("MC", "MCO", "monaco"),
    "Moldova": ("MD", "MDA", "moldova"),
    "Montenegro": ("ME", "MNE", "montenegro", "crna gora"),
    "Netherlands": ("NL", "NLD", "netherlands", "nederland"),
    "North Macedonia": ("MK", "MKD", "north macedonia", "severna makedonija"),
    "Norway": ("NO", "NOR", "norway", "norge"),
    "Poland": ("PL", "POL", "poland", "polska"),
    "Portugal": ("PT", "PRT", "portugal"),
    "Romania": ("RO", "ROU", "romania"),
    "San Marino": ("SM", "SMR", "san marino"),
    "Serbia": ("RS", "SRB", "serbia", "srbija"),
    "Slovakia": ("SK", "SVK", "slovakia", "slovensko"),
    "Slovenia": ("SI", "SVN", "slovenia", "slovenija"),
    "Spain": ("ES", "ESP", "spain", "espana"),
    "Sweden": ("SE", "SWE", "sweden", "sverige"),
    "Switzerland": ("CH", "CHE", "switzerland", "schweiz", "suisse"),
    "Ukraine": ("UA", "UKR", "ukraine"),
    "United Kingdom": ("UK", "GB", "GBR", "united kingdom", "great britain"),
}
# Deliberately absent: Turkey and Russia (overwhelmingly outside Europe, and
# EFFIS covers both), and the whole Maghreb. The page caption says "Europe
# excluding Russia and Turkey" so the headline matches its own label.

_LOOKUP: dict[str, str] = {}
for _canonical, _aliases in _COUNTRY_ALIASES.items():
    for _alias in (_canonical, *_aliases):
        _LOOKUP[_alias.strip().lower()] = _canonical


def _fold(value: str) -> str:
    """Strip accents so 'España' matches 'espana'."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip().lower()


def normalize_country(value: str | None) -> str | None:
    """Canonical English name for a country we cover, else None."""
    if not value:
        return None
    return _LOOKUP.get(_fold(str(value)))


def season_totals(path: Path, year: int, top_n: int = 5) -> dict | None:
    """Season total, per-country ranking, and the two exclusion counts.

    Returns None when no snapshot exists — the caller renders "unavailable",
    which is a different thing from a total of zero."""
    if not path.exists():
        return None
    con = connect()
    rows = con.execute(
        f"SELECT area_ha, firedate, country FROM read_parquet('{path.as_posix()}')"
    ).fetchall()

    # area_count counts MAPPED PERIMETERS, not fires. Nothing establishes that
    # one ercc.ba feature is one fire — a single incident can be mapped as
    # several perimeters — so the field and the page copy both say "mapped burn
    # areas". Calling them fires would be a quotable number that is not true.
    total_ha = 0.0
    area_count = 0
    undated = 0
    unassigned = 0
    by_country: dict[str, list[float]] = {}

    for area_ha, firedate, country in rows:
        if firedate is None:
            undated += 1
            continue
        if firedate.year != year:
            continue
        name = normalize_country(country)
        if name is None:
            unassigned += 1
            continue
        total_ha += float(area_ha)
        area_count += 1
        by_country.setdefault(name, []).append(float(area_ha))

    countries = sorted(
        ({"name": n, "km2": round(sum(a) / 100.0, 1), "areas": len(a)}
         for n, a in by_country.items()),
        key=lambda c: c["km2"], reverse=True,
    )
    return {
        "season_year": year,
        "total_km2": round(total_ha / 100.0, 1),
        "area_count": area_count,
        "unassigned_count": unassigned,
        "undated_count": undated,
        "countries": countries[:top_n],
    }
