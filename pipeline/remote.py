"""Cloudflare R2 as the durable home of the archive and the published site data.

The pipeline itself stays filesystem-only; this module is the single boundary
that knows a bucket exists. It is import-safe without credentials and every
function takes an injected client, so tests never touch the network.

Publish order is load-bearing: generation files, then the archive, then
manifest.json LAST. The manifest is the commit point — it names the exact
archive its generation was built from, so a failure at any boundary leaves the
previous (manifest, archive) pair intact and mutually consistent. Hydrate then
reads the archive the live manifest NAMES rather than whichever is newest,
which is what keeps lineage and carry-forward reasoning about one generation.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import Settings

ARCHIVE_PREFIX = "archive/"
DATA_PREFIX = "data/"
MANIFEST_KEY = f"{DATA_PREFIX}manifest.json"
# botocore clients are thread-safe for API calls; the ceiling here is R2's
# per-connection round trip, not local CPU.
UPLOAD_WORKERS = 16


def archive_key(generation: str) -> str:
    return f"{ARCHIVE_PREFIX}hotspots-{generation}.parquet"


def make_client(settings: Settings):  # pragma: no cover - network
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
    )


def _get(client, bucket: str, key: str) -> bytes | None:
    try:
        return client.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception:  # noqa: BLE001 - a missing object is a normal cold start
        return None


def _keys(client, bucket: str, prefix: str) -> list[str]:
    """Every key under `prefix`, following pagination.

    S3 and R2 return at most 1000 keys per call and signal more with
    IsTruncated. A single unpaginated call silently truncated both callers: a
    generation is ~8000 objects, so hydrate restored an eighth of it (lineage
    then read a fraction of the tracks), and prune_remote saw only the oldest
    generation's files, so it never pruned — 21 generations accumulated in
    production where this keeps 3.
    """
    keys: list[str] = []
    token: str | None = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        keys.extend(o["Key"] for o in response.get("Contents", []))
        if not response.get("IsTruncated"):
            return keys
        token = response.get("NextContinuationToken")
        if not token:  # defensive: a truncated page with no token cannot advance
            return keys


def hydrate(settings: Settings, client) -> str | None:
    """Restore published state: the live manifest, its generation dir, and the
    archive that manifest names. Returns the generation, or None on a cold
    bucket (first ever run)."""
    raw = _get(client, settings.r2_bucket, MANIFEST_KEY)
    if raw is None:
        return None
    manifest = json.loads(raw)
    generation = manifest["generation"]

    settings.out_dir.mkdir(parents=True, exist_ok=True)
    (settings.out_dir / "manifest.json").write_bytes(raw)

    def download(key: str) -> None:
        body = _get(client, settings.r2_bucket, key)
        if body is None:
            return
        relative = key[len(DATA_PREFIX):]
        destination = settings.out_dir / relative
        # Keys come from our own publish(), but they are still remote input:
        # refuse anything that would escape out_dir rather than trusting the
        # bucket's contents to be well-formed.
        if ".." in Path(relative).parts or Path(relative).is_absolute():
            print(f"[warn] refusing suspicious remote key: {key}")
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)

    # Same round-trip bound as publish(): a generation is thousands of small
    # objects, and hydrate runs before every refresh.
    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
        list(pool.map(download, _keys(client, settings.r2_bucket, f"{DATA_PREFIX}{generation}/")))

    body = _get(client, settings.r2_bucket, manifest.get("archive") or archive_key(generation))
    if body is not None:
        store = settings.data_dir / "raw" / "hotspots.parquet"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_bytes(body)
    return generation


def publish(settings: Settings, generation_dir: Path, client) -> None:
    bucket = settings.r2_bucket
    generation = generation_dir.name

    def upload(path: Path) -> None:
        relative = path.relative_to(settings.out_dir).as_posix()
        client.put_object(
            Bucket=bucket,
            Key=f"{DATA_PREFIX}{relative}",
            Body=path.read_bytes(),
            ContentType="application/json",
        )

    # A generation is thousands of small objects (one track per fire event, one
    # slice per day), and each PUT is a round trip. Serially that measured ~24
    # minutes for 8306 files — longer than the 15-minute refresh interval and
    # past the workflow timeout, so the manifest would never be written and the
    # site would never advance. Concurrency here is what makes the cadence real.
    files = [p for p in sorted(generation_dir.rglob("*")) if p.is_file()]
    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
        # list() forces the iterator so a failed upload re-raises here, before
        # the manifest is written.
        list(pool.map(upload, files))

    store = settings.data_dir / "raw" / "hotspots.parquet"
    key = archive_key(generation)
    if store.exists():
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=store.read_bytes(),
            ContentType="application/vnd.apache.parquet",
        )

    manifest = json.loads((settings.out_dir / "manifest.json").read_text())
    manifest["archive"] = key
    client.put_object(
        Bucket=bucket,
        Key=MANIFEST_KEY,
        Body=json.dumps(manifest).encode(),
        ContentType="application/json",
    )
    prune_remote(settings, client)


def prune_remote(settings: Settings, client, keep: int = 3) -> None:
    """Keep the newest `keep` generations and their archives. Generation names
    are UTC timestamps, so lexicographic order is chronological order."""
    bucket = settings.r2_bucket
    generations = sorted({
        key[len(DATA_PREFIX):].split("/")[0]
        for key in _keys(client, bucket, DATA_PREFIX)
        if key[len(DATA_PREFIX):].startswith("gen-")
    })
    for old in generations[:-keep] if len(generations) > keep else []:
        for key in _keys(client, bucket, f"{DATA_PREFIX}{old}/"):
            client.delete_object(Bucket=bucket, Key=key)
        client.delete_object(Bucket=bucket, Key=archive_key(old))
