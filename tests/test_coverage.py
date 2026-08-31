from datetime import datetime, timedelta, timezone

from pipeline.config import GENERATIONS_KEPT, SCAR_WINDOW_DAYS
from pipeline.coverage import ARCHIVE_FLOOR_DATE, build_coverage

from .test_export_footprint import _settings


def _make_gen(out_dir, ts):
    (out_dir / f"gen-{ts.strftime('%Y%m%dT%H%M%SZ')}").mkdir(parents=True)


def test_live_window_is_measured_not_assumed_from_a_single_cadence(tmp_path):
    """Two workflows write generations at uneven intervals (a Worker-driven
    cron plus an hourly GitHub Action), so a fixed "N * 30min" formula would
    misstate the window. It must reflect the actual oldest gen on disk.
    """
    settings = _settings(tmp_path)
    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)
    for minutes_ago in (40, 20, 0):
        _make_gen(settings.out_dir, now - timedelta(minutes=minutes_ago))

    coverage = build_coverage(settings, now)

    assert coverage["live_window_hours"] == round(40 / 60, 1)


def test_live_window_caps_at_what_prune_generations_will_actually_keep(tmp_path):
    """More generations exist on disk than GENERATIONS_KEPT retains. The
    disclosed window must match prune_generations' own cutoff (the newest
    GENERATIONS_KEPT), not the full history still momentarily on disk.
    """
    settings = _settings(tmp_path)
    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)
    total = GENERATIONS_KEPT + 3
    for i in range(total):
        _make_gen(settings.out_dir, now - timedelta(minutes=10 * (total - 1 - i)))

    coverage = build_coverage(settings, now)

    expected_hours = round(10 * (GENERATIONS_KEPT - 1) / 60, 1)
    assert coverage["live_window_hours"] == expected_hours


def test_no_generations_on_disk_yet(tmp_path):
    settings = _settings(tmp_path)
    settings.out_dir.mkdir(parents=True, exist_ok=True)
    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)

    assert build_coverage(settings, now)["live_window_hours"] == 0.0


def test_static_fields_pass_through(tmp_path):
    settings = _settings(tmp_path)
    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)

    coverage = build_coverage(settings, now)

    assert coverage["firms_lookback_days"] == settings.firms_history_days
    assert coverage["scar_window_days"] == SCAR_WINDOW_DAYS
    assert coverage["archive_floor_date"] == ARCHIVE_FLOOR_DATE
    assert "EFFIS" in coverage["effis_note"]
