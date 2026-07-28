# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. See
[`README.md`](README.md) for the project overview.

## What this is

A local-first European wildfire map. A Python pipeline fetches satellite fire
data, clusters it into fire events, and writes **static GeoParquet + JSON/GeoJSON**
artifacts; a MapLibre frontend renders them. No server, no database daemon — the
"backend" is DuckDB running in-process and files on disk.

## Layout

```
pipeline/      Python data pipeline (fetch → cluster → export)
  store.py       DuckDB-spatial + GeoParquet storage (the one DB connection)
  events.py      H3 union-find clustering (adjacency built in DuckDB SQL)
  fetch_*.py     data sources: FIRMS, Meteosat MTG, wind, aircraft, imagery
  export.py      writes web/public/data/gen-*/ artifacts + manifest.json
  run.py         orchestration (process / refresh / watch)
web/           Vite + TypeScript + MapLibre GL frontend
  src/layer_*.ts   one module per map layer
  src/firecard.ts  the Level-2 per-fire detail view
tests/         pytest (pipeline)
web/tests/     vitest (frontend)
scripts/       make_sample.py — generate a local demo dataset
docs/          cartography-rules.md (design constraints)
```

## Setup & commands

Python (uses [uv](https://docs.astral.sh/uv/)):

```bash
uv run --with pytest pytest -q        # run the pipeline tests
uv run python -m scripts.make_sample  # build a local demo dataset into web/public/data
uv run python -m pipeline.run refresh # fetch live data + rebuild (needs a FIRMS key)
```

Web:

```bash
cd web
npm ci
npm run dev        # local dev server (Vite)
npx tsc --noEmit   # typecheck
npm test           # vitest
```

## Conventions

- **Storage is DuckDB + GeoParquet.** Everything fetched persists under
  `data/raw/*.parquet` with a `geometry` column and precomputed H3 keys
  (`h3_r4/6/7/8`). Query through `pipeline/store.py::connect()` — don't hand-roll
  parquet reads. `connect_h3()` adds the community `h3` extension for adjacency.
- **Clustering** groups detections into events by H3 adjacency + a 48 h window.
  The adjacency edges are built in SQL (`events._edges_sql`); a differential test
  guards that it matches a pure-Python reference exactly.
- **Sensor fusion:** VIIRS/MODIS own event geometry + ignition dates; live
  Meteosat MTG adds low-latency liveness and catches fresh fires.
- **Frontend layers** each answer one question and own their legend; the switcher
  shows overview (Level 1) vs per-fire detail (Level 2) sets.
- **Secrets** (FIRMS key, Sentinel Hub instance id) live only in `.env`
  (gitignored). Never commit them or put them in code, tests, or commit messages.
  Tests use synthetic data.
- After changing pipeline output, regenerate with `make_sample` and verify the
  map in the browser.

## Definition of done

`uv run --with pytest pytest -q` **and** (`cd web && npx tsc --noEmit && npm test`)
are green. Add a test with any behaviour change.
