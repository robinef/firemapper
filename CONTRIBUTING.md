# Contributing

Thanks for your interest! This is a small, local-first project — contributions
and issues are welcome.

## Development

Requirements: [uv](https://docs.astral.sh/uv/) (Python 3.12) and Node 20.

```bash
# Pipeline
uv run --with pytest pytest -q
uv run python -m scripts.make_sample   # local demo dataset, no API key needed

# Frontend
cd web && npm ci
npm run dev            # http://localhost:5173
npx tsc --noEmit && npm test
```

See [`AGENTS.md`](AGENTS.md) for the architecture and conventions.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update tests for any behaviour change. CI (`.github/workflows/ci.yml`)
  runs pytest, `tsc --noEmit`, and vitest — keep them green.
- Never commit secrets or generated data (`.env`, `data/`, `web/public/data/`
  are gitignored). Use synthetic data in tests.
- Match the surrounding code style; `.editorconfig` covers indentation.

## Reporting bugs

Open an issue with steps to reproduce and, if relevant, the generation manifest
(`web/public/data/manifest.json`) and console output.
