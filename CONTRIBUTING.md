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

## Maintainer notes

`main` is **not branch-protected yet** — GitHub requires a public repository or a
paid plan for that, and this repo is currently private on the free tier. The
intended rules, once either is true:

```bash
gh api -X POST repos/robinef/firemapper/rulesets --input - <<'JSON'
{
  "name": "main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "pipeline (pytest)" },
          { "context": "web (tsc + vitest)" }
        ]
      }
    }
  ]
}
JSON
```

That blocks force-pushes and deletion of `main` and requires both CI jobs to pass.
Deliberately no required review count, so a solo maintainer isn't blocked.

## Code of Conduct

By participating you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not report security problems in a public issue — see
[SECURITY.md](SECURITY.md) for how to report them privately.
