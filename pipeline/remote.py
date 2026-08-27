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

from .config import ARCHIVE_TRACKS_INDEX, GENERATIONS_KEPT, TRACK_INDEX, Settings

ARCHIVE_PREFIX = "archive/"
DATA_PREFIX = "data/"
MANIFEST_KEY = f"{DATA_PREFIX}manifest.json"
# botocore clients are thread-safe for API calls; the ceiling here is R2's
# per-connection round trip, not local CPU.
UPLOAD_WORKERS = 16
# S3/R2 cap a batch delete at 1000 keys per call.
DELETE_BATCH = 1000


def archive_key(generation: str) -> str:
    return f"{ARCHIVE_PREFIX}hotspots-{generation}.parquet"


def effis_archive_key(generation: str) -> str:
    """Generation-addressed R2 key for EFFIS (burn perimeter) snapshot.

    CI runs fresh checkout every time: a snapshot written only to data/raw/
    would never be seen again, taking the 6-hour fetch gate and the
    retain-on-failure guarantee with it. R2 durability (alongside hotspots)
    solves this.

    Note: key sits under data/archive/, inside the published site namespace,
    while hotspot archive is at sibling archive/. This is safe only because
    _generation_names filters on startswith("gen-") and discards data/.
    """
    return f"{DATA_PREFIX}archive/{generation}-effis-ba.parquet"


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
    #
    # Nearly all of them are tracks, and refresh reads a previous generation's
    # tracks for exactly one purpose: the id -> cells map behind the merge
    # lineage. Since export() writes that map to TRACK_INDEX, fetching the
    # tracks as well is ~9300 round trips for data we already hold — measured
    # at 320s of a 16-minute refresh. Skip them only when the index is actually
    # present in this generation: the one live at deploy time predates it, and
    # dropping its tracks would blank the lineage for that refresh.
    keys = _keys(client, settings.r2_bucket, f"{DATA_PREFIX}{generation}/")
    tracks_prefix = f"{DATA_PREFIX}{generation}/tracks/"
    if f"{DATA_PREFIX}{generation}/{TRACK_INDEX}" in keys:
        keys = [k for k in keys if not k.startswith(tracks_prefix)]
    with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
        list(pool.map(download, keys))

    body = _get(client, settings.r2_bucket, manifest.get("archive") or archive_key(generation))
    if body is not None:
        store = settings.data_dir / "raw" / "hotspots.parquet"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_bytes(body)

    effis_key = manifest.get("effis_archive")
    if effis_key:
        body = _get(client, settings.r2_bucket, effis_key)
        if body is not None:
            snapshot = settings.data_dir / "raw" / "effis_ba.parquet"
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            snapshot.write_bytes(body)

    # The permanent past-scar track archive (archive_tracks.py). Only the
    # small index is fetched here, deliberately — the archived track bodies
    # themselves are NOT downloaded, the same round-trip-avoidance as the
    # tracks/ skip above but permanent rather than conditional: they never
    # change once written, so every run downloading all of them would grow
    # unbounded with how many past fires have ever been archived. The index
    # alone is enough for archive_past_tracks() to know what to skip.
    archive_index_body = _get(client, settings.r2_bucket, f"{DATA_PREFIX}{ARCHIVE_TRACKS_INDEX}")
    if archive_index_body is not None:
        index_path = settings.out_dir / ARCHIVE_TRACKS_INDEX
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_bytes(archive_index_body)
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
    # The permanent past-scar archive (archive_tracks.py) is a sibling of the
    # generation dirs under out_dir, not inside one — `upload()` above already
    # keys by path relative to out_dir, so no special-casing is needed here.
    # This stays cheap because hydrate() never re-downloads archived track
    # bodies: only files archive_past_tracks() wrote FRESH this run exist
    # locally, so this walk only ever uploads new/changed past fires plus the
    # small index, never the whole accumulated archive.
    archive_dir = settings.out_dir / "archive"
    if archive_dir.exists():
        files += [p for p in sorted(archive_dir.rglob("*")) if p.is_file()]
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

    snapshot = settings.data_dir / "raw" / "effis_ba.parquet"
    effis_key = effis_archive_key(generation) if snapshot.exists() else None
    if effis_key:
        client.put_object(
            Bucket=bucket,
            Key=effis_key,
            Body=snapshot.read_bytes(),
            ContentType="application/vnd.apache.parquet",
        )

    manifest = json.loads((settings.out_dir / "manifest.json").read_text())
    manifest["archive"] = key
    if effis_key:
        manifest["effis_archive"] = effis_key
    client.put_object(
        Bucket=bucket,
        Key=MANIFEST_KEY,
        Body=json.dumps(manifest).encode(),
        ContentType="application/json",
    )
    prune_remote(settings, client)


def _generation_names(client, bucket: str) -> list[str]:
    """Generation names, from a DELIMITED listing.

    Listing every key under data/ just to read the first path segment meant
    walking every object in every generation — ~168k keys in production, on
    every publish. A delimiter makes S3 roll each generation up into one
    CommonPrefixes entry, so this costs a couple of calls regardless of size.
    """
    names: list[str] = []
    token: str | None = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": DATA_PREFIX, "Delimiter": "/"}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for entry in response.get("CommonPrefixes", []):
            name = entry["Prefix"][len(DATA_PREFIX):].rstrip("/")
            if name.startswith("gen-"):
                names.append(name)
        if not response.get("IsTruncated"):
            return sorted(names)
        token = response.get("NextContinuationToken")
        if not token:
            return sorted(names)


def _delete_keys(client, bucket: str, keys: list[str]) -> None:
    """Delete in batches of DELETE_BATCH.

    R2 implements DeleteObjects, but pruning is the last step of publish() and
    runs after the manifest is already committed — so a batch call that the
    endpoint rejects must degrade to one-by-one rather than take the run down
    with it. Falling behind on pruning is recoverable; failing the publish that
    just succeeded is not.
    """
    for i in range(0, len(keys), DELETE_BATCH):
        chunk = keys[i : i + DELETE_BATCH]
        try:
            client.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in chunk]})
        except Exception as exc:  # noqa: BLE001 - any batch failure falls back
            print(f"[warn] batch delete unavailable ({exc}); deleting one at a time")
            for key in chunk:
                client.delete_object(Bucket=bucket, Key=key)


def prune_remote(settings: Settings, client, keep: int = GENERATIONS_KEPT) -> None:
    """Keep the newest `keep` generations and their archives. Generation names
    are UTC timestamps, so lexicographic order is chronological order.

    Cost is what matters here, not correctness alone. Deleting one key per round
    trip ran a backlog of 18 generations (~8000 objects each) past the job
    timeout on EVERY refresh once 4da4f13 let prune see the whole bucket: the
    manifest had already been written, so the site advanced, but the job always
    died mid-prune and the backlog never shrank. Batching turns ~144k round
    trips into ~150.
    """
    bucket = settings.r2_bucket
    generations = _generation_names(client, bucket)
    for old in generations[:-keep] if len(generations) > keep else []:
        _delete_keys(client, bucket, _keys(client, bucket, f"{DATA_PREFIX}{old}/"))
        _delete_keys(client, bucket, [archive_key(old), effis_archive_key(old)])
