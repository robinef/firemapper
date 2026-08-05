"""Local geospatial storage: everything we fetch lands in GeoParquet on disk and
is queried through DuckDB's spatial extension. One place owns the connection and
the geometry convention (a POINT(lon lat) column, WGS84), so the rest of the
pipeline never touches raw parquet or re-implements dedup.

Why GeoParquet + DuckDB: local-first, no server, columnar + compressed, and the
geometry column makes the store a first-class spatial dataset — bbox/near
queries, joins, and interchange with any GeoParquet reader come for free.
"""
from __future__ import annotations

from datetime import timezone
from pathlib import Path

import duckdb
import h3

# The canonical hotspot columns (order matters for positional INSERT). Geometry
# and the H3 keys are derived on write, so they are not in this list.
HOTSPOT_COLS = [
    "lat", "lon", "acq_time", "tier", "satellite", "confidence", "frp", "src_id",
]

# H3 clustering keys precomputed at ingest and stored as columns, so nothing
# downstream recomputes cell ids on every run:
#   r8 (~0.5 km) — VIIRS/MODIS event clustering
#   r7 (~1.2 km) — Meteosat clustering + cross-sensor overlap
#   r6, r4       — coarse cells for fast regional filtering / aggregation
# Coarser keys are the exact H3 parents of finer ones, so a GROUP BY h3_r4 is a
# consistent roll-up of the r8 cells beneath it.
H3_LEVELS = [4, 6, 7, 8]
H3_COLS = [f"h3_r{r}" for r in H3_LEVELS]


def h3_keys(lat: float, lon: float) -> list[str]:
    """The H3 cell ids for a point, one per stored level (H3_LEVELS order)."""
    return [h3.latlng_to_cell(lat, lon, r) for r in H3_LEVELS]


def cell_at(row: dict, res: int) -> str:
    """A row's H3 cell at `res` — the precomputed column if present (stored rows),
    else computed on the fly (e.g. live MTG pixels that never hit the store)."""
    return row.get(f"h3_r{res}") or h3.latlng_to_cell(row["lat"], row["lon"], res)


def connect() -> duckdb.DuckDBPyConnection:
    """A DuckDB connection with the spatial extension loaded (ST_*, GeoParquet)."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    return con


def connect_h3() -> duckdb.DuckDBPyConnection:
    """As connect(), plus the community h3 extension (h3_* cell math) — only the
    adjacency clustering needs it, so plain reads/writes stay free of it."""
    con = connect()
    con.execute("INSTALL h3 FROM community; LOAD h3;")
    return con


def _sql_path(p: Path) -> str:
    return str(p).replace("'", "''")


def _parquet_columns(con, store: Path) -> list[str]:
    return [
        c[0] for c in con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{_sql_path(store)}')"
        ).fetchall()
    ]


def read_hotspots(store: Path) -> list[dict]:
    """Hotspot rows from the GeoParquet store: base columns plus the stored H3
    keys (h3_r4/6/7/8), so clustering reuses them instead of recomputing. The
    geometry column is omitted (H3 + lat/lon is all clustering needs). Empty list
    when the store is absent."""
    if not store.exists():
        return []
    con = connect()
    have = _parquet_columns(con, store)
    sel = HOTSPOT_COLS + [c for c in H3_COLS if c in have]
    cur = con.execute(f"SELECT {', '.join(sel)} FROM read_parquet('{_sql_path(store)}')")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    for r in rows:
        if r["acq_time"].tzinfo is None:  # stored naive UTC
            r["acq_time"] = r["acq_time"].replace(tzinfo=timezone.utc)
    return rows


_INS_COLS = HOTSPOT_COLS + H3_COLS
_COLDEFS = (
    "lat DOUBLE, lon DOUBLE, acq_time TIMESTAMP, tier VARCHAR, satellite VARCHAR, "
    "confidence VARCHAR, frp DOUBLE, src_id VARCHAR, "
    + ", ".join(f"{c} VARCHAR" for c in H3_COLS)
)
_PLACEHOLDERS = ",".join(["?"] * len(_INS_COLS))


def _hot_values(r: dict) -> list:
    return [
        r["lat"], r["lon"], _naive_utc(r["acq_time"]), r["tier"], r["satellite"],
        r["confidence"], r["frp"], r["src_id"], *h3_keys(r["lat"], r["lon"]),
    ]


def append_hotspots(rows: list[dict], store: Path) -> int:
    """Append new hotspots to the GeoParquet store, deduped by src_id. Returns
    the number of genuinely new rows. Precomputes the H3 key ladder and a
    POINT(lon lat) geometry column, so the store stays valid GeoParquet with
    cluster keys regardless of the previous file's schema (an old file missing
    the H3 columns is migrated in place on first write)."""
    if not rows:
        return 0
    store.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.execute(f"CREATE TABLE incoming({_COLDEFS})")
    con.executemany(
        f"INSERT INTO incoming VALUES ({_PLACEHOLDERS})", [_hot_values(r) for r in rows]
    )
    if store.exists() and all(c in _parquet_columns(con, store) for c in H3_COLS):
        con.execute(
            f"CREATE TABLE existing AS SELECT {', '.join(_INS_COLS)} "
            f"FROM read_parquet('{_sql_path(store)}')"
        )
    elif store.exists():
        # Old store without H3 keys: pull base rows and compute the ladder once.
        con.execute(f"CREATE TABLE existing({_COLDEFS})")
        base = con.execute(
            f"SELECT {', '.join(HOTSPOT_COLS)} FROM read_parquet('{_sql_path(store)}')"
        ).fetchall()
        names = HOTSPOT_COLS
        con.executemany(
            f"INSERT INTO existing VALUES ({_PLACEHOLDERS})",
            [_hot_values(dict(zip(names, row))) for row in base],
        )
    else:
        con.execute("CREATE TABLE existing AS SELECT * FROM incoming LIMIT 0")
    new = con.execute(
        "SELECT count(*) FROM incoming WHERE src_id NOT IN (SELECT src_id FROM existing)"
    ).fetchone()[0]
    con.execute(
        f"""COPY (
              SELECT *, ST_Point(lon, lat) AS geometry FROM (
                SELECT * FROM existing
                UNION ALL
                SELECT DISTINCT ON (src_id) * FROM incoming
                WHERE src_id NOT IN (SELECT src_id FROM existing)
              )
            ) TO '{_sql_path(store)}' (FORMAT PARQUET)"""
    )
    return int(new)


def write_points(rows: list[dict], path: Path, lon_key: str = "lon", lat_key: str = "lat") -> int:
    """Persist a live layer (MTG FRP / wind / aircraft) as a GeoParquet snapshot
    — overwrites, so it is always the latest. Scalar dict fields become columns;
    a POINT(lon lat) geometry column is added. Returns the row count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    if not rows:
        # Still emit an (empty) file so downstream tooling can rely on it existing.
        con.execute(
            f"COPY (SELECT NULL::DOUBLE AS {lon_key}, NULL::DOUBLE AS {lat_key}, "
            f"NULL::GEOMETRY AS geometry WHERE false) TO '{_sql_path(path)}' (FORMAT PARQUET)"
        )
        return 0
    import pyarrow as pa

    cols = sorted({k for r in rows for k in r})
    table = pa.Table.from_pylist([{c: r.get(c) for c in cols} for r in rows])
    con.register("src", table)
    con.execute(
        f"COPY (SELECT *, ST_Point({lon_key}, {lat_key}) AS geometry FROM src) "
        f"TO '{_sql_path(path)}' (FORMAT PARQUET)"
    )
    return len(rows)


def write_polygons(rows: list[dict], path: Path, geom_key: str = "geometry_wkt") -> int:
    """Persist burn perimeters as a GeoParquet snapshot — overwrites, so it is
    always the latest complete fetch. Scalar dict fields become columns; the WKT
    in `geom_key` becomes a POLYGON/MULTIPOLYGON geometry column and is itself
    dropped. Returns the row count. Empty snapshots carry no attribute schema, so
    callers must treat a zero-row file as having no columns guaranteed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    if not rows:
        # Still emit an (empty) file so downstream tooling can rely on it existing.
        con.execute(
            f"COPY (SELECT NULL::GEOMETRY AS geometry WHERE false) "
            f"TO '{_sql_path(path)}' (FORMAT PARQUET)"
        )
        return 0
    import pyarrow as pa

    cols = sorted({k for r in rows for k in r} - {geom_key})
    table = pa.Table.from_pylist(
        [{**{c: r.get(c) for c in cols}, geom_key: r.get(geom_key)} for r in rows]
    )
    con.register("src", table)
    con.execute(
        f"COPY (SELECT {', '.join(cols)}, ST_GeomFromText({geom_key}) AS geometry FROM src) "
        f"TO '{_sql_path(path)}' (FORMAT PARQUET)"
    )
    return len(rows)


def _naive_utc(t):
    """Store timestamps as naive UTC (DuckDB TIMESTAMP has no tz), avoiding a
    pytz dependency on read-back."""
    if t.tzinfo is not None:
        return t.astimezone(timezone.utc).replace(tzinfo=None)
    return t
