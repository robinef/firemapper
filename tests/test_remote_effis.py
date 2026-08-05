import json
from pathlib import Path

from pipeline.remote import effis_archive_key, hydrate, publish


class FakeClient:
    """Minimal in-memory S3 stand-in: put/get/list over a dict.

    Records put_object call order to verify load-bearing invariants
    (e.g., archives uploaded before the manifest that names them).
    """

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.put_order = []  # List of Keys in put_object call order

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objects[Key] = Body
        self.put_order.append(Key)

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FileNotFoundError(Key)
        return {"Body": _Body(self.objects[Key])}

    def list_objects_v2(self, **kwargs):
        prefix = kwargs.get("Prefix", "")
        delimiter = kwargs.get("Delimiter")

        if delimiter:
            # Return CommonPrefixes for delimited listing (used by _generation_names)
            prefixes = set()
            for key in self.objects:
                if key.startswith(prefix):
                    rest = key[len(prefix):]
                    if delimiter in rest:
                        common_prefix = prefix + rest.split(delimiter)[0] + delimiter
                        prefixes.add(common_prefix)
            return {"CommonPrefixes": [{"Prefix": p} for p in sorted(prefixes)],
                    "IsTruncated": False}
        else:
            # Return Contents for normal listing
            return {"Contents": [{"Key": k} for k in self.objects if k.startswith(prefix)],
                    "IsTruncated": False}

    def delete_objects(self, Bucket, Delete):
        for obj in Delete["Objects"]:
            self.objects.pop(obj["Key"], None)

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


class _Body:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class FakeSettings:
    def __init__(self, tmp_path: Path):
        self.data_dir = tmp_path / "data"
        self.out_dir = tmp_path / "out"
        self.r2_bucket = "test-bucket"


def _gen(settings, name="gen-1"):
    gen = settings.out_dir / name
    gen.mkdir(parents=True, exist_ok=True)
    (gen / "manifest.json").write_text(json.dumps({"generation": name}))
    settings.out_dir.mkdir(parents=True, exist_ok=True)
    (settings.out_dir / "manifest.json").write_text(json.dumps({"generation": name}))
    return gen


def test_publish_uploads_the_effis_snapshot(tmp_path):
    settings = FakeSettings(tmp_path)
    gen = _gen(settings)

    # Create both hotspots and EFFIS snapshots
    raw = settings.data_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / "hotspots.parquet").write_bytes(b"PAR1-hotspots")
    (raw / "effis_ba.parquet").write_bytes(b"PAR1-effis")

    client = FakeClient()
    publish(settings, gen, client)

    assert client.objects[effis_archive_key("gen-1")] == b"PAR1-effis"
    manifest = json.loads(client.objects["data/manifest.json"])
    assert manifest["effis_archive"] == effis_archive_key("gen-1")

    # Load-bearing invariant: archives uploaded before manifest (atomicity guarantee).
    manifest_idx = client.put_order.index("data/manifest.json")
    effis_idx = client.put_order.index(effis_archive_key("gen-1"))
    hotspot_idx = client.put_order.index("archive/hotspots-gen-1.parquet")
    assert effis_idx < manifest_idx, "EFFIS archive must be uploaded before manifest"
    assert hotspot_idx < manifest_idx, "Hotspot archive must be uploaded before manifest"


def test_hydrate_restores_the_effis_snapshot(tmp_path):
    settings = FakeSettings(tmp_path)
    # Store the archive at a deliberately different key to verify hydrate reads
    # the manifest pointer, not guessing a key based on generation name.
    other_key = "data/archive/other-effis-ba.parquet"
    client = FakeClient({
        "data/manifest.json": json.dumps(
            {"generation": "gen-1", "effis_archive": other_key}
        ).encode(),
        other_key: b"PAR1-effis",
    })

    hydrate(settings, client)
    assert (settings.data_dir / "raw" / "effis_ba.parquet").read_bytes() == b"PAR1-effis"


def test_hydrate_without_an_effis_archive_is_not_fatal(tmp_path):
    settings = FakeSettings(tmp_path)
    client = FakeClient({
        "data/manifest.json": json.dumps({"generation": "gen-1"}).encode(),
    })
    assert hydrate(settings, client) == "gen-1"
    assert not (settings.data_dir / "raw" / "effis_ba.parquet").exists()


def test_publish_without_a_snapshot_omits_the_key(tmp_path):
    settings = FakeSettings(tmp_path)
    gen = _gen(settings)
    client = FakeClient()
    publish(settings, gen, client)
    manifest = json.loads(client.objects["data/manifest.json"])
    assert "effis_archive" not in manifest


def test_prune_deletes_the_effis_archive_with_its_generation(tmp_path):
    """Generation-addressed keys leak unless prune knows about them.
    remote.py:226 removes only archive_key(old) today."""
    from pipeline.remote import archive_key, prune_remote

    settings = FakeSettings(tmp_path)
    objects = {}
    for name in ["gen-1", "gen-2", "gen-3", "gen-4"]:
        objects[f"data/{name}/manifest.json"] = b"{}"
        objects[archive_key(name)] = b"hotspots"
        objects[effis_archive_key(name)] = b"effis"
    client = FakeClient(objects)

    prune_remote(settings, client, keep=3)

    assert effis_archive_key("gen-1") not in client.objects
    assert archive_key("gen-1") not in client.objects
    assert effis_archive_key("gen-4") in client.objects


def test_round_trip_survives_a_failed_fetch(tmp_path):
    """hydrate -> failed fetch (snapshot untouched) -> publish keeps the data."""
    settings = FakeSettings(tmp_path)
    client = FakeClient({
        "data/manifest.json": json.dumps(
            {"generation": "gen-1", "effis_archive": effis_archive_key("gen-1")}
        ).encode(),
        effis_archive_key("gen-1"): b"PAR1-effis",
    })
    hydrate(settings, client)

    gen = _gen(settings, "gen-2")
    publish(settings, gen, client)
    assert client.objects[effis_archive_key("gen-2")] == b"PAR1-effis"
