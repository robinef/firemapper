# Deployment

The live map runs at **https://firemapper.robinef.workers.dev** as a Cloudflare
Worker serving static assets. Because the app is just files, any static host
(Cloudflare, GitHub Pages, Netlify, Vercel, S3) works the same way.

[`wrangler.jsonc`](../wrangler.jsonc) points `assets.directory` at `./web/dist`,
and Cloudflare's git integration runs `npx wrangler deploy` on every push to
`main`.

## Current setup: committed build artifact

Cloudflare's *Build command* is not set, so nothing is compiled remotely —
`web/dist` (the Vite bundle **plus** the generated `web/dist/data/`) is committed
to the repository and uploaded as-is.

The trade-off: the served data is a **static snapshot**. It only changes when
someone rebuilds and commits it:

```bash
uv run python -m scripts.make_sample          # regenerate web/public/data
npm --prefix web ci && npm --prefix web run build
git add -f web/dist && git commit -m "chore: rebuild web/dist" && git push
```

## Preferred setup: build on the host

Cloudflare's build image already ships Python and uv, so it can run the pipeline
itself. Set the Worker's *Build command* to:

```
uv run python -m scripts.make_sample && npm --prefix web ci && npm --prefix web run build
```

Then delete `web/dist` from git and re-add `web/dist/` to `.gitignore`. Every
push regenerates fresh data and the repository stays free of build output.

## Keeping data fresh

A push-triggered build only refreshes data when someone pushes. For a map that
updates on its own, add a scheduled GitHub Action that reruns the pipeline, builds,
and deploys with `npx wrangler deploy` using a `CLOUDFLARE_API_TOKEN` repository
secret. A 15–30 minute cron is realistic; the Meteosat tier updates every ~10
minutes, so anything faster needs an always-on runner rather than cron.

## Secrets and public deploys

**Never expose `SENTINELHUB_INSTANCE_ID` to a public deploy.** The Sentinel Hub
instance id is itself a WMS access token: it ends up in `manifest.imagery.hd` and
is therefore visible to anyone using the site, who could then spend your quota.

Build public deploys without it — `hd` stays `null` and the before/after swipe
falls back to keyless NASA GIBS imagery. A `FIRMS_MAP_KEY` is safe to use at
build time (it is only read server-side during the fetch and never written into
the artifacts), but keep it in a build secret, never in the repository.
