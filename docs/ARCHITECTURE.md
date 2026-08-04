# Architecture

FireMapper has no application backend. A Python pipeline fetches satellite fire
data, stores it as GeoParquet, and writes **static artifacts**; a browser app
renders them. The "database" is [DuckDB](https://duckdb.org/) running
in-process. The only server-side component is a Cloudflare Worker that reads
published artifacts out of an object store — it holds no logic and no state.

```
satellite / API sources
        │  fetch
        ▼
data/raw/*.parquet ──────── GeoParquet + geometry + H3 keys (the store)
        │  cluster + measure
        ▼
<out_dir>/gen-<ts>/ ─────── static JSON / GeoJSON artifacts + manifest.json
        │  publish (deployed) / read directly (local dev)
        ▼
R2 bucket ──── Worker /data/* ──── MapLibre frontend (web/)
```

Locally, `<out_dir>` is `web/public/data` and Vite serves it directly — no
bucket, no Worker, no credentials. Deployed, the same directory is published to
R2 by CI every 15 minutes. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Why this shape

- **Local-first.** Everything works offline from the local store; nothing to
  operate to develop against, easy to fork and run.
- **Static output.** The map is plain files behind a CDN. There is no request
  path that can compute a wrong answer under load.
- **Reproducible.** Each pipeline run writes a new immutable `gen-<timestamp>/`
  directory. `manifest.json` is written **last**, atomically, so a client polling
  during a run never sees a half-published generation. Publishing to R2 preserves
  that ordering across the network.

## Freshness contract

Every layer records how old it is, and the UI is required to say so. Three
timestamps per layer, deliberately distinct: `attempted_at` (we tried),
`fetched_at` (data arrived), `observed_at` (the newest observation *inside* the
data). Only the last one answers "how old is this satellite detection".

| Layer | Source | Age budget | Carried on failure? |
|---|---|---|---|
| `events` | VIIRS + MTG fused | 3 h | yes, up to 6 h |
| `frp` | Meteosat MTG FCI | 1 h | yes, up to 2 h |
| `wind` | Open-Meteo | 3 h | yes, up to 6 h |
| `aircraft` | OpenSky ADS-B | 20 min | **never** |
| `timeline` | archive | 24 h | yes, up to 48 h |
| `imagery` | GIBS + EFFIS + curated | 7 d | yes, up to 14 d |

Rules that fall out of it:

- **Only failures are carried.** A fetch that succeeds and returns nothing is
  the truth and replaces what came before — a quiet winter must not render as
  last week's fires.
- **Carried data expires** at twice its budget, so a dead feed cannot leave
  ghost data on the map indefinitely.
- **Aircraft is never carried.** A stale plane position is a false claim about
  where an aircraft is, not degraded data. Grounded aircraft and fixes older
  than the budget are dropped in the pipeline, before they reach the map.
- **The header badge is computed from fire sources only** (`events`, `frp`). A
  successful wind fetch says nothing about whether we can still see fires.
- **Derived layers inherit their source's staleness**: spread arrows and
  isochrones are computed from FRP pixels, so stale pixels grey them too.

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
- **Two levels, one stack.** The overview shows coarse "where are the fires"
  layers; opening a fire switches the panel to that fire's detail layers and
  hides the overview-only ones. Each layer module declares which levels it
  belongs to. Navigation between levels goes through `web/src/nav.ts`, a
  history-backed view stack: going forward pushes an entry directly, while
  going *back* happens only through `popstate` — which is what makes the "‹"
  buttons, the Escape key and the hardware back gesture one operation instead
  of three that drift apart. `web/src/shell.ts` owns everything that is chrome
  rather than content: the icon rail, the `#view` container, the back bars and
  the map's camera padding.

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
