# Deployment

The live map runs at **https://firemapper.robinef.workers.dev** as a Cloudflare
Worker. The app shell is static; the data is not.

```
Cloudflare cron ─► refresh-fast (*/30)  MTG FRP, wind, re-cluster
GitHub Actions ──┬─ refresh-fast (37 */6, fallback only)
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
| [`refresh-fast.yml`](../.github/workflows/refresh-fast.yml) | `*/30`, driven by a Cloudflare Cron Trigger (see [`worker/index.ts`](../worker/index.ts)); its own `37 */6` schedule is only a fallback | MTG FRP, wind, then re-clusters against the archive |
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

The bucket keeps the newest eleven generations and their archives
(`GENERATIONS_KEPT` in `pipeline/config.py`).

Eleven rather than three because a generation no longer contains every track.
About 98.7% of track files are byte-identical between consecutive runs, so
`export` leaves an unchanged track where it is and each `events.geojson` feature
carries a `track_gen` naming the generation that actually holds it. To stop a
pointer outliving its object, every track is rewritten at least once every
`TRACK_REWRITE_EVERY` (10) generations, and retention is one more than that — so
the guarantee holds by construction rather than by refcounting.

The rewrite is spread by a hash bucket on the event id, not by age. Age alone
stampedes: every track starts life in the same generation, so they would all come
due on the same later run and it would pay the full pre-change cost in one go.

Measured effect: ~12714 objects per publish down to ~1300, and `publish` from
481.5s to a fraction of it. The first run after deploy has no `track_map.json`
and so writes everything once.

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

Worker secret (set on Cloudflare, **not** a repository secret):

| Secret | Used by | Notes |
|---|---|---|
| `GH_DISPATCH_TOKEN` | the Worker's cron trigger | fine-grained GitHub PAT, `Actions: read and write`, scoped to this repo only |

```bash
npx wrangler secret put GH_DISPATCH_TOKEN
```

`workflow_dispatch` needs only `Actions`. Do not grant `Contents: write` — that
is what `repository_dispatch` would require, and it is a token that can push
commits to the repo.

### When the refresh stops

**The token expiring is the most likely cause, and fine-grained PATs cap at
about a year — so this is a when, not an if.** Put its expiry date in a
calendar; nothing in the system will remind you.

The failure is quiet by nature: the cron keeps firing, every dispatch is
rejected, and the map simply stops advancing. Four ways to catch it, in the
order they will actually reach you:

1. **The map itself.** `attempted_at` is the honest signal — it moves on every
   refresh regardless of which layers succeeded. It lives **per layer**, at
   `layers.<name>.attempted_at`, not at the top level of `data/manifest.json`;
   `generated_at` is the top-level equivalent. Any layer will do, since one run
   stamps them all:

   ```bash
   curl -s https://firemapper.robinef.workers.dev/data/manifest.json \
     | jq -r '.layers.events.attempted_at'
   ```

   If that is hours old, the refresh is dead, whatever the cause.

   **The Worker now checks this itself.** After each successful dispatch the
   scheduled handler reads the manifest from R2 and throws if the newest
   `attempted_at` is over 90 minutes old, so the cron invocation records an
   error. That closes the gap a bare dispatch leaves: HTTP 204 only means
   GitHub *accepted* the request, and a job that then fails or publishes
   nothing used to leave every invocation reporting "Ok" while the map froze.

   90 minutes rides out one missed cycle (a half-hourly trigger plus a
   19-minute job) without crying wolf. It is deliberately looser than
   `MAX_AGE_S["frp"]` of 60 min: that budget says when the UI must stop calling
   data current, this says when a human should be told the pipeline stopped.

   None of this fires if the Worker itself is gone, which is what
   [`watchdog.yml`](../.github/workflows/watchdog.yml) is for — see below.
2. **Cloudflare.** The scheduled handler throws on a failed dispatch, so the
   invocation is recorded as an error rather than "Ok" — visible under the
   Worker's Cron Events, and eligible for a Cloudflare notification.
3. **The watchdog.** [`watchdog.yml`](../.github/workflows/watchdog.yml) runs
   hourly on GitHub — the *other* provider — fetches the **public** manifest and
   fails when the newest `attempted_at` is over 90 minutes old
   (`STALE_AFTER_MIN`, pinned to the Worker's own constant by a test so the two
   cannot drift). It opens one deduped issue titled `[watchdog] data is stale`
   and closes it on recovery.

   It goes through the public URL rather than R2 deliberately: that exercises
   the Worker serving `/data/**` too, so a healthy bucket behind a broken Worker
   still reads as broken — which is what a visitor gets.

   **It is not a proof.** GitHub disables scheduled workflows after ~60 days of
   repository inactivity, so on a dormant repo the watchdog dies the same quiet
   way it exists to catch. Closing that properly needs a third party outside
   both Cloudflare and GitHub.

4. **`npx wrangler tail`** shows the HTTP status and GitHub's own explanation
   (401 expired, 403 wrong scope, 404 wrong path, 422 bad ref or disabled
   workflow). Logs are retained 3 days on the free plan — a diagnostic once you
   already suspect a problem, not a monitor.

GitHub's own `schedule` in `refresh-fast.yml` still runs every six hours, so a
dead Worker or expired token degrades the cadence rather than stopping the map
outright.

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

**`SENTINELHUB_INSTANCE_ID` must never reach a browser.** The Sentinel Hub
instance id is itself a bearer token for an entire OGC configuration — the same
id works against `/ogc/wms`, `/wmts`, `/wcs`, `/wfs` and `/fis`, so a holder can
enumerate the configuration with GetCapabilities, pull raw raster via WCS and
statistics via FIS, all billed to your account.

It is therefore NOT a pipeline input and never appears in `manifest.json`. The
Worker holds it as a Worker secret and proxies tiles at `/hd`:

```sh
wrangler secret put SENTINELHUB_INSTANCE_ID
```

The manifest carries only `imagery.hd.wms_base = "/hd"`, a relative path. The
pipeline enables the tier with `SENTINELHUB_PROXY=1` — a flag, not a credential
— so the refresh job (which holds R2 write keys) never sees the Sentinel Hub
token at all. Without the Worker secret, `/hd` returns 503 and the swipe stays
on the keyless MODIS tier rather than showing blank tiles.

Keep the CDSE configuration minimal — only the true-colour layer — and set a
request cap. The proxy pins `service=WMS&request=GetMap` and forwards only
recognised tile parameters, so it cannot be used to enumerate or mine the
configuration; the cap is the backstop for plain tile-scraping.

## Running the whole thing somewhere else

Nothing here is Cloudflare-specific except the Worker. The published bucket is
plain files behind an S3-compatible API, so any object store plus any static
host that can route `/data/*` at it will serve the same site.
