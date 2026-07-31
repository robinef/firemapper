# FireMapper

**See how wildfires are spreading across Europe** — where they are burning right
now, how fast they are growing, and what they have already destroyed.

[![CI](https://github.com/robinef/firemapper/actions/workflows/ci.yml/badge.svg)](https://github.com/robinef/firemapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🔥 **[Open the map →](https://firemapper.robinef.workers.dev)**

> ⚠ **Not an emergency service.** This map visualises public satellite data,
> which can be hours old and is never an official alert. If you are in danger,
> call **112** and follow your local authorities.

## Why

Most fire maps answer one question: *where is it burning?* They show today's
dots and forget yesterday's. But the story people actually need is **time** —
fire seasons are getting longer and more intense, and each individual fire has a
history: when it started, which way it ran, how much it took.

FireMapper is built around that. Every view is about change over time, and the
whole thing is free, open, and needs no account.

## What you can do

**Start with the overview** — active fires and recent burn scars across Europe.
The bar chart along the bottom is one bar per day: click any day to see where
fire was burning that day. A badge tells you whether this week is worse than the
last.

**Click a fire to open its card.** The map flies in and everything becomes about
that one fire: how big it is, when it ignited, whether it is still growing,
which way it is spreading, the nearest town. Its burn footprint is coloured by
*when* each patch caught — and clicking a bar in its history rewinds the fire, so
you can watch it grow.

**See the damage.** For fires that have already burned, a before/after slider
compares satellite imagery of the same place — green forest on one side, black
scar on the other.

**Follow the response.** Firefighting aircraft that are airborne right now
(Canadairs, Dash-8s, coordination planes) appear on the map, tracked from public
ADS-B signals.

## Run it yourself

You need [uv](https://docs.astral.sh/uv/) (Python) and Node.

```bash
make setup     # install dependencies
make sample    # build a demo dataset — no API key, no account
make dev       # open the map at http://localhost:5173
```

That's it — no server, no database to run. The map reads plain static files.

`make sample` needs no key: the keyless sources (Meteosat intensity, wind,
firefighting aircraft) are real and live, and the fire history is synthetic so
the demo is never empty.

Want the real fire history too? Get a free
[NASA FIRMS key](https://firms.modaps.eosdis.nasa.gov/api/map_key/), drop it in
`.env` (copy `.env.example`), then `make refresh-full` — 30 days of real VIIRS
detections replace the synthetic ones. `make refresh-fast` updates only the live
layers and never needs a key.

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) to get started, and the
[Code of Conduct](CODE_OF_CONDUCT.md) for the ground rules.

Good first contributions: more curated historical fires
([`pipeline/notable_scars.json`](pipeline/notable_scars.json) is plain data),
translations, colour-blind-safe palettes, or accessibility fixes.

## Learn more

- [**Architecture**](docs/ARCHITECTURE.md) — how the pipeline and map work, and
  where the data comes from.
- [**Map design rules**](docs/cartography-rules.md) — the cartographic
  constraints every layer is built against.
- [**Deployment**](docs/DEPLOYMENT.md) — how the live map is hosted.
- [AGENTS.md](AGENTS.md) — orientation for AI coding agents.

## Credits

Built on open data from **NASA FIRMS**, **EUMETSAT**, **Copernicus**,
**Open-Meteo**, **OpenSky Network**, **GeoNames**, and **OpenStreetMap**. Thank
you to everyone who keeps those services public.

## License

[MIT](LICENSE) © Frederic Robinet
