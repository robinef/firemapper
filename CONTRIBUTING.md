# Contributing

Thanks for your interest! This is a small, local-first project — contributions
and issues are welcome.

## Development

Requirements: [uv](https://docs.astral.sh/uv/) (Python 3.12) and Node 24.

```bash
# Pipeline
uv run --with pytest pytest -q
uv run python -m scripts.make_sample   # local demo dataset, no API key needed

# Frontend
cd web && npm ci
npm run dev            # http://localhost:5173
npx tsc --noEmit && npm test
npm run smoke          # browser smoke tests (Playwright, Chromium)
```

See [`AGENTS.md`](AGENTS.md) for the architecture and conventions.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests for any behaviour change. CI (`.github/workflows/ci.yml`)
  runs pytest, `tsc --noEmit`, vitest, a build check, and the browser smoke
  suite — keep them green.
- Never commit secrets or generated data (`.env`, `data/`, `web/public/data/`
  are gitignored). Use synthetic data in tests.
- Match the surrounding code style; `.editorconfig` covers indentation.

## Reporting bugs

Open an issue with steps to reproduce and, if relevant, the generation manifest
(`web/public/data/manifest.json`) and console output.

## Maintainer notes

`main` is protected by a GitHub ruleset ("main protection", applied
2026-09-22 once the repo went public). It blocks force-pushes and deletion of
`main`, allows squash or rebase merges only, and requires the three CI jobs
(`pipeline (pytest)`, `web (tsc + vitest + build)`, `web (browser smoke)`) to
pass. Deliberately no required review count, so a solo maintainer isn't
blocked. Inspect or edit it with:

```bash
gh api repos/robinef/firemapper/rulesets            # list; edit via PUT on the id
```

When a CI job is renamed in `ci.yml`, update the ruleset's required contexts
in the same PR or `main` becomes unmergeable.

## Code of Conduct

By participating you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not report security problems in a public issue — see
[SECURITY.md](SECURITY.md) for how to report them privately.
