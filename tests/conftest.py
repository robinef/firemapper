"""Shared fixtures for the export tests.

`export_gen` builds one complete, publishable generation from synthetic
detections so a test can say what it is about — a single layer — instead of
restating the whole export call.

The detections are placed RELATIVE to the `now` it is handed. `cluster()` keeps
only `now - 48 h .. now`, so a fixed detection date would silently yield an
empty event set (and an events layer of status "empty") for any test that picks
a different `now`.
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from pipeline.config import load_settings
from pipeline.events import cluster
from pipeline.export import export
from tests.synth import T, hs

DEFAULT_NOW = T(20, 12)


@pytest.fixture
def export_gen(tmp_path):
    """Call `export()` against a throwaway out dir; return the generation dir."""

    def _export_gen(now=DEFAULT_NOW, **kwargs):
        settings = load_settings(
            env={"DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o")}
        )
        events = cluster(
            [
                hs(45.0, 8.0, now - timedelta(hours=12)),
                hs(45.005, 8.0, now - timedelta(hours=6)),
            ],
            now=now,
        )
        return export(settings, events, liveness={}, places=[], alerts=[], now=now, **kwargs)

    return _export_gen
