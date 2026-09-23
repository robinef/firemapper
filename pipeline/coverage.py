from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .config import GENERATIONS_KEPT, SCAR_WINDOW_DAYS, Settings

# PR #81 / commit dfe3e5e — the date the permanent past-scar H3 archive
# (archive_tracks.py) shipped. It writes forward only, no backfill: fires
# that went quiet before this date have no archived footprint detail and
# never will.
ARCHIVE_FLOOR_DATE = "2026-08-27"
# scripts/backfill_season.py rebuilds the fires that ended before the live
# archive's reach from the FIRMS Standard Processing archive. Published
# 2026-09-22 (backfill-season.yml run 35751494763): 8,414 tracks whose first
# detections run 2026-01-01 .. 2026-06-28, merged into the permanent index
# (22,296 -> 30,710 entries). Only the season layer's footprint reaches that
# far back; ARCHIVE_FLOOR_DATE still marks where the live, forward-written
# archive starts, and the two are disclosed separately.
BACKFILL_FLOOR_DATE: str | None = "2026-01-01"


def _generation_timestamp(gen_dir: Path) -> datetime:
    return datetime.strptime(gen_dir.name, "gen-%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def build_coverage(settings: Settings, now: datetime) -> dict:
    """How far back each layer actually reaches, for user-facing disclosure.

    None of these are backfillable on demand — they're either a rolling
    window (live tracks, FIRMS lookback, scar clustering) or a fixed floor
    set the day a feature shipped (the H3 archive). Surfacing them here so
    "no data shown" isn't mistaken for "no fire happened".

    live_window_hours is measured from the actual generations on disk
    rather than assumed from a cron cadence: two workflows (Worker-driven
    refresh-fast every ~30 min, refresh-full hourly) both write new
    generations, so the real spacing is uneven and a static formula would
    misstate exactly the number this feature exists to get right. This
    mirrors prune_generations' own selection of what "kept" means, so the
    disclosed window always matches what's actually still on disk.
    """
    gens = sorted(settings.out_dir.glob("gen-*"))
    kept = min(len(gens), GENERATIONS_KEPT)
    oldest_retained = gens[-kept] if kept else None
    live_window_hours = (
        round((now - _generation_timestamp(oldest_retained)).total_seconds() / 3600, 1)
        if oldest_retained is not None
        else 0.0
    )
    return {
        "live_window_hours": live_window_hours,
        "firms_lookback_days": settings.firms_history_days,
        "scar_window_days": SCAR_WINDOW_DAYS,
        "archive_floor_date": ARCHIVE_FLOOR_DATE,
        "backfill_floor_date": BACKFILL_FLOOR_DATE,
        "effis_note": (
            "Burned-area boundaries follow EFFIS's own upstream history; "
            "no fixed window is enforced here."
        ),
    }
