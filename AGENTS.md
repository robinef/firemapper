# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

**Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first** — it explains the
pipeline, the storage model, the clustering, the frontend structure and the
repository layout. This file only adds the working conventions on top of it.

Other references: [`README.md`](README.md) (what the project is),
[`docs/cartography-rules.md`](docs/cartography-rules.md) (map-design constraints),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (how the live site is built and hosted).

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
- **Navigation goes through `nav.ts`.** Don't dismiss a view from outside by
  calling its `close()` — that leaves the history entry standing, so the next
  hardware back does nothing visible. Call `nav.back()` and let the stack run
  the view's teardown. A view's own dismiss control may call its own teardown
  directly, provided that teardown announces itself on the `ui_events` bus:
  `shell.ts` turns that announcement into the `nav.back()`. `firecard.ts`'s ✕
  is the worked example — it closes, emits `detail:close`, and the shell pops.
- **Secrets** (FIRMS key, Sentinel Hub instance id) live only in `.env`
  (gitignored). Never commit them or put them in code, tests, or commit messages.
  Tests use synthetic data.
- After changing pipeline output, regenerate with `make_sample` and verify the
  map in the browser.

## Definition of done

`uv run --with pytest pytest -q` **and** (`cd web && npx tsc --noEmit && npm test`)
are green. Add a test with any behaviour change.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Two things matter when touching
it: `web/dist` is currently a **committed build artifact** (so served data is a
static snapshot until rebuilt), and `SENTINELHUB_INSTANCE_ID` must **never** reach a browser or the pipeline — it is a
bearer token for a whole Sentinel Hub configuration, so it lives only as a Worker
secret and tiles are proxied at `/hd` (see docs/DEPLOYMENT.md).
