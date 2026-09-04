"""One-off maintenance: purge already-ingested FIRMS type 2/3 (other static
land source / offshore) detections from the R2-archived hotspot store.

pipeline/fetch_firms.py's _EXCLUDED_TYPES filter only stops NEW rows from
entering the store — rows fetched before that fix are still in the archive
and keep clustering into events until they individually age out of the live
(14-day) or scar (45-day) window. This re-fetches FIRMS history for every
source, this time reading `type`, and drops any locally-stored row whose
src_id matches an excluded detection. It rewrites the SAME archive key the
current manifest already names, so the next ordinary refresh (fast or full)
picks up the cleaned store with no other change.

    uv run python -m scripts.purge_offshore_hotspots [--dry-run]
"""
from __future__ import annotations

import csv
import io
import sys
from datetime import datetime, timedelta, timezone

from pipeline.config import EUROPE_BBOX, SCAR_WINDOW_DAYS, load_settings
from pipeline.fetch_firms import FIRMS_SOURCES, _EXCLUDED_TYPES, _fault, _src_id
from pipeline.remote import archive_key, hydrate, make_client
from pipeline.store import delete_by_src_id

WINDOW_SPAN_DAYS = 5  # matches the area API's per-request cap (see fetch_firms_history)


def offending_src_ids(settings, http_get) -> set[str]:
    """src_ids of every type-2/3 detection across all sources, over the scar
    window — the widest span any currently-stored row could still matter for."""
    lon_min, lat_min, lon_max, lat_max = EUROPE_BBOX
    area = f"{lon_min},{lat_min},{lon_max},{lat_max}"
    today = datetime.now(timezone.utc).date()
    bad: set[str] = set()
    for source, tier in FIRMS_SOURCES:
        for start_offset in range(SCAR_WINDOW_DAYS, 0, -WINDOW_SPAN_DAYS):
            start = today - timedelta(days=start_offset)
            span = min(WINDOW_SPAN_DAYS, start_offset)
            url = (
                f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
                f"{settings.firms_map_key}/{source}/{area}/{span}/{start.isoformat()}"
            )
            try:
                text = http_get(url)
            except Exception as exc:  # noqa: BLE001 - one bad window must not stop the sweep
                # Scrubbed for the same reason as fetch_firms.py: the key is a
                # path segment in every one of these URLs, this runs in GitHub
                # Actions on a public repo, and `requests` puts the failing URL
                # (key and all) into its exception text.
                print(f"[warn] {source} {start}: {_fault(exc, settings.firms_map_key)}", file=sys.stderr)
                continue
            for rec in csv.DictReader(io.StringIO(text)):
                if rec.get("type", "").strip() not in _EXCLUDED_TYPES:
                    continue
                try:
                    d, hm = rec["acq_date"], rec["acq_time"].zfill(4)
                    t = datetime.strptime(f"{d} {hm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
                    lat, lon = float(rec["latitude"]), float(rec["longitude"])
                except (KeyError, ValueError):
                    continue  # malformed row: nothing to match against the store either
                bad.add(_src_id(lat, lon, t, rec.get("satellite", ""), tier))
    return bad


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv
    settings = load_settings()
    if settings.firms_map_key is None:
        sys.exit("FIRMS_MAP_KEY missing")
    if not settings.r2_configured:
        sys.exit("R2_* env vars missing — refusing to run against no store")

    client = make_client(settings)
    generation = hydrate(settings, client)
    if generation is None:
        sys.exit("cold bucket — nothing to purge")

    import requests

    def http_get(url: str) -> str:
        try:
            r = requests.get(url, timeout=120)
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - re-raised, only the text changes
            raise RuntimeError(_fault(exc, settings.firms_map_key)) from None
        return r.text

    bad = offending_src_ids(settings, http_get)
    print(f"[info] {len(bad)} offshore/static-land-source src_ids identified")

    store = settings.data_dir / "raw" / "hotspots.parquet"
    backup = store.with_suffix(".parquet.bak")
    backup.write_bytes(store.read_bytes())
    print(f"[info] backed up store to {backup}")

    if dry_run:
        print("[info] --dry-run: not deleting, not uploading")
        return 0

    key = archive_key(generation)
    pre_purge_key = f"{key}.pre-purge-backup"
    client.copy_object(
        Bucket=settings.r2_bucket, Key=pre_purge_key,
        CopySource={"Bucket": settings.r2_bucket, "Key": key},
    )
    print(f"[info] backed up pre-purge archive to {pre_purge_key} (R2, survives this run)")

    removed = delete_by_src_id(store, bad)
    print(f"[info] removed {removed} rows from the local store")

    client.put_object(
        Bucket=settings.r2_bucket, Key=key, Body=store.read_bytes(),
        ContentType="application/vnd.apache.parquet",
    )
    print(f"[info] uploaded cleaned archive to {key}")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main(sys.argv[1:]))
