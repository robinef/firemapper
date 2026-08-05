"""CI entrypoint: hydrate from R2, run one refresh tier, publish back.

Local development never touches R2 — use `python -m pipeline.run refresh` for
that. This module exists so the scheduled workflows have one command whose
ordering (hydrate, refresh, publish) cannot be got wrong.

    uv run python -m scripts.refresh_remote fast
    uv run python -m scripts.refresh_remote full
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from pipeline.config import Settings, load_settings
from pipeline.remote import hydrate, make_client, publish
from pipeline.run import refresh


def _latest_generation(settings: Settings) -> Path:
    """The generation the run just wrote. Names are UTC timestamps, so the
    newest sorts last."""
    generations = sorted(p for p in settings.out_dir.glob("gen-*") if p.is_dir())
    if not generations:
        raise RuntimeError("no generation produced — refusing to publish")
    return generations[-1]


def _timed(label: str, fn):
    """Run one stage and report how long it took, flushed immediately.

    A refresh that exceeds the job timeout is killed, and Python block-buffers
    stdout when it is not a terminal — so the 2026-08-04 timeouts produced a
    20-minute run with literally no output to diagnose. Printing per stage, with
    flush, is what makes the next one readable.
    """
    start = time.monotonic()
    print(f"[time] {label} started", flush=True)
    try:
        return fn()
    finally:
        print(f"[time] {label} took {time.monotonic() - start:.1f}s", flush=True)


def main(argv: list[str], client=None) -> int:
    tier = argv[0] if argv else "full"
    settings = load_settings()
    if not settings.r2_configured:
        sys.exit("R2_* env vars missing — refusing to run a remote refresh")
    client = client if client is not None else make_client(settings)

    _timed("hydrate", lambda: hydrate(settings, client))
    _timed(f"refresh({tier})", lambda: refresh(settings, tier=tier))
    _timed("publish", lambda: publish(settings, _latest_generation(settings), client))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main(sys.argv[1:]))
