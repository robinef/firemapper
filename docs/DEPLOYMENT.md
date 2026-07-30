# Deployment

The live map runs at **https://firemapper.robinef.workers.dev** as a Cloudflare
Worker. The app shell is static; the data is not.

```
GitHub Actions ──┬─ refresh-fast (*/15)  MTG FRP, wind, aircraft, re-cluster
                 └─ refresh-full (hourly) + FIRMS, EFFIS, GIBS imagery
       │ hydrate                                   │ publish
       ▼                                           ▼
  R2: archive/hotspots-<generation>.parquet   data/manifest.json + data/gen-<ts>/
                                                   │
                            Cloudflare Worker ─────┤ /data/*  → R2 bucket
                                                   └─ *       → static assets
```

Two consequences worth stating plainly:

- **A data refresh costs zero deploys.** CI writes to the bucket; the Worker
  reads it. Deploys happen only when code changes.
- **A deploy carries no data.** `web/dist` holds the Vite bundle and nothing
  else.

## Refresh workflows

| Workflow | Schedule | Fetches |
|---|---|---|
| [`refresh-fast.yml`](../.github/workflows/refresh-fast.yml) | `*/15` | MTG FRP, wind, aircraft, then re-clusters against the archive |
| [`refresh-full.yml`](../.github/workflows/refresh-full.yml) | hourly at :07 | the above plus FIRMS NRT + history, EFFIS, GIBS scar imagery |

Deploys are **not** a workflow. Cloudflare's git integration (Workers Builds)
watches `main` and builds the app shell itself:

| Setting | Value |
|---|---|
| Build command | `npm --prefix web ci && npm --prefix web run build` |
| Deploy command | `npx wrangler deploy` |

Keeping deploys there rather than in Actions means one deploy path and no
`CLOUDFLARE_API_TOKEN` to mint, store or rotate — the integration already has
repository access. A build command is required: without one, Workers Builds
uploads whatever is in `web/dist`, which is no longer committed.

Both refresh workflows share `concurrency: { group: refresh, queue: max }`.
`queue: max` is load-bearing: the default `queue: single` cancels an older
*pending* run, so the hourly full refresh would be discarded by the next fast
run every time the two collided.

The entrypoint is `scripts/refresh_remote.py`, which enforces the only safe
ordering — hydrate, refresh, publish:

```bash
uv run python -m scripts.refresh_remote fast
uv run python -m scripts.refresh_remote full
```

`refresh_remote` exits immediately when the `R2_*` variables are absent, and the
`full` tier raises without a `FIRMS_MAP_KEY`. Both refusals are deliberate: a
run that quietly publishes an empty archive is how the live map ended up showing
30 days of zero detections.

## Publish ordering

`pipeline/remote.py` writes in a fixed order:

1. the generation's files (`data/gen-<timestamp>/…`)
2. the archive (`archive/hotspots-<generation>.parquet`)
3. `data/manifest.json` **last**, naming that archive

The manifest is the commit point. It never references an object that is not
already uploaded, so a failure at any boundary leaves the previous
(manifest, archive) pair live and mutually consistent. `hydrate` then restores
the archive the live manifest *names*, not whichever archive is newest — that is
what keeps lineage and carry-forward reasoning about a single generation.

The bucket keeps the newest three generations and their archives.

## First-time setup

```bash
npx wrangler r2 bucket create firemapper-data
```

Repository secrets:

| Secret | Used by | Notes |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | both refresh workflows | R2 API token with Object Read & Write |
| `FIRMS_MAP_KEY` | `refresh-full` | free from NASA FIRMS |

No Cloudflare token is needed as a repository secret: deploys run inside
Cloudflare's own build integration, not from Actions.

Seed the archive once, locally, with `FIRMS_MAP_KEY` in `.env`:

```bash
FULL=1 uv run python -m pipeline.run refresh full
uv run python -m scripts.refresh_remote full
```

Then **verify day coverage before trusting it**. `fetch_firms_history` swallows
per-window failures and skips any window at or below the latest stored day, so a
rate-limited seed leaves silent gaps that only a `FULL=1` wipe heals:

```bash
uv run python -c "
from collections import Counter
from pipeline.store import read_hotspots
rows = read_hotspots('data/raw/hotspots.parquet')
days = Counter(r['acq_time'].date().isoformat() for r in rows if r['tier'] != 'meteosat')
print(len(days), 'days covered;', sum(days.values()), 'detections')
"
```

Expect ~30 distinct days. Far fewer means rate-limited windows — rerun with
`FULL=1`.

## Secrets and public deploys

**Never expose `SENTINELHUB_INSTANCE_ID` to a public deploy.** The Sentinel Hub
instance id is itself a WMS access token: it ends up in `manifest.imagery.hd` and
is therefore visible to anyone using the site, who could then spend your quota.

Build public deploys without it — `hd` stays `null` and the before/after swipe
falls back to keyless NASA GIBS imagery. A `FIRMS_MAP_KEY` is safe to use during
a refresh (it is only read server-side during the fetch and never written into
the artifacts), but keep it in a repository secret, never in the repository.

## Running the whole thing somewhere else

Nothing here is Cloudflare-specific except the Worker. The published bucket is
plain files behind an S3-compatible API, so any object store plus any static
host that can route `/data/*` at it will serve the same site.
