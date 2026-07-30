# FireMapper — European Wildfire Evolution Map

[![CI](https://github.com/robinef/firemapper/actions/workflows/ci.yml/badge.svg)](https://github.com/robinef/firemapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A **local-first** wildfire map for Europe, built to make one thing unmissable:
**fires are accelerating** — across the season and within each individual fire.
No server, no database daemon: a Python pipeline turns satellite fire data into
static files, and a MapLibre frontend renders them.

> ⚠ Satellite data is not an official alert. In danger call **112** and follow
> local authorities. This tool visualises public satellite data; it is not an
> emergency service.

## What it does

- **Overview** — every active fire and recent burn scar across Europe. A bottom
  histogram shows daily detections with a week-over-week trend; **click a day**
  to paint that day's fires across the continent.
- **Fire card** — click a fire to focus it: the map flies in, stats appear on the
  right (area, ignition, live status, peak intensity, spread, nearest town), and
  the histogram becomes that fire's own growth. Its footprint is coloured by
  **arrival time** (when each patch burned); click a bar to rewind it.
- **Before / after imagery** — swipe pre-fire vs latest Sentinel-2 (10 m via a
  Copernicus account, else keyless NASA GIBS) for past burn scars.
- **Sensor fusion** — VIIRS/MODIS give geometry and real ignition dates; live
  Meteosat MTG adds ~10-minute liveness and catches fresh fires.

## Stack

- **Pipeline** (`pipeline/`): Python + **DuckDB (spatial + h3) + GeoParquet**.
  Everything fetched is stored locally as GeoParquet with a geometry column and
  precomputed H3 keys; clustering adjacency is computed in DuckDB SQL. Exports
  versioned static artifacts to `web/public/data/`.
- **Frontend** (`web/`): **Vite + TypeScript + MapLibre GL** on a keyless CARTO
  basemap.

## Data sources

| Source | Role | Key needed |
|--------|------|------------|
| NASA FIRMS (VIIRS/MODIS) | detections, area, growth, ignition | free map key |
| Meteosat MTG (EUMETView) | ~10-min liveness / FRP | none |
| Open-Meteo | wind | none |
| OpenSky | firefighting aircraft (ADS-B) | none |
| NASA GIBS / Copernicus Sentinel-2 | before/after imagery | optional (HD) |
| GeoNames `cities15000` | nearest-town labels | none |

## Quick start

```bash
make setup     # uv sync + npm install + download GeoNames places
make sample    # generate a local demo dataset (no API key needed)
make dev       # serve the map at http://localhost:5173
```

For live data, put a free [FIRMS map key](https://firms.modaps.eosdis.nasa.gov/api/map_key/)
in `.env` (see `.env.example`), then:

```bash
make refresh   # fetch + process → web/public/data/
make watch     # poll on an interval (WATCH_INTERVAL_S to override)
```

## Tests

```bash
make test      # pytest (pipeline) + tsc + vitest (frontend)
```

## Deploy

Runs as a static Cloudflare Worker — [`wrangler.jsonc`](wrangler.jsonc) serves
`web/dist`, deployed on every push to `main`. See the deployment section of
[`AGENTS.md`](AGENTS.md) for how to refresh the data.

## Docs

- [`AGENTS.md`](AGENTS.md) — architecture, commands, conventions, deployment.
- [`docs/cartography-rules.md`](docs/cartography-rules.md) — the map-design rules
  each layer is built against.

## License

[MIT](LICENSE) © Frederic Robinet
