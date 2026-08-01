"""R2 boundary: hydrate/publish must stay a consistent pair under failure.

The publish order (generation files -> archive -> manifest LAST) is the whole
contract: the manifest is the commit point and names the archive its generation
was built from, so a crash at any boundary leaves the previous pair live.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.config import load_settings
from pipeline.remote import MANIFEST_KEY, archive_key, hydrate, prune_remote, publish


class _Body:
    def __init__(self, data: bytes):
        self._data = data

    def read(self) -> bytes:
        return self._data


class FakeS3:
    """In-memory stand-in for the boto3 S3 client surface we use."""

    def __init__(self, objects: dict[str, bytes] | None = None, fail_on: str | None = None):
        self.objects: dict[str, bytes] = dict(objects or {})
        self.fail_on = fail_on
        self.put_order: list[str] = []
        self.deleted: list[str] = []
        # Round-trip counters: the prune backlog blew the job timeout because
        # of call COUNT, not bytes, so that is what the tests assert on.
        self.delete_calls = 0
        self.list_calls = 0

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FileNotFoundError(Key)
        return {"Body": _Body(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, **kw):
        if self.fail_on and Key == self.fail_on:
            raise RuntimeError(f"upload failed: {Key}")
        self.put_order.append(Key)
        self.objects[Key] = Body

    # S3 and R2 cap a listing at 1000 keys and signal more with IsTruncated +
    # NextContinuationToken. The fake MUST reproduce that: a fake that returns
    # everything in one page hides the exact bug this class exists to catch.
    PAGE = 1000

    def list_objects_v2(self, Bucket, Prefix="", ContinuationToken=None, Delimiter=None):
        keys = [k for k in sorted(self.objects) if k.startswith(Prefix)]
        self.list_calls += 1
        if Delimiter:
            # Real S3 rolls every key sharing a prefix up to the next delimiter
            # into CommonPrefixes and omits it from Contents — that is what
            # makes "list the generation names" one cheap call instead of a
            # walk over every object in every generation.
            prefixes, contents = [], []
            for k in keys:
                rest = k[len(Prefix):]
                if Delimiter in rest:
                    cp = Prefix + rest.split(Delimiter)[0] + Delimiter
                    if cp not in prefixes:
                        prefixes.append(cp)
                else:
                    contents.append(k)
            return {
                "CommonPrefixes": [{"Prefix": p} for p in prefixes],
                "Contents": [{"Key": k} for k in contents],
            }
        start = int(ContinuationToken or 0)
        page = keys[start:start + self.PAGE]
        if not page:
            return {}
        out = {"Contents": [{"Key": k} for k in page]}
        if start + self.PAGE < len(keys):
            out["IsTruncated"] = True
            out["NextContinuationToken"] = str(start + self.PAGE)
        return out

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        self.delete_calls += 1
        self.objects.pop(Key, None)

    # S3/R2 batch delete: up to 1000 keys per call. Refuses more, like the real
    # API, so a test cannot pass by sending an impossible batch.
    DELETE_BATCH = 1000

    def delete_objects(self, Bucket, Delete):
        keys = [o["Key"] for o in Delete["Objects"]]
        if len(keys) > self.DELETE_BATCH:
            raise ValueError(f"too many keys in one delete: {len(keys)}")
        self.delete_calls += 1
        for k in keys:
            self.deleted.append(k)
            self.objects.pop(k, None)
        return {"Deleted": [{"Key": k} for k in keys]}


def _settings(tmp_path: Path):
    return load_settings(env={
        "R2_ACCOUNT_ID": "acc", "R2_ACCESS_KEY_ID": "kid",
        "R2_SECRET_ACCESS_KEY": "sek", "R2_BUCKET": "b",
        "DATA_DIR": str(tmp_path / "data"), "OUT_DIR": str(tmp_path / "out"),
    })


def _make_generation(out: Path, name: str) -> Path:
    gen = out / name
    (gen / "tracks").mkdir(parents=True)
    (gen / "events.geojson").write_text('{"type":"FeatureCollection","features":[]}')
    (gen / "stats.json").write_text('{"detections":{}}')
    (gen / "lineage.json").write_text('{"merged":{},"reactivated":{}}')
    (gen / "tracks" / "e1.json").write_text('{"id":"e1"}')
    return gen


def _publishable(tmp_path: Path, name: str = "gen-20260730T120000Z"):
    settings = _settings(tmp_path)
    gen = _make_generation(settings.out_dir, name)
    (settings.out_dir / "manifest.json").write_text(json.dumps({"generation": name}))
    (settings.data_dir / "raw").mkdir(parents=True)
    (settings.data_dir / "raw" / "hotspots.parquet").write_bytes(b"PARQUET")
    return settings, gen


def test_publish_writes_manifest_last(tmp_path):
    settings, gen = _publishable(tmp_path)
    fake = FakeS3()

    publish(settings, gen, fake)

    assert fake.put_order[-1] == "data/manifest.json"
    assert archive_key(gen.name) in fake.put_order
    assert fake.put_order.index(archive_key(gen.name)) < fake.put_order.index("data/manifest.json")


def test_published_manifest_names_its_archive(tmp_path):
    settings, gen = _publishable(tmp_path)
    fake = FakeS3()

    publish(settings, gen, fake)

    manifest = json.loads(fake.objects["data/manifest.json"])
    assert manifest["archive"] == archive_key(gen.name)


def test_publish_uploads_nested_generation_files(tmp_path):
    settings, gen = _publishable(tmp_path)
    fake = FakeS3()

    publish(settings, gen, fake)

    assert f"data/{gen.name}/tracks/e1.json" in fake.objects
    assert f"data/{gen.name}/events.geojson" in fake.objects


def test_publish_failure_before_manifest_leaves_no_manifest(tmp_path):
    settings, gen = _publishable(tmp_path)
    fake = FakeS3(fail_on=archive_key(gen.name))

    with pytest.raises(RuntimeError):
        publish(settings, gen, fake)

    assert "data/manifest.json" not in fake.objects


def test_hydrate_restores_archive_named_by_manifest(tmp_path):
    settings = _settings(tmp_path)
    objects = {
        "data/manifest.json": json.dumps({
            "generation": "gen-20260730T110000Z",
            "archive": "archive/hotspots-gen-20260730T110000Z.parquet",
        }).encode(),
        "data/gen-20260730T110000Z/events.geojson": b'{"type":"FeatureCollection","features":[]}',
        "data/gen-20260730T110000Z/tracks/e1.json": b'{"id":"e1"}',
        "archive/hotspots-gen-20260730T110000Z.parquet": b"PARQUET",
        "archive/hotspots-gen-20260101T000000Z.parquet": b"OLD",
    }

    restored = hydrate(settings, FakeS3(objects))

    assert restored == "gen-20260730T110000Z"
    # the archive the manifest NAMES, not merely the newest one present
    assert (settings.data_dir / "raw" / "hotspots.parquet").read_bytes() == b"PARQUET"
    assert (settings.out_dir / "gen-20260730T110000Z" / "tracks" / "e1.json").exists()
    assert json.loads((settings.out_dir / "manifest.json").read_text())["generation"] == (
        "gen-20260730T110000Z"
    )


def test_hydrate_empty_bucket_is_a_cold_start(tmp_path):
    assert hydrate(_settings(tmp_path), FakeS3()) is None


def test_prune_keeps_newest_generations_and_their_archives(tmp_path):
    settings = _settings(tmp_path)
    objects = {}
    for stamp in ("gen-1", "gen-2", "gen-3", "gen-4"):
        objects[f"data/{stamp}/events.geojson"] = b"{}"
        objects[archive_key(stamp)] = b"P"

    fake = FakeS3(objects)
    prune_remote(settings, fake, keep=3)

    assert "data/gen-1/events.geojson" not in fake.objects
    assert archive_key("gen-1") not in fake.objects
    assert "data/gen-4/events.geojson" in fake.objects
    assert archive_key("gen-2") in fake.objects


def test_publish_still_writes_manifest_after_concurrent_uploads(tmp_path):
    """Uploads run in a thread pool for speed; the manifest must still be the
    last write, or a client could see a generation that is not fully there."""
    settings, gen = _publishable(tmp_path)
    for i in range(40):
        (gen / "tracks" / f"e{i}.json").write_text(f'{{"id":"e{i}"}}')
    fake = FakeS3()

    publish(settings, gen, fake)

    assert fake.put_order[-1] == "data/manifest.json"
    # e0..e39, with e1 overwriting the one _publishable already wrote
    assert len([k for k in fake.objects if k.startswith(f"data/{gen.name}/tracks/")]) == 40


def test_publish_propagates_an_upload_failure_from_the_pool(tmp_path):
    """A failure inside a worker thread must abort before the manifest lands,
    not be swallowed by the executor."""
    settings, gen = _publishable(tmp_path)
    fake = FakeS3(fail_on=f"data/{gen.name}/stats.json")

    with pytest.raises(RuntimeError):
        publish(settings, gen, fake)

    assert "data/manifest.json" not in fake.objects


def test_hydrate_refuses_a_traversing_key(tmp_path):
    """Remote keys are our own output, but hydrate still must not write outside
    out_dir if the bucket ever serves a malformed key."""
    settings = _settings(tmp_path)
    objects = {
        "data/manifest.json": json.dumps({"generation": "gen-1"}).encode(),
        "data/gen-1/events.geojson": b"{}",
        "data/gen-1/../../escaped.json": b"pwned",
    }

    hydrate(settings, FakeS3(objects))

    assert (settings.out_dir / "gen-1" / "events.geojson").exists()
    assert not (settings.out_dir.parent / "escaped.json").exists()
    assert not (tmp_path / "escaped.json").exists()


def test_keys_pages_past_the_thousand_key_cap(tmp_path):
    """S3/R2 return at most 1000 keys per call. Without pagination hydrate
    restored only the first 1000 files of a generation (so lineage read a
    fraction of the tracks) and prune_remote saw a truncated view of the
    bucket, so it never pruned — 21 generations accumulated in production
    where the design keeps 3."""
    from pipeline.remote import _keys

    settings = _settings(tmp_path)
    objects = {f"data/gen-1/tracks/e{i:05d}.json": b"{}" for i in range(2500)}
    fake = FakeS3(objects)

    assert len(_keys(fake, settings.r2_bucket, "data/")) == 2500


def test_hydrate_restores_every_file_of_a_large_generation(tmp_path):
    settings = _settings(tmp_path)
    objects = {
        "data/manifest.json": json.dumps({"generation": "gen-1"}).encode(),
    }
    for i in range(1500):
        objects[f"data/gen-1/tracks/e{i:05d}.json"] = b'{"id":"x"}'

    hydrate(settings, FakeS3(objects))

    restored = list((settings.out_dir / "gen-1" / "tracks").glob("*.json"))
    assert len(restored) == 1500


def test_prune_sees_generations_beyond_the_first_page(tmp_path):
    """The bug in production: every generation's files sort before the next
    generation's, so a truncated listing showed only the oldest few and prune
    kept everything else forever."""
    settings = _settings(tmp_path)
    objects = {}
    for g in range(6):
        for i in range(400):
            objects[f"data/gen-{g}/tracks/e{i:04d}.json"] = b"{}"
        objects[archive_key(f"gen-{g}")] = b"P"

    fake = FakeS3(objects)
    prune_remote(settings, fake, keep=3)

    remaining = sorted({
        k[len("data/"):].split("/")[0] for k in fake.objects if k.startswith("data/gen-")
    })
    assert remaining == ["gen-3", "gen-4", "gen-5"]
    assert archive_key("gen-0") not in fake.objects
    assert archive_key("gen-5") in fake.objects


def test_prune_backlog_stays_within_a_sane_round_trip_budget(tmp_path):
    """Pruning a backlog must cost calls proportional to BATCHES, not objects.

    Deleting one key per call is what broke prod on 2026-08-01: paginating the
    listings (4da4f13) let prune finally see the 21 accumulated generations, and
    deleting ~8000 objects each, one round trip at a time, ran past the job
    timeout on every single refresh. The manifest was written first, so the site
    still advanced, but the job always died in prune and the backlog never
    shrank — every run since that commit was cancelled.
    """
    settings = _settings(tmp_path)
    objects = {MANIFEST_KEY: json.dumps({"generation": "gen-9"}).encode()}
    for g in range(6):  # 6 generations, 3 kept -> 3 pruned
        for i in range(2500):  # each bigger than one list page and one delete batch
            objects[f"data/gen-{g}/tracks/{i:05d}.json"] = b"{}"
        objects[f"archive/hotspots-gen-{g}.parquet"] = b""
    client = FakeS3(objects)

    prune_remote(settings, client, keep=3)

    for g in range(3):
        assert not [k for k in client.objects if k.startswith(f"data/gen-{g}/")]
        assert f"archive/hotspots-gen-{g}.parquet" not in client.objects
    for g in range(3, 6):
        assert len([k for k in client.objects if k.startswith(f"data/gen-{g}/")]) == 2500

    # 7500 objects + 3 archives. One-per-call would be 7503; batching at 1000
    # is ~11. Leave headroom but keep the assertion meaningful.
    assert client.delete_calls < 40, f"{client.delete_calls} delete round trips"


def test_prune_finds_generations_without_walking_every_object(tmp_path):
    """Generation NAMES come from a delimited listing, so discovering them costs
    a couple of calls rather than a walk over every object in every generation
    (which was ~168k keys in prod, on every publish)."""
    settings = _settings(tmp_path)
    objects = {MANIFEST_KEY: json.dumps({"generation": "gen-3"}).encode()}
    for g in range(4):
        for i in range(2500):
            objects[f"data/gen-{g}/tracks/{i:05d}.json"] = b"{}"
    client = FakeS3(objects)

    prune_remote(settings, client, keep=4)  # nothing to delete: discovery only

    assert client.delete_calls == 0
    assert client.list_calls <= 3, f"{client.list_calls} list calls to find 4 names"


def test_prune_falls_back_when_batch_delete_is_rejected(tmp_path):
    """Pruning is the last step of publish(), after the manifest is committed.
    A batch delete the endpoint refuses must not take down a run that already
    published successfully."""
    class NoBatch(FakeS3):
        def delete_objects(self, Bucket, Delete):
            raise RuntimeError("NotImplemented")

    settings = _settings(tmp_path)
    objects = {MANIFEST_KEY: json.dumps({"generation": "gen-1"}).encode()}
    for g in range(2):
        objects[f"data/gen-{g}/events.geojson"] = b"{}"
    client = NoBatch(objects)

    prune_remote(settings, client, keep=1)

    assert not [k for k in client.objects if k.startswith("data/gen-0/")]
    assert "data/gen-1/events.geojson" in client.objects
