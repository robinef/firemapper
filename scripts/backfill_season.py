"""One-off: backfill January-June 2026 fires into the permanent track archive
(pipeline/archive_tracks.py) from the FIRMS Standard Processing (SP) archive.

The archive writes forward only and started 2026-08-27 (coverage.py's
ARCHIVE_FLOOR_DATE); its first run caught every fire still inside the 45-day
scar window, so the live archive owns every fire whose last detection is on or
after 2026-07-13 (CUTOFF) and nothing before. NRT data no longer reaches that
far back; SP does, 2-3 months behind real time.

Build (the default, a dry run — writes only under DATA_DIR/backfill/):

1. Fetch VIIRS SNPP + NOAA-20 SP (NOAA-21 has no SP product; MODIS_SP behind
   --modis) over EUROPE_BBOX in the area API's 5-day windows, parsed by
   parse_firms_csv (land mask + low-confidence filter), into a SEPARATE store,
   DATA_DIR/backfill/sp_hotspots.parquet. The live data/raw/hotspots.parquet is
   never opened.
2. Cluster with a weekly-stepped `now`, each step exactly the live refresh's
   call — events.cluster(rows, now, SCAR_WINDOW_DAYS) (static-zone exclusion
   inside) then archive_tracks.archive_past_tracks — threading one backfill
   index from EMPTY. One `now` would not do: cluster() keeps only
   MAX_FIRE_DAYS (90) of rows before it, so January would never be seen.
3. Guard: drop ids already in the live index, events whose last detection is
   on/after the cutoff (the live archive's), and events that overlap a live
   fire in space and time (SP and NRT geolocate the same fire differently).
4. Write DATA_DIR/backfill/out/: archive/tracks/*.json + archive/tracks_index.json
   holding exactly what --publish would upload, and summary.json / summary.md.

--publish uploads a previous build's output to R2: back up the live index,
put each new body (never overwriting an existing key), then re-read the live
index and put it back with the new ids merged in, LAST. No season state is
written; the season export reconciles new index entries on its own.

    uv run python -m scripts.backfill_season [--modis] [--preview-season]
    uv run python -m scripts.backfill_season --publish
"""
from __future__ import annotations

import argparse
import bisect
import csv
import dataclasses
import io
import json
import shutil
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import h3

from pipeline.archive_tracks import archive_past_tracks
from pipeline.config import (
    ARCHIVE_TRACKS_INDEX,
    EUROPE_BBOX,
    MAX_FIRE_DAYS,
    SCAR_WINDOW_DAYS,
    load_settings,
    season_cells_key,
    season_key,
)
from pipeline.events import CLOSE_AFTER_H, cluster
from pipeline.fetch_firms import _fault, parse_firms_csv, scrub
from pipeline.store import append_hotspots, read_hotspots

YEAR = 2026
START = date(2026, 1, 1)
# The live archive owns every fire whose last detection is on/after this date.
CUTOFF = date(2026, 7, 13)
# Fetched past the cutoff so a fire's end is known: one burning on Jul 12 and
# again on Jul 14 is ONE fire the live archive owns, not a backfill fire that
# "ended" Jul 12. Two days = CLOSE_AFTER_H, the gap that still joins a fire.
LOOKAHEAD_DAYS = 2
FETCH_END = CUTOFF + timedelta(days=LOOKAHEAD_DAYS)  # inclusive
FIRST_STEP = date(2026, 1, 7)
STEP_DAYS = 7
SPAN_DAYS = 5  # the area API's cap on a dated request
AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SP_SOURCES = (("VIIRS_SNPP_SP", "viirs"), ("VIIRS_NOAA20_SP", "viirs"))
MODIS_SP_SOURCE = ("MODIS_SP", "modis")
FETCH_ATTEMPTS = 3
REMOTE_INDEX_KEY = f"data/{ARCHIVE_TRACKS_INDEX}"
UPLOAD_WORKERS = 16


def _utc(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time(), timezone.utc)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- fetch ------------------------------------------------------------------

def sp_windows(start: date, end: date) -> list[tuple[date, int]]:
    """(start, span) windows covering start..end INCLUSIVE, SPAN_DAYS each,
    the last clamped to end."""
    out = []
    d = start
    while d <= end:
        span = min(SPAN_DAYS, (end - d).days + 1)
        out.append((d, span))
        d += timedelta(days=span)
    return out


def sp_sources(modis: bool = False) -> list[tuple[str, str]]:
    return list(SP_SOURCES) + ([MODIS_SP_SOURCE] if modis else [])


def _default_http_get(key: str) -> Callable[[str], str]:  # pragma: no cover - network
    import requests

    def http_get(url: str) -> str:
        try:
            r = requests.get(url, timeout=120, headers={"User-Agent": "firemapper-backfill"})
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - re-raised, only the text changes
            raise RuntimeError(_fault(exc, key)) from None
        return r.text

    return http_get


def fetch_sp(
    key: str,
    store: Path,
    windows: list[tuple[date, int]],
    sources: list[tuple[str, str]],
    http_get: Callable[[str], str] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """Fetch every (source, window) into `store`. Never raises for a window:
    a failure is retried, then recorded (scrubbed) in the report's `failed`,
    and --publish refuses a build that has any."""
    http_get = http_get or _default_http_get(key)
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    area = f"{lon_min},{lat_min},{lon_max},{lat_max}"
    rows_by: dict[str, Counter] = {s: Counter() for s, _ in sources}
    last: dict[str, str | None] = {s: None for s, _ in sources}
    types: dict[str, Counter] = {s: Counter() for s, _ in sources}
    failed: list[dict] = []
    for start, span in windows:
        for source, tier in sources:
            url = f"{AREA_URL}/{key}/{source}/{area}/{span}/{start.isoformat()}"
            error = None
            for attempt in range(1, FETCH_ATTEMPTS + 1):
                try:
                    body = http_get(url)
                    # FIRMS answers a bad key / exhausted quota with HTTP 200
                    # and one line of text, which parses as zero rows.
                    if not body.lstrip().startswith("latitude"):
                        raise RuntimeError(f"not a FIRMS CSV: {body[:200]!r}")
                    rows = parse_firms_csv(body, tier)
                    error = None
                    break
                except Exception as exc:  # noqa: BLE001 - recorded, scrubbed
                    error = scrub(str(exc), key)
                    if attempt < FETCH_ATTEMPTS:
                        sleep(10 * attempt)
            if error is not None:
                print(f"[warn] {source} {start} +{span}d: {error}", file=sys.stderr)
                failed.append({"source": source, "start": start.isoformat(), "span": span, "error": error})
                continue
            # SP's `type` column (0 = vegetation fire, 1 volcano, 2 static
            # land source, 3 offshore), when the area API carries it:
            # counted, not filtered — cluster()'s static zone is the filter.
            if "type" in body.split("\n", 1)[0].strip().split(","):
                for rec in csv.DictReader(io.StringIO(body)):
                    types[source][rec.get("type", "")] += 1
            for r in rows:
                rows_by[source][r["acq_time"].strftime("%Y-%m")] += 1
                d = r["acq_time"].date().isoformat()
                if last[source] is None or d > last[source]:
                    last[source] = d
            append_hotspots(rows, store)
        print(f"[info] fetched window {start} +{span}d", file=sys.stderr)
    return {
        "rows": {s: dict(sorted(c.items())) for s, c in rows_by.items()},
        "last_date": last,
        "types": {s: dict(c) for s, c in types.items() if c},
        "failed": failed,
    }


# --- stepped clustering -----------------------------------------------------

def clustering_steps(
    first: date = FIRST_STEP, fetch_end: date = FETCH_END, step_days: int = STEP_DAYS,
) -> list[datetime]:
    """Weekly `now`s from `first`, ending on the end of the fetched data.
    Weekly is well inside both bounds that matter: a fire is archived at the
    first step it has been quiet ACTIVE_MAX_H (48 h) for, and it is still in
    the SCAR_WINDOW_DAYS (45) window then, so no fire ending between two steps
    is missed."""
    end = _utc(fetch_end + timedelta(days=1))
    steps = []
    t = _utc(first)
    while t < end:
        steps.append(t)
        t += timedelta(days=step_days)
    steps.append(end)
    return steps


def backfill_tracks(
    rows: list[dict], steps: list[datetime], out_dir: Path,
) -> tuple[dict[str, str], dict[str, dict], set[str]]:
    """(index, meta, static cells). `meta[id]` describes the members behind
    the body last written for that id: first/last detection and cells, for
    the guard. Same cluster() + archive_past_tracks() calls as pipeline/run.py,
    so ids and bodies are the live ones by construction."""
    rows = sorted(rows, key=lambda r: r["acq_time"])
    times = [r["acq_time"] for r in rows]
    index: dict[str, str] = {}
    meta: dict[str, dict] = {}
    static: set[str] = set()
    for now in steps:
        t0 = time.monotonic()
        # cluster() applies the same bound; slicing first only saves the scan.
        lo = bisect.bisect_left(times, now - timedelta(days=MAX_FIRE_DAYS))
        hi = bisect.bisect_right(times, now)
        report: dict = {}
        events = cluster(rows[lo:hi], now, window_days=SCAR_WINDOW_DAYS, report=report)
        static |= report.get("static_cells", set())
        before = index
        index = archive_past_tracks(out_dir, events, now, before)
        changed = [eid for eid, d in index.items() if before.get(eid) != d]
        for eid in changed:
            ms = events[eid]
            meta[eid] = {
                "first": min(m["acq_time"] for m in ms),
                "last": max(m["acq_time"] for m in ms),
                "cells": {m["cell"] for m in ms},
            }
        print(
            f"[info] step {_iso(now)}: rows={hi - lo} events={len(events)} "
            f"archived+={len(changed)} total={len(index)} {time.monotonic() - t0:.1f}s",
            file=sys.stderr,
        )
    return index, meta, static


# --- clobber guard ----------------------------------------------------------

def guard(
    index: dict[str, str],
    meta: dict[str, dict],
    live_index: dict[str, str],
    live_cells: dict[str, dict],
    cutoff: datetime,
) -> tuple[dict[str, str], dict[str, list]]:
    """(kept index, skipped by reason).

    overlap: a candidate whose cells, or their ring-1 neighbours, hold a live
    fire that started no later than CLOSE_AFTER_H after the candidate's last
    detection — the pair cluster() itself would have joined. SP and NRT
    geolocate the same pixel differently, so the same fire can carry two ids.
    Live fires come from the season cells file (`first` + cells, one GET);
    every live fire ends on/after the cutoff, so a start before the
    candidate's end is the whole time-overlap test."""
    live_by_cell: dict[str, list[tuple[str, str]]] = defaultdict(list)
    horizon = (cutoff + timedelta(days=LOOKAHEAD_DAYS + 1)).date().isoformat()
    for fid, entry in live_cells.items():
        first = str(entry.get("first") or "")
        if first and first <= horizon:
            for c in entry.get("cells") or []:
                live_by_cell[c].append((fid, first))
    kept: dict[str, str] = {}
    skipped: dict[str, list] = {"live_id": [], "too_recent": [], "overlap": []}
    for eid in sorted(index):
        m = meta[eid]
        if eid in live_index:
            skipped["live_id"].append(eid)
            continue
        if m["last"] >= cutoff:
            skipped["too_recent"].append(eid)
            continue
        latest_start = (m["last"] + timedelta(hours=CLOSE_AFTER_H)).date().isoformat()
        near = {n for c in m["cells"] for n in h3.grid_disk(c, 1)}
        hits = sorted({fid for c in near for fid, first in live_by_cell.get(c, ()) if first <= latest_start})
        if hits:
            skipped["overlap"].append({"id": eid, "live": hits})
            continue
        kept[eid] = index[eid]
    return kept, skipped


# --- build ------------------------------------------------------------------

def _summary_md(s: dict) -> str:
    f = s["fetch"]
    lines = [
        "## Season backfill build",
        "",
        f"- SP last date per source: {f['last_date']}",
        f"- failed windows: {len(f['failed'])}",
        f"- rows: {s['rows']} · clustering steps: {s['steps']} · cutoff: {s['cutoff']}",
        f"- archived: {s['archived']} · kept: {s['kept']} · skipped: "
        + ", ".join(f"{k}={len(v)}" for k, v in s["skipped"].items()),
        f"- first detection: {s['earliest_first']} .. {s['latest_first']}",
        f"- static cells excluded (union over steps): {s['static_cells']}",
        "",
        "| month | " + " | ".join(f["rows"]) + " | tracks |",
        "|---|" + "---|" * len(f["rows"]) + "---|",
    ]
    months = sorted({m for c in f["rows"].values() for m in c} | set(s["tracks_by_month"]))
    for mo in months:
        lines.append(
            f"| {mo} | " + " | ".join(str(f["rows"][src].get(mo, 0)) for src in f["rows"])
            + f" | {s['tracks_by_month'].get(mo, 0)} |"
        )
    if s["skipped"]["overlap"]:
        lines += ["", "Overlaps with live fires (skipped):", ""]
        lines += [f"- {o['id']} ~ {', '.join(o['live'])}" for o in s["skipped"]["overlap"]]
    if s.get("preview"):
        lines += ["", f"Season preview over the backfill alone: {s['preview']}"]
    return "\n".join(lines) + "\n"


def build(
    settings,
    out_dir: Path,
    store: Path,
    live_index: dict[str, str],
    live_cells: dict[str, dict],
    http_get: Callable[[str], str] | None = None,
    modis: bool = False,
    sleep: Callable[[float], None] = time.sleep,
    preview: bool = False,
) -> dict:
    if settings.firms_map_key is None:
        raise SystemExit("FIRMS_MAP_KEY missing")
    if (out_dir / "archive").exists():
        shutil.rmtree(out_dir / "archive")  # the backfill index starts EMPTY
    out_dir.mkdir(parents=True, exist_ok=True)

    fetch = fetch_sp(
        settings.firms_map_key, store, sp_windows(START, FETCH_END), sp_sources(modis),
        http_get=http_get, sleep=sleep,
    )
    rows = [r for r in read_hotspots(store) if _utc(START) <= r["acq_time"] < _utc(FETCH_END + timedelta(days=1))]
    steps = clustering_steps()
    index, meta, static = backfill_tracks(rows, steps, out_dir)

    # SP may stop short of FETCH_END. A fire last seen within CLOSE_AFTER_H of
    # the data's end cannot be called ended, so the cutoff tightens with it.
    horizon = max((r["acq_time"] for r in rows), default=_utc(START))
    cutoff = min(_utc(CUTOFF), horizon - timedelta(hours=CLOSE_AFTER_H))
    kept, skipped = guard(index, meta, live_index, live_cells, cutoff)

    tracks_dir = out_dir / "archive" / "tracks"
    for eid in set(index) - set(kept):
        (tracks_dir / f"{eid}.json").unlink(missing_ok=True)
    (out_dir / ARCHIVE_TRACKS_INDEX).parent.mkdir(parents=True, exist_ok=True)
    (out_dir / ARCHIVE_TRACKS_INDEX).write_text(json.dumps(kept))

    firsts = sorted(meta[eid]["first"].date().isoformat() for eid in kept)
    summary = {
        "fetch": fetch,
        "rows": len(rows),
        "steps": len(steps),
        "cutoff": _iso(cutoff),
        "archived": len(index),
        "kept": len(kept),
        "skipped": skipped,
        "earliest_first": firsts[0] if firsts else None,
        "latest_first": firsts[-1] if firsts else None,
        "tracks_by_month": dict(sorted(Counter(f[:7] for f in firsts).items())),
        "static_cells": len(static),
        "live_index_ids": len(live_index),
        "live_cells_fires": len(live_cells),
    }
    if preview:
        summary["preview"] = preview_season(settings, out_dir)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=str))
    (out_dir / "summary.md").write_text(_summary_md(summary))
    return summary


def preview_season(settings, out_dir: Path) -> dict:
    """The season export run locally over the backfill tracks alone (no R2,
    no static zone: the live export adds its raw-store zone on top)."""
    from pipeline.export_season import run_export_season

    local = dataclasses.replace(settings, out_dir=out_dir)
    run_export_season(local, YEAR, client=None, time_budget_s=float("inf"))
    s = json.loads((out_dir / season_key(YEAR)).read_text())
    return {"fires": s["fires"], "km2": s["km2"], "floor": s["floor"]}


# --- publish ----------------------------------------------------------------

def _exists(client, bucket: str, key: str) -> bool:
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except Exception as exc:  # noqa: BLE001 - only a 404 means "absent"
        code = str(((getattr(exc, "response", None) or {}).get("Error") or {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def _read_live_index(client, bucket: str) -> dict[str, str] | None:
    from pipeline.remote import _get

    raw = _get(client, bucket, REMOTE_INDEX_KEY)
    return None if raw is None else json.loads(raw)


def publish(client, bucket: str, out_dir: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    kept: dict[str, str] = json.loads((out_dir / ARCHIVE_TRACKS_INDEX).read_text())
    if _read_live_index(client, bucket) is None:
        raise SystemExit(f"no live {REMOTE_INDEX_KEY} — refusing to publish an index of backfill ids only")

    backup = f"{REMOTE_INDEX_KEY}.pre-backfill-{now.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
    client.copy_object(Bucket=bucket, Key=backup, CopySource={"Bucket": bucket, "Key": REMOTE_INDEX_KEY})
    print(f"[info] backed up the live index to {backup}")

    def upload(eid: str) -> bool:
        key = f"data/archive/tracks/{eid}.json"
        if _exists(client, bucket, key):
            return False
        client.put_object(
            Bucket=bucket, Key=key, Body=(out_dir / "archive" / "tracks" / f"{eid}.json").read_bytes(),
            ContentType="application/json",
        )
        return True

    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
        uploaded = sum(pool.map(upload, sorted(kept)))  # re-raises before the index

    live = _read_live_index(client, bucket)  # re-read: take whatever landed meanwhile
    if live is None:
        raise SystemExit("live index vanished mid-publish — not writing it")
    merged = dict(live)
    added = 0
    for eid, digest in kept.items():
        if eid not in merged:
            merged[eid] = digest
            added += 1
    client.put_object(
        Bucket=bucket, Key=REMOTE_INDEX_KEY, Body=json.dumps(merged).encode(),
        ContentType="application/json",
    )
    print(f"[info] uploaded {uploaded} track bodies; index {len(live)} -> {len(merged)} (+{added})")
    print(
        f"[info] rollback: copy {backup} over {REMOTE_INDEX_KEY} "
        "(the new bodies are inert without index entries)"
    )
    return {"backup_key": backup, "uploaded": uploaded, "added": added}


# --- CLI --------------------------------------------------------------------

def main(argv: list[str], client=None, http_get=None) -> int:
    p = argparse.ArgumentParser(prog="scripts.backfill_season")
    p.add_argument("--publish", action="store_true", help="upload a previous build's output to R2")
    p.add_argument("--modis", action="store_true", help="also fetch MODIS_SP")
    p.add_argument("--preview-season", action="store_true")
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args(argv)

    settings = load_settings()
    out_dir = args.out or settings.data_dir / "backfill" / "out"
    if out_dir.resolve() == settings.out_dir.resolve():
        raise SystemExit("--out must not be the site's OUT_DIR")
    if client is None and settings.r2_configured:
        from pipeline.remote import make_client

        client = make_client(settings)

    if args.publish:
        if not settings.r2_configured:
            raise SystemExit("R2_* env vars missing — nothing to publish to")
        summary_path = out_dir / "summary.json"
        if not summary_path.exists():
            raise SystemExit(f"no build at {out_dir} — run without --publish first")
        failed = json.loads(summary_path.read_text()).get("fetch", {}).get("failed")
        if failed is None or failed:
            raise SystemExit(f"the build has {len(failed or [])} failed fetch windows — refusing")
        publish(client, settings.r2_bucket, out_dir)
        return 0

    live_index: dict[str, str] = {}
    live_cells: dict[str, dict] = {}
    if client is not None:
        from pipeline.remote import _get

        live = _read_live_index(client, settings.r2_bucket)
        if live is None:
            raise SystemExit(f"R2 is configured but has no {REMOTE_INDEX_KEY}")
        live_index = live
        raw = _get(client, settings.r2_bucket, f"data/{season_cells_key(YEAR)}")
        live_cells = json.loads(raw) if raw is not None else {}
        if raw is None:
            print("[warn] no live season cells file — overlap check skipped", file=sys.stderr)
    else:
        print("[warn] no R2 credentials — live-id and overlap guards run against nothing", file=sys.stderr)

    store = settings.data_dir / "backfill" / "sp_hotspots.parquet"
    summary = build(
        settings, out_dir, store, live_index, live_cells,
        http_get=http_get, modis=args.modis, preview=args.preview_season,
    )
    print((out_dir / "summary.md").read_text())
    return 1 if summary["fetch"]["failed"] else 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main(sys.argv[1:]))
