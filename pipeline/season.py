"""Aggregate the EFFIS perimeter archive into a season total.

Geography is decided by the country attribute ONLY. There is deliberately no
geometric fallback: config.EUROPE_BBOX starts at 34 degrees north and admits
Algiers (36.7N), Tunis (36.8N) and Rabat (34.0N), and no latitude cut separates
Tunis from Sicily. A perimeter whose country we cannot resolve is excluded and
counted as unassigned — never guessed into a number people will quote.
"""
from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from .store import _sql_path, connect

# Canonical name -> every spelling we accept for it. ISO-2, ISO-3, the EU's
# non-ISO "EL" for Greece and "UK" for the United Kingdom, and local names.
_COUNTRY_ALIASES: dict[str, tuple[str, ...]] = {
    "Albania": ("AL", "ALB", "albania", "shqiperia"),
    "Andorra": ("AD", "AND", "andorra"),
    "Austria": ("AT", "AUT", "austria", "osterreich", "Österreich"),
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
    "Iceland": ("IS", "ISL", "iceland", "island", "Ísland"),
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
    "Spain": ("ES", "ESP", "spain", "espana", "España"),
    "Sweden": ("SE", "SWE", "sweden", "sverige"),
    "Switzerland": ("CH", "CHE", "switzerland", "schweiz", "suisse"),
    "Ukraine": ("UA", "UKR", "ukraine"),
    "United Kingdom": ("UK", "GB", "GBR", "united kingdom", "great britain"),
}
# Deliberately absent: Turkey and Russia (overwhelmingly outside Europe, and
# EFFIS covers both), and the whole Maghreb. Their area lands in
# `unassigned_count`, so the page must SAY so: scale_render.ts prints the scope
# in the kicker ("excluding Russia and Turkey") and names out-of-scope countries
# in the exclusion line. Without that copy the reader sees deliberate scope
# reported as missing data.

_LOOKUP: dict[str, str] = {}


def _fold(value: str) -> str:
    """Strip accents so 'España' matches 'espana'."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip().lower()


# Build lookup table with folded keys so accent variants all resolve.
for _canonical, _aliases in _COUNTRY_ALIASES.items():
    for _alias in (_canonical, *_aliases):
        _LOOKUP[_fold(_alias)] = _canonical


def normalize_country(value: str | None) -> str | None:
    """Canonical English name for a country we cover, else None."""
    if not value:
        return None
    return _LOOKUP.get(_fold(str(value)))


def _polled_at(con, path: Path) -> datetime | None:
    """When EFFIS was last POLLED, from the snapshot's own `fetched_at` column.

    This is the only honest "as of" date for the page. The export time is not:
    the pipeline runs every 15 minutes, so dating the archive by the run would
    tick the published date forward forever while the snapshot underneath it sat
    weeks old — the page confidently calling a three-week-old figure current.
    The same column already gates refetching (fetch_effis_season.should_fetch).

    None when the column is missing or empty (a snapshot written by an older
    version, or a zero-row file, which carries no attribute schema at all). The
    caller falls back rather than inventing a date.
    """
    try:
        newest = con.execute(
            f"SELECT max(fetched_at) FROM read_parquet('{_sql_path(path)}')"
        ).fetchone()[0]
    except Exception:  # noqa: BLE001 - no fetched_at column is a fallback, not a failure
        return None
    if not isinstance(newest, datetime):
        return None
    # Stored naive UTC (store._naive_utc). Re-attach the zone here so the
    # published ISO string carries an offset: a bare "2026-07-12T04:11:00" is
    # parsed as LOCAL time by the browser and can print the wrong day.
    return newest.replace(tzinfo=timezone.utc) if newest.tzinfo is None else newest


def season_totals(path: Path, year: int, top_n: int = 5) -> dict | None:
    """Season total, per-country ranking, the two exclusion counts, and the
    moment the archive was last polled.

    Returns None when no snapshot exists — the caller renders "unavailable",
    which is a different thing from a total of zero.

    The country list is the top `top_n` by area and is not expected to
    reconcile with `total_km2` (rounding is independent; top_n is a slice).

    `undated_count` is archive-wide across all years, not season-scoped,
    because an undated row has no year to filter on.

    `fetched_at` is the snapshot's own poll time (see `_polled_at`), or None
    when the snapshot cannot say. It is what the page dates itself by.
    """
    if not path.exists():
        return None
    con = connect()
    try:
        rows = con.execute(
            f"SELECT area_ha, firedate, country FROM read_parquet('{_sql_path(path)}')"
        ).fetchall()
        polled_at = _polled_at(con, path)

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
                # Undated rows are archive-wide, not season-scoped.
                undated += 1
                continue
            if firedate.year != year:
                continue
            # Skip rows with null or unparseable area.
            if area_ha is None:
                unassigned += 1
                continue
            name = normalize_country(country)
            if name is None:
                unassigned += 1
                continue
            try:
                area_value = float(area_ha)
            except (TypeError, ValueError):
                unassigned += 1
                continue
            total_ha += area_value
            area_count += 1
            by_country.setdefault(name, []).append(area_value)

        # Sort by area descending, then by name for determinism (no tie-breaking
        # on dict insertion order).
        countries = sorted(
            ({"name": n, "km2": round(sum(a) / 100.0, 1), "areas": len(a)}
             for n, a in by_country.items()),
            key=lambda c: (-c["km2"], c["name"]),
        )
        return {
            "season_year": year,
            "fetched_at": polled_at,
            "total_km2": round(total_ha / 100.0, 1),
            "area_count": area_count,
            "unassigned_count": unassigned,
            "undated_count": undated,
            "countries": countries[:top_n],
        }
    finally:
        con.close()
