# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

**Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first** — it explains the
pipeline, the storage model, the clustering, the frontend structure and the
repository layout. This file only adds the working conventions on top of it.

Other references: [`README.md`](README.md) (what the project is),
[`docs/cartography-rules.md`](docs/cartography-rules.md) (map-design constraints),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (how the live site is built and hosted).

## Setup & commands

Requirements: [uv](https://docs.astral.sh/uv/) (Python 3.12) and **Node 24**
(jsdom 30 will not run on Node 20). `make setup` installs both sides and
downloads the GeoNames `cities5000` gazetteer that fire naming needs.

```bash
make test                                   # pytest + tsc --noEmit + vitest — the CI gate
uv run --with pytest pytest -q              # pipeline tests alone (first run pulls DuckDB's
                                            #   spatial + h3 extensions over the network)
uv run python -m scripts.make_sample        # keyless demo dataset → web/public/data (gitignored)
uv run python -m pipeline.run refresh fast  # live layers only: MTG FRP, wind, re-cluster; no key
uv run python -m pipeline.run refresh full  # + FIRMS archive, EFFIS, imagery (needs FIRMS_MAP_KEY)
uv run python -m pipeline.run watch|bench   # loop / timing
```

Web (`cd web` first):

```bash
npm ci
npm run dev        # Vite on http://localhost:5173 — run make_sample first or the map is empty
npx tsc --noEmit   # typecheck
npm test           # vitest (unit, jsdom/node) — also covers worker/*.ts
npm run smoke      # Playwright against the BUILT bundle; builds dist itself, needs make_sample
                   #   data and `npx playwright install chromium` once
```

Two runners, two directories: `web/tests/*.test.ts` is vitest, `web/smoke/*.spec.ts`
is Playwright. Don't put one kind in the other's folder.

Python style is `ruff`, line length 100 (`pyproject.toml`); not enforced in CI.

## Layout beyond ARCHITECTURE.md

- `worker/` — the Cloudflare Worker that serves the site: `/data/*` → R2 bucket,
  `/hd` → Sentinel Hub tile proxy, `/api/historical-hotspots` and `/api/geocode`
  → FIRMS/geocoder proxies for the historical lookup. Routes in `worker/index.ts`,
  config in `wrangler.jsonc`, tests in `web/tests/worker*.test.ts` and
  `wrangler_routes.test.ts`.
- `scripts/` — `make_sample` (demo data), `refresh_remote` (what the CI refresh
  workflows actually run: hydrate from R2, refresh, publish), `watchdog`
  (hourly liveness check), `replay_static_sources`, `purge_offshore_hotspots`,
  `backfill_season` (one-off Jan–Jun 2026 track backfill from FIRMS SP).
- `tests/synth.py` (`hs()`, `T()`) builds synthetic hotspots; `tests/conftest.py`
  has the `export_gen` fixture. Use these instead of real data in tests.

## Conventions

- **Storage is DuckDB + GeoParquet.** Everything fetched persists under
  `data/raw/*.parquet` with a `geometry` column and precomputed H3 keys
  (`h3_r4/6/7/8`). Query through `pipeline/store.py::connect()` — don't hand-roll
  parquet reads. `connect_h3()` adds the community `h3` extension for adjacency.
- **Clustering** groups detections into events by H3 adjacency + a 48 h window; a second pass (polar tier only) lets fires of ≥20 cells bridge a one-cell gap (`BRIDGE_K`/`BRIDGE_MIN_CELLS` in `pipeline/events.py`).
- **Static heat sources** (flares, refineries, oil fields, volcanoes) chain into fake months-long "fires" once history is bounded by `MAX_FIRE_DAYS` rather than the display window. A cell detected on ≥`STATIC_CELL_DAYS` distinct days is fixed, not a wildfire (a real fire's front moves); every detection in such a cell or its `STATIC_RING_K` ring (geolocation jitter) is removed from the rows *before* clustering, so it never reaches events, scars, the timeline or the day-slice histogram, whatever event it would have joined (`pipeline/events.py::static_cells`/`static_zone`, `pipeline/config.py`). Global and cell-level on purpose: an earlier event-level share rule let a real fire that spread past a steelworks keep the plant's daily pings as a minority of its members and stay "active" for weeks. The **live FRP heatmap is deliberately exempt** — it is the raw 10-min sensor layer; a flare renders as a hot pixel there, never as a fire event. Verify a filter change with `uv run python -m scripts.replay_static_sources <hotspots.parquet>` against a real archive.
  Both passes build their edges in SQL (`events._edges_sql`, `events._bridge_edges_sql`); a differential test
  guards that they match a pure-Python reference exactly.
- **`area_km2` is cells × sensor cell size** — 0.7 km² per VIIRS cell, 5.2 km² per
  Meteosat cell (`pipeline/export.py::size_class`). A threshold that falls
  between those two classifies fires by which satellite saw them, not by size.
- **Sensor fusion:** VIIRS/MODIS own event geometry + ignition dates; live
  Meteosat MTG adds low-latency liveness and catches fresh fires.
- **Generations, not overwrites.** Each refresh publishes `data/gen-<ts>/` plus a
  new `manifest.json`; only `GENERATIONS_KEPT` live generations are retained, so
  anything that must outlive that window goes in `archive/` (`pipeline/archive_tracks.py`,
  `archive_footprints.py`).
- **Frontend layers** each answer one question and own their legend; the switcher
  shows overview (Level 1) vs per-fire detail (Level 2) sets.
- **maplibre stacks new layers on top.** Two layers created lazily end up ordered
  by which fire was opened first, and no unit test sees it. Pass `beforeId` or
  `moveLayer` explicitly (see `layer_wind.ts`) whenever a layer must sit under another.
- **Navigation goes through `nav.ts`.** Don't dismiss a view from outside by
  calling its `close()` — that leaves the history entry standing, so the next
  hardware back does nothing visible. Call `nav.back()` and let the stack run
  the view's teardown. A view's own dismiss control may call its own teardown
  directly, provided that teardown announces itself on the `ui_events` bus:
  `shell.ts` turns that announcement into the `nav.back()`. `firecard.ts`'s ✕
  is the worked example — it closes, emits `detail:close`, and the shell pops.
- **Secrets** (FIRMS key, EUMETSAT, R2) live only in `.env` (gitignored; see
  `.env.example`). Never commit them or put them in code, tests, or commit
  messages. Tests use synthetic data.
- **Verify in a browser, not just tests.** After changing pipeline output or a
  layer, regenerate with `make_sample` and look at the map. Failures here are
  silent: a missing maplibre worker, a layer with `maxzoom` too low, or an
  overlapping panel all ship with tsc, vitest and a 200 response green. A blank
  layer is also often *correct* (no wind in range, no live FRP for most fires) —
  check the source data before calling it a bug.

## Definition of done

`make test` is green (pytest, `tsc --noEmit`, vitest). For anything touching the
map, layout or the build, `npm run smoke` too — CI runs it on every PR, plus an
assertion that `maplibre-gl*.mjs` was emitted beside the bundle. Add a test with
any behaviour change, and confirm it fails without the fix.

## Shipping (review gate + auto-merge)

`main` is protected: a PR merges only when `pipeline (pytest)`,
`web (tsc + vitest + build)`, `web (browser smoke)`, CodeQL's `Analyze (*)`
jobs, the `CodeQL` code-scanning result (the one that fails on new alerts)
and a `claude-review` commit status are all green. Each check is pinned to
the app that produces it. No Claude credential lives in the repo or in
Actions — the review runs in the local agent session:

1. Push the branch and open the PR.
2. Run `/code-review` and `/security-review` on the pushed head. Fix findings,
   push, and review again — the status binds to one SHA, so every push needs
   a fresh review. Treat any workflow that asks for `statuses: write` or
   `checks: write` as a blocking finding: it could attest its own PR.
3. `firemapper-review-gate <pr> success "<one-line summary>"` (or `failure`)
   posts the status; it refuses fork PRs, a dirty tree, or a local HEAD that
   is not the PR head.
4. `gh pr merge --auto --squash --delete-branch <pr> --repo robinef/firemapper`
   queues the merge; GitHub performs it once every required check is green,
   and the merge deploys (see below). Keep one queued auto-merge at a time:
   branches are not required to be up to date, so two PRs queued together
   each pass against a `main` that lacks the other.

`firemapper-review-gate` is a copy of `scripts/review_gate.sh` installed from
`origin/main` into `~/.local/bin` — never run the file from a checkout, which
is the PR's own copy (see the script header). Re-install it after a merge that
changes the script. The permission rules that let the agent run it and queue
the merge live in user-level settings, not in this repo, for the same reason.

Fork PRs never get the status, so they wait for a human. Dependency review
runs on every PR as an advisory check.

## Deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Three things matter when touching it:

- `web/dist` is **gitignored and built in CI** — never plan a commit of build
  output. A deploy carries no data; a data refresh needs no deploy. Data lives in
  R2 and is written by the `refresh-fast` / `refresh-full` workflows.
- `SENTINELHUB_INSTANCE_ID` must **never** reach a browser or the pipeline — it
  is a bearer token for a whole Sentinel Hub configuration, so it lives only as a
  Worker secret and tiles are proxied at `/hd`.
- Deploys are not a GitHub workflow: Cloudflare Workers Builds deploys on push
  to `main`. Merging Worker or web code *is* the deploy; check the Cloudflare
  build log, not Actions, when it doesn't land.
