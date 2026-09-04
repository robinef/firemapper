"""One-off maintenance: purge already-ingested open-water FIRMS detections
(sun glint, ships, gas flares — never wildfires) from the R2-archived hotspot
store.

pipeline/fetch_firms.py's land-mask filter only stops NEW rows like these from
entering the store. Rows fetched before that fix are still in the archive and
keep clustering into events until they individually age out of the live
(14-day) or scar (45-day) window. This classifies every currently-stored row
against pipeline.landmask.is_near_land() directly — no FIRMS re-fetch needed,
since land/sea classification only needs the lat/lon already on the row — and
drops the ones that land in open water. It rewrites the SAME archive key the
current manifest already names, so the next ordinary refresh (fast or full)
picks up the cleaned store with no other change.

    uv run python -m scripts.purge_offshore_hotspots [--dry-run]
"""
from __future__ import annotations

import sys

from pipeline.landmask import is_near_land
from pipeline.config import load_settings
from pipeline.remote import archive_key, hydrate, make_client
from pipeline.store import delete_by_src_id, read_hotspots


def offending_src_ids(store) -> set[str]:
    """src_ids of every currently-stored row whose lat/lon is not on or near
    land."""
    return {r["src_id"] for r in read_hotspots(store) if not is_near_land(r["lat"], r["lon"])}


def main(argv: list[str]) -> int:
    dry_run = "--dry-run" in argv
    settings = load_settings()
    if not settings.r2_configured:
        sys.exit("R2_* env vars missing — refusing to run against no store")

    client = make_client(settings)
    generation = hydrate(settings, client)
    if generation is None:
        sys.exit("cold bucket — nothing to purge")

    store = settings.data_dir / "raw" / "hotspots.parquet"
    bad = offending_src_ids(store)
    print(f"[info] {len(bad)} offshore/open-water src_ids identified")

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
