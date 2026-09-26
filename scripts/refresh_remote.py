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
from datetime import datetime, timezone
from pathlib import Path

from pipeline.config import Settings, load_settings, season_years
from pipeline.export_scale_blob import run_export
from pipeline.export_season import run_export_season, season_static_zone, sp_static_zone
from pipeline.remote import hydrate, make_client, publish
from pipeline.run import _safe, refresh


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


# The ended season's passes in January (config.season_years), full tier only.
# Normally cheap — a few late-settling fires plus the reconcile — so they get
# a slice of the current year's budget: both years' worst cases together
# (300 + 900 + 120 + 300 s) still leave the full tier's 40-minute ceiling
# ~10 min for the pipeline work before and publish() after.
PREV_SCALE_BLOB_BUDGET_S = 300.0
PREV_SEASON_BUDGET_S = 120.0


def main(argv: list[str], client=None, now: datetime | None = None) -> int:
    tier = argv[0] if argv else "full"
    # One instant for the whole run: hydrate must restore exactly the years
    # the exports below target, even if the run straddles midnight on 31 Jan.
    now = now or datetime.now(timezone.utc)
    years = season_years(now)
    settings = load_settings()
    if not settings.r2_configured:
        sys.exit("R2_* env vars missing — refusing to run a remote refresh")
    client = client if client is not None else make_client(settings)

    _timed("hydrate", lambda: hydrate(settings, client, now=now))
    _timed(f"refresh({tier})", lambda: refresh(settings, tier=tier))
    # Wrapped in pipeline.run's own _safe, the same idiom for the same reason it
    # already guards archive_past_tracks — the very producer of the data this
    # consumes. The scale blob is a bonus tier layered on top of the archive, and
    # every input it reads can be malformed: an empty/missing `series` (year_of_track
    # raises), a body with no "cells", a track whose cells all vanished
    # (centroid_of_cells divides by zero), a bad H3 id (h3 raises), a truncated
    # local body (json.loads raises). Unguarded, any of those propagates out of
    # main() BEFORE publish() runs, and the live map then serves the previous
    # generation for as long as the fault persists — a stale map is a far worse
    # outcome than a stale blob. So a failure here falls back to "no new scale
    # blob this run" and the refresh publishes regardless.
    #
    # _safe only catches IN-PROCESS exceptions, not a hard kill of the whole
    # job — and the first production run proved that matters: this job's own
    # 30-minute timeout (below, in the CI workflow) killed the process mid
    # run_export, before publish() ever ran, because a cold start against
    # prod's real archive (19,347 tracks, fetched serially, none of it
    # written until the very end) can't finish in time. time_budget_s makes
    # run_export stop itself early and write whatever it finished, well
    # inside that 30-minute ceiling: ~3 min of pipeline work runs before this
    # step (measured on the run that timed out), so 900s (15 min) here still
    # leaves comfortable margin for publish() and everything else in the job.
    #
    # The ended season (January only) goes first and in the full tier only:
    # the fast tier's 30-minute ceiling has no room for a second pass.
    for year in years:
        if year != now.year and tier != "full":
            continue
        budget = 900.0 if year == now.year else PREV_SCALE_BLOB_BUDGET_S
        _timed(
            f"export_scale_blob({year})",
            lambda year=year, budget=budget: _safe(
                lambda: run_export(
                    settings,
                    target_year=year,
                    client=client,
                    r2_bucket=settings.r2_bucket,
                    time_budget_s=budget,
                ),
                default=None,
                label="export-scale-blob",
            ),
        )
    # Full tier only. The fast tier's job has a 30-minute ceiling that a
    # cold scale-blob export (900 s) plus the ~3 min of pipeline work before
    # it already brings within ~12 min of, and that ceiling has killed this
    # process before publish() once already (see the scale-blob comment
    # above). The full tier runs every two hours under a 40-minute ceiling, which
    # leaves the season export's 300 s a real margin; the layer is a
    # whole-season aggregate, so an hourly refresh loses nothing visible.
    # Same _safe contract as the scale blob: a broken season export must
    # never block publish().
    #
    # Oldest first (config.season_years): in January the ended season is
    # finished before the new one's run reads its late-settling fires and
    # records them as another year's.
    for year in years if tier == "full" else ():
        # The static heat-source zone, from the raw detections hydrate() and
        # refresh() just brought up to date, by the live map's own rule. None
        # (store missing, unreadable) leaves the season's last filtering in
        # place — never a reason to skip the export or the publish.
        zone = _timed(
            f"season_static_zone({year})",
            lambda year=year: _safe(
                lambda: season_static_zone(settings, year),
                default=None,
                label="season-static-zone",
            ),
        )
        budget = 300.0 if year == now.year else PREV_SEASON_BUDGET_S
        _timed(
            f"export_season({year})",
            lambda year=year, zone=zone, budget=budget: _safe(
                lambda: run_export_season(
                    settings,
                    target_year=year,
                    client=client,
                    r2_bucket=settings.r2_bucket,
                    time_budget_s=budget,
                    static_zone=zone,
                    extra_zone=sp_static_zone(year),
                ),
                default=None,
                label="export-season",
            ),
        )
    _timed("publish", lambda: publish(settings, _latest_generation(settings), client))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main(sys.argv[1:]))
