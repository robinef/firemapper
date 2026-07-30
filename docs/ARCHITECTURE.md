# Architecture

FireMapper has no backend. A Python pipeline fetches satellite fire data, stores
it locally, and writes **static files**; a browser app renders them. The
"database" is [DuckDB](https://duckdb.org/) running in-process, and the storage
format is GeoParquet on disk.

```
satellite / API sources
        │  fetch
        ▼
data/raw/*.parquet ──────── GeoParquet + geometry + H3 keys (the local store)
        │  cluster + measure
        ▼
web/public/data/gen-<ts>/ ── static JSON / GeoJSON artifacts + manifest.json
        │  read
        ▼
MapLibre frontend (web/) ─── static site
```

## Why this shape

- **Local-first.** Everything works offline from the local store; no service to
  operate, nothing to pay for, easy to fork and run.
- **Static output.** The map is plain files behind a CDN, so hosting is trivial
  and the app cannot be taken down by a backend outage.
- **Reproducible.** Each pipeline run writes a new immutable `gen-<timestamp>/`
  directory. `manifest.json` is written **last**, atomically, so a client polling
  during a run never sees a half-published generation.

## Data sources

| Source | Role | Key needed |
|--------|------|------------|
| NASA FIRMS (VIIRS / MODIS) | detections, area, growth, real ignition dates | free map key |
| Meteosat MTG FCI (EUMETView) | ~10-minute liveness, fire radiative power | none |
| Open-Meteo | wind direction and speed | none |
| OpenSky Network | firefighting aircraft (ADS-B) | none |
| NASA GIBS | before/after true-colour imagery (~250 m) | none |
| Copernicus Sentinel-2 (CDSE) | optional HD before/after imagery (10 m) | optional |
| GeoNames `cities15000` | nearest-town labels | none |

Every source is wrapped so a failure degrades instead of breaking the run: a
dead endpoint yields an empty layer, and the rest of the map still publishes.
EFFIS burned areas are wired in the same way, but its backend is frequently
offline, so it is treated as a bonus tier rather than a dependency.

## Storage: GeoParquet + DuckDB

Everything fetched persists under `data/raw/` as GeoParquet — `hotspots.parquet`
(the detection archive) plus one snapshot file per live layer:

- A `geometry` column (`POINT(lon lat)`, WGS84) with the standard `geo` metadata,
  so the store is a first-class spatial dataset readable by any GeoParquet tool.
- **Precomputed H3 keys** at several resolutions (`h3_r4`, `h3_r6`, `h3_r7`,
  `h3_r8`). Coarse keys are the exact H3 parents of finer ones, so
  `GROUP BY h3_r4` is a consistent regional roll-up, and clustering never
  recomputes cell ids.
- Deduplication by `src_id`, which makes ingestion **incremental**: repeated runs
  only fetch and append what is new.

All reads and writes go through one place (`pipeline/store.py`), which owns the
DuckDB connection and loads the `spatial` extension (plus the community `h3`
extension when adjacency math is needed).

## Turning detections into fires

A satellite gives you isolated hot pixels, not fires. `pipeline/events.py` builds
fire *events*:

1. **Adjacency in SQL.** Detections in the same or a neighbouring H3 cell, within
   a 48-hour window, belong to the same fire. The edge set is computed in DuckDB
   (`h3_grid_disk` over the stored keys); Python only runs the union-find over
   those edges. A differential test asserts this matches a pure-Python reference
   exactly.
2. **Sensor fusion.** VIIRS/MODIS own geometry and ignition dates — a fire
   watched for days carries its real first-detection time. A Meteosat pixel
   sitting on top of a polar fire is the *same* fire and only contributes
   liveness; a Meteosat pixel with no polar fire nearby becomes its own fresh
   fire, so newly-ignited fires appear within minutes.
3. **Stable identity.** An event id is seeded from its earliest detection, so a
   fire keeps the same id as it grows, and merges keep the older id. Lineage
   (merges, reactivations) is exported alongside.
4. **Measurement.** Area from unique cells, growth and acceleration from
   per-6-hour bins, spread direction and speed from the local age gradient.

## Frontend

`web/` is Vite + TypeScript + MapLibre GL on a keyless basemap. Two rules shape
it:

- **One layer answers one question**, owns its own legend, and its legend is only
  shown while the layer is on — so two colour codings can never compete. See
  [cartography-rules.md](cartography-rules.md).
- **Two levels.** The overview shows coarse "where are the fires" layers; opening
  a fire switches the panel to that fire's detail layers and hides the
  overview-only ones. Each layer module declares which levels it belongs to.

Layers live in `web/src/layer_*.ts`, one module per layer. The per-fire view is
`web/src/firecard.ts`; the bottom histogram is `web/src/timeline.ts`.

## Repository layout

```
pipeline/      data pipeline
  store.py       GeoParquet + DuckDB storage, H3 key ladder
  events.py      clustering, sensor fusion, lifecycle
  fetch_*.py     one module per source
  export.py      writes the static artifacts + manifest
  run.py         orchestration (process / refresh / watch / bench)
web/           frontend (src/layer_*.ts, firecard.ts, timeline.ts)
tests/         pipeline tests (pytest)
web/tests/     frontend tests (vitest)
scripts/       make_sample.py — keyless demo dataset
docs/          this file, cartography rules, deployment
```

## Testing

```bash
make test    # pytest + tsc --noEmit + vitest
```

CI runs the same on every push and pull request. Behaviour changes should come
with a test; the pipeline's trickier invariants (clustering equivalence, atomic
publish, dedup, source failure handling) are covered that way.
