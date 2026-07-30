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
from pipeline.remote import archive_key, hydrate, prune_remote, publish


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

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FileNotFoundError(Key)
        return {"Body": _Body(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, **kw):
        if self.fail_on and Key == self.fail_on:
            raise RuntimeError(f"upload failed: {Key}")
        self.put_order.append(Key)
        self.objects[Key] = Body

    def list_objects_v2(self, Bucket, Prefix=""):
        keys = [k for k in sorted(self.objects) if k.startswith(Prefix)]
        return {"Contents": [{"Key": k} for k in keys]} if keys else {}

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        self.objects.pop(Key, None)


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
