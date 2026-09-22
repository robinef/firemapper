"""scripts/backfill_season.py: the one-off January-June 2026 backfill of the
permanent track archive from the FIRMS Standard Processing (SP) archive.

Everything here is synthetic: FIRMS is an injected `http_get` serving CSV in
the real area-API column layout, and R2 is an in-memory fake."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import h3
import pytest

from pipeline.config import ARCHIVE_TRACKS_INDEX, H3_RES, load_settings
from scripts import backfill_season as bf
from tests.synth import hs
from tests.test_remote import FakeS3

KEY = "sEcReT-map-key"

HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_ti5,frp,daynight\n"
)

# Fictional inland Spanish points, far apart (no two fires can cluster).
MADRID = (40.4168, -3.7038)
VALLADOLID = (41.6523, -4.7245)
ZARAGOZA = (41.6488, -0.8891)


def U(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=timezone.utc)


def _csv(dets) -> str:
    lines = [
        f"{lat},{lon},330.0,0.4,0.4,{t:%Y-%m-%d},{t:%H%M},N,VIIRS,n,2.0SP,290.0,{frp},D"
        for lat, lon, t, frp in dets
    ]
    return HEADER + "".join(line + "\n" for line in lines)


class FakeFirms:
    """The FIRMS area API: `.../{key}/{source}/{area}/{span}/{start}` returns
    the detections of `source` dated start .. start + span - 1."""

    def __init__(self, dets_by_source: dict[str, list]):
        self.dets = dets_by_source
        self.urls: list[str] = []

    def __call__(self, url: str) -> str:
        self.urls.append(url)
        parts = url.split("/")
        source, span, start = parts[-4], int(parts[-2]), date.fromisoformat(parts[-1])
        end = start + timedelta(days=span)
        return _csv([d for d in self.dets.get(source, []) if start <= d[2].date() < end])


def _fire(lat, lon, t0: datetime, n=4, step_h=12, frp=20.0):
    """n detections on one spot, `step_h` apart: one event of n members."""
    return [(lat, lon, t0 + timedelta(hours=step_h * i), frp) for i in range(n)]


def _settings(tmp_path):
    return load_settings(env={
        "FIRMS_MAP_KEY": KEY, "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })


# --- windows and sources ----------------------------------------------------

def test_windows_chunk_the_range_in_five_days_and_clamp_the_last():
    w = bf.sp_windows(date(2026, 1, 1), date(2026, 7, 13))
    assert w[0] == (date(2026, 1, 1), 5)
    assert w[1] == (date(2026, 1, 6), 5)
    assert w[-1] == (date(2026, 7, 10), 4)  # Jul 10..13 inclusive, clamped
    assert len(w) == 39
    # contiguous, no gap and no overlap, exactly covering the range
    for (a, sa), (b, _) in zip(w, w[1:]):
        assert a + timedelta(days=sa) == b
    assert sum(s for _, s in w) == (date(2026, 7, 13) - date(2026, 1, 1)).days + 1


def test_default_fetch_range_runs_past_the_cutoff_by_the_lookahead():
    w = bf.sp_windows(bf.START, bf.FETCH_END)
    last_start, last_span = w[-1]
    assert last_start + timedelta(days=last_span - 1) == bf.CUTOFF + timedelta(days=bf.LOOKAHEAD_DAYS)
    assert len(w) == 40


def test_sources_are_snpp_and_noaa20_sp_only_modis_behind_a_flag():
    assert [s for s, _ in bf.sp_sources()] == ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP"]
    assert all("NOAA21" not in s for s, _ in bf.sp_sources(modis=True))
    assert ("MODIS_SP", "modis") in bf.sp_sources(modis=True)
    assert all(t == "viirs" for _, t in bf.sp_sources())


# --- fetch ------------------------------------------------------------------

def test_fetch_uses_the_injected_http_get_and_the_area_url_shape(tmp_path):
    store = tmp_path / "sp.parquet"
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 1, 2, 1))})
    report = bf.fetch_sp(KEY, store, [(date(2026, 1, 1), 5)], bf.sp_sources(), http_get=fake)
    assert fake.urls == [
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_SNPP_SP/-25.0,34.0,45.0,72.0/5/2026-01-01",
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_NOAA20_SP/-25.0,34.0,45.0,72.0/5/2026-01-01",
    ]
    assert report["rows"] == {"VIIRS_SNPP_SP": {"2026-01": 4}, "VIIRS_NOAA20_SP": {}}
    assert report["last_date"] == {"VIIRS_SNPP_SP": "2026-01-03", "VIIRS_NOAA20_SP": None}
    assert report["failed"] == []
    assert store.exists()


def test_a_failing_window_never_carries_the_key_and_is_recorded(tmp_path, capsys):
    def boom(url):
        raise RuntimeError(f"500 Server Error for url: {url}")

    report = bf.fetch_sp(
        KEY, tmp_path / "sp.parquet", [(date(2026, 1, 1), 5)], bf.sp_sources(),
        http_get=boom, sleep=lambda s: None,
    )
    out = capsys.readouterr()
    assert KEY not in out.out + out.err
    assert KEY not in json.dumps(report)
    assert [f["source"] for f in report["failed"]] == ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP"]
    assert all("<FIRMS_MAP_KEY>" in f["error"] for f in report["failed"])


def test_a_non_csv_body_is_a_failure_not_an_empty_window(tmp_path):
    """FIRMS answers a bad key or an exhausted quota with HTTP 200 and a
    one-line text body; parse_firms_csv would read that as zero rows and the
    run would report a quiet winter instead of a broken fetch."""
    report = bf.fetch_sp(
        KEY, tmp_path / "sp.parquet", [(date(2026, 1, 1), 5)], bf.sp_sources()[:1],
        http_get=lambda url: f"Invalid MAP_KEY {KEY}.", sleep=lambda s: None,
    )
    assert len(report["failed"]) == 1
    assert KEY not in json.dumps(report)


def test_a_transient_failure_is_retried(tmp_path):
    calls = []
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 1, 2, 1))})

    def flaky(url):
        calls.append(url)
        if len(calls) == 1:
            raise RuntimeError("503")
        return fake(url)

    report = bf.fetch_sp(
        KEY, tmp_path / "sp.parquet", [(date(2026, 1, 1), 5)], bf.sp_sources()[:1],
        http_get=flaky, sleep=lambda s: None,
    )
    assert report["failed"] == []
    assert report["rows"]["VIIRS_SNPP_SP"] == {"2026-01": 4}


# --- stepped clustering -----------------------------------------------------

def _rows(dets):
    return [hs(lat, lon, t, frp=frp) for lat, lon, t, frp in dets]


def test_a_fire_still_burning_at_the_last_step_is_not_archived(tmp_path):
    rows = _rows(_fire(*MADRID, U(2026, 7, 14, 1)))
    index, meta, _ = bf.backfill_tracks(rows, [U(2026, 7, 16)], tmp_path)
    assert index == {} and meta == {}


def test_a_rekindled_fire_keeps_one_id_and_the_later_body(tmp_path):
    """A >= 20-cell fire goes quiet (archived), then rekindles two rings off
    its edge four days later: bridging joins the two, the id (earliest
    detection) holds, and the archive ends up with the merged body — one
    file, not a second fire."""
    center = h3.latlng_to_cell(*MADRID, H3_RES)
    t0 = U(2026, 3, 10, 12)
    dets = [(*h3.cell_to_latlng(c), t0, 20.0) for c in sorted(h3.grid_disk(center, 3))]
    rekindle_cell = sorted(h3.grid_ring(center, 5))[0]
    lat, lon = h3.cell_to_latlng(rekindle_cell)
    dets += _fire(lat, lon, t0 + timedelta(days=4))
    rows = _rows(dets)

    index, meta, _ = bf.backfill_tracks(rows, [t0 + timedelta(days=3), t0 + timedelta(days=10)], tmp_path)

    assert len(index) == 1
    (eid,) = index
    body = json.loads((tmp_path / "archive" / "tracks" / f"{eid}.json").read_text())
    assert rekindle_cell in body["cells"]
    assert meta[eid]["last"] == t0 + timedelta(days=4, hours=36)


def test_default_steps_are_weekly_and_end_at_the_data_horizon():
    steps = bf.clustering_steps()
    assert steps[0] == U(2026, 1, 7)
    assert steps[1] == U(2026, 1, 14)
    assert steps[-1] == datetime.combine(bf.FETCH_END + timedelta(days=1), datetime.min.time(), timezone.utc)
    assert all(b - a <= timedelta(days=bf.STEP_DAYS) for a, b in zip(steps, steps[1:]))


# --- clobber guard ----------------------------------------------------------

def _meta(first, last, cells):
    return {"first": first, "last": last, "cells": set(cells)}


def test_guard_skips_live_ids_too_recent_events_and_overlaps():
    c_live = h3.latlng_to_cell(*ZARAGOZA, H3_RES)
    c_other = h3.latlng_to_cell(*VALLADOLID, H3_RES)
    c_far = h3.latlng_to_cell(*MADRID, H3_RES)
    index = {"inlive": "d1", "recent": "d2", "overlap": "d3", "fine": "d4", "sameplace_earlier": "d5"}
    meta = {
        "inlive": _meta(U(2026, 3, 1), U(2026, 3, 3), [c_far]),
        "recent": _meta(U(2026, 7, 10), U(2026, 7, 14), [c_other]),
        # ends Jul 11; a live fire on the neighbouring cell starts Jul 12 — SP
        # and NRT saw the same fire and would publish it twice
        "overlap": _meta(U(2026, 7, 5), U(2026, 7, 11, 12), [h3.grid_ring(c_live, 1)[0]]),
        "fine": _meta(U(2026, 2, 1), U(2026, 2, 3), [c_other]),
        # same ground as the live fire, but months before it: a different fire
        "sameplace_earlier": _meta(U(2026, 4, 1), U(2026, 4, 3), [c_live]),
    }
    live_index = {"inlive": "x", "livefire": "y"}
    live_cells = {"livefire": {"first": "2026-07-12", "cells": [c_live]}}

    kept, skipped = bf.guard(index, meta, live_index, live_cells, cutoff=U(2026, 7, 13))

    assert kept == {"fine": "d4", "sameplace_earlier": "d5"}
    assert skipped["live_id"] == ["inlive"]
    assert skipped["too_recent"] == ["recent"]
    assert skipped["overlap"] == [{"id": "overlap", "live": ["livefire"]}]


def test_an_event_ending_on_the_cutoff_day_belongs_to_the_live_archive():
    c = h3.latlng_to_cell(*MADRID, H3_RES)
    meta = {"a": _meta(U(2026, 7, 1), U(2026, 7, 13, 0), [c]), "b": _meta(U(2026, 7, 1), U(2026, 7, 12, 23), [c])}
    kept, skipped = bf.guard({"a": "1", "b": "2"}, meta, {}, {}, cutoff=U(2026, 7, 13))
    assert kept == {"b": "2"} and skipped["too_recent"] == ["a"]


# --- build end to end -------------------------------------------------------

def test_build_archives_feb_and_may_fires_via_stepping_and_never_touches_the_live_store(tmp_path):
    """A single clustering `now` at the end of the range would lose both:
    Feb is past MAX_FIRE_DAYS before it, May is past the scar window. Weekly
    stepping is what archives them."""
    settings = _settings(tmp_path)
    feb = _fire(*MADRID, U(2026, 2, 10, 1))
    may = _fire(*VALLADOLID, U(2026, 5, 10, 1))
    burning = _fire(*ZARAGOZA, U(2026, 7, 14, 1))  # still burning at the last step
    fake = FakeFirms({"VIIRS_SNPP_SP": feb + burning, "VIIRS_NOAA20_SP": may})
    out = tmp_path / "bf"

    summary = bf.build(settings, out, tmp_path / "d" / "backfill" / "sp.parquet", {}, {}, http_get=fake)

    index = json.loads((out / ARCHIVE_TRACKS_INDEX).read_text())
    assert len(index) == 2
    firsts = sorted(summary["tracks_by_month"])
    assert firsts == ["2026-02", "2026-05"]
    assert summary["earliest_first"] == "2026-02-10" and summary["latest_first"] == "2026-05-10"
    assert sorted(p.stem for p in (out / "archive" / "tracks").glob("*.json")) == sorted(index)
    assert len(fake.urls) == 80  # 40 windows x 2 sources
    assert not (settings.data_dir / "raw" / "hotspots.parquet").exists()


def test_fires_at_an_early_sp_horizon_are_too_recent_to_call_ended(tmp_path):
    """SP lags by months. If it stops on Jun 20, a fire last seen Jun 19 may
    have burned on into days SP has not processed: it is not archived as
    ended; one that went quiet well before the horizon is."""
    settings = _settings(tmp_path)
    early = _fire(*MADRID, U(2026, 6, 1, 1))
    at_horizon = _fire(*VALLADOLID, U(2026, 6, 18, 1), n=4)  # last Jun 19 13:00
    marker = [(*ZARAGOZA, U(2026, 6, 20, 13), 5.0)]          # SP's last processed day
    fake = FakeFirms({"VIIRS_SNPP_SP": early + at_horizon + marker})

    summary = bf.build(settings, tmp_path / "bf", tmp_path / "sp.parquet", {}, {}, http_get=fake)

    assert summary["cutoff"] == "2026-06-18T13:00:00Z"  # horizon minus 48 h
    assert summary["kept"] == 1 and summary["earliest_first"] == "2026-06-01"
    assert len(summary["skipped"]["too_recent"]) == 1


def test_build_drops_skipped_ids_from_the_output_it_would_publish(tmp_path):
    settings = _settings(tmp_path)
    # the Zaragoza fire stands in for SP's daily coverage up to the fetch end
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 2, 10, 1)) + _fire(*ZARAGOZA, U(2026, 7, 14, 1))})
    out = tmp_path / "bf"
    first = bf.build(settings, out, tmp_path / "sp.parquet", {}, {}, http_get=fake)
    (eid,) = json.loads((out / ARCHIVE_TRACKS_INDEX).read_text())

    summary = bf.build(settings, out, tmp_path / "sp.parquet", {eid: "live"}, {}, http_get=fake)

    assert first["kept"] == 1
    assert summary["skipped"]["live_id"] == [eid]
    assert json.loads((out / ARCHIVE_TRACKS_INDEX).read_text()) == {}
    assert not list((out / "archive" / "tracks").glob("*.json"))


def test_build_starts_from_an_empty_backfill_index(tmp_path):
    """A previous build's output never leaks into this one's: stale bodies
    and index entries would otherwise be published as if freshly built."""
    settings = _settings(tmp_path)
    out = tmp_path / "bf"
    _built(out, {"stale": '{"id": "stale"}'})
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*ZARAGOZA, U(2026, 7, 14, 1))})

    bf.build(settings, out, tmp_path / "sp.parquet", {}, {}, http_get=fake)

    assert json.loads((out / ARCHIVE_TRACKS_INDEX).read_text()) == {}
    assert not (out / "archive" / "tracks" / "stale.json").exists()


def _r2_env(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)  # no stray .env
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(k, "a")
    monkeypatch.setenv("R2_BUCKET", "bucket")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "d"))
    monkeypatch.setenv("OUT_DIR", str(tmp_path / "o"))


def test_main_build_reads_the_live_index_and_cells_from_r2_read_only(tmp_path, monkeypatch):
    _r2_env(monkeypatch, tmp_path)
    monkeypatch.setenv("FIRMS_MAP_KEY", KEY)
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 2, 10, 1)) + _fire(*ZARAGOZA, U(2026, 7, 14, 1))})
    c = h3.latlng_to_cell(*MADRID, H3_RES)
    s3 = PublishS3({
        INDEX_KEY: json.dumps({"live1": "a"}).encode(),
        "data/archive/season_2026_cells.json": json.dumps(
            {"live1": {"first": "2026-02-11", "cells": [c]}}).encode(),
    })

    rc = bf.main(["--preview-season"], client=s3, http_get=fake)

    assert rc == 0 and s3.ops == []  # nothing written to R2 in a build
    summary = json.loads((tmp_path / "d" / "backfill" / "out" / "summary.json").read_text())
    assert summary["live_index_ids"] == 1
    assert summary["kept"] == 0 and len(summary["skipped"]["overlap"]) == 1
    assert summary["preview"]["fires"] == 0


def test_preview_season_counts_the_kept_tracks(tmp_path):
    settings = _settings(tmp_path)
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 2, 10, 1)) + _fire(*ZARAGOZA, U(2026, 7, 14, 1))})
    summary = bf.build(settings, tmp_path / "bf", tmp_path / "sp.parquet", {}, {}, http_get=fake, preview=True)
    assert summary["kept"] == 1
    assert summary["preview"]["fires"] == 1 and summary["preview"]["floor"] == "2026-02-10"


# --- publish ----------------------------------------------------------------

class _NotFound(Exception):
    response = {"Error": {"Code": "404"}}


class PublishS3(FakeS3):
    """FakeS3 plus copy/head, with one op log across copy and put so the
    order between them is assertable. `on_copy` lets a test change the live
    index between the backup and the merge (a concurrent writer)."""

    def __init__(self, objects, on_copy=None):
        super().__init__(objects)
        self.ops: list[tuple[str, str]] = []
        self.on_copy = on_copy

    def copy_object(self, Bucket, Key, CopySource):
        self.ops.append(("copy", Key))
        self.objects[Key] = self.objects[CopySource["Key"]]
        if self.on_copy:
            self.on_copy(self)

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise _NotFound(Key)
        return {}

    def put_object(self, Bucket, Key, Body, **kw):
        self.ops.append(("put", Key))
        super().put_object(Bucket, Key, Body, **kw)


INDEX_KEY = "data/archive/tracks_index.json"


def _built(out, tracks: dict[str, str]):
    (out / "archive" / "tracks").mkdir(parents=True)
    index = {}
    for eid, body in tracks.items():
        (out / "archive" / "tracks" / f"{eid}.json").write_text(body)
        index[eid] = f"sha-{eid}"
    (out / ARCHIVE_TRACKS_INDEX).write_text(json.dumps(index))
    return index


def test_publish_backs_up_first_uploads_bodies_then_the_merged_index_last(tmp_path):
    out = tmp_path / "bf"
    _built(out, {"bf1": '{"id": "bf1"}', "bf2": '{"id": "bf2"}', "shared": '{"id": "shared"}'})
    live = {"live1": "a", "shared": "live-digest"}
    s3 = PublishS3({
        INDEX_KEY: json.dumps(live).encode(),
        "data/archive/tracks/bf2.json": b"old",
    }, on_copy=lambda s: s.objects.__setitem__(
        INDEX_KEY, json.dumps({**live, "live2": "b"}).encode()))

    result = bf.publish(s3, "bucket", out, now=U(2026, 9, 23, 10))

    backup = "data/archive/tracks_index.json.pre-backfill-20260923T100000Z"
    assert result["backup_key"] == backup
    assert s3.ops[0] == ("copy", backup)
    assert s3.ops[-1] == ("put", INDEX_KEY)
    assert set(s3.ops[1:-1]) == {("put", "data/archive/tracks/bf1.json"), ("put", "data/archive/tracks/shared.json")}
    assert json.loads(s3.objects[backup]) == live
    assert s3.objects["data/archive/tracks/bf2.json"] == b"old"  # existing body not overwritten
    merged = json.loads(s3.objects[INDEX_KEY])
    # re-read after the backup: live2 (written meanwhile) survives; live entries win
    assert merged == {"live1": "a", "live2": "b", "shared": "live-digest", "bf1": "sha-bf1", "bf2": "sha-bf2"}
    assert result["added"] == 2


def test_publish_refuses_without_a_live_index(tmp_path):
    out = tmp_path / "bf"
    _built(out, {"bf1": "{}"})
    s3 = PublishS3({})
    with pytest.raises(SystemExit):
        bf.publish(s3, "bucket", out, now=U(2026, 9, 23))
    assert s3.ops == []


def test_main_publish_refuses_a_build_with_failed_windows(tmp_path, monkeypatch):
    out = tmp_path / "bf"
    _built(out, {"bf1": "{}"})
    (out / "summary.json").write_text(json.dumps({"fetch": {"failed": [{"source": "x"}]}}))
    s3 = PublishS3({INDEX_KEY: b"{}"})
    _r2_env(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        bf.main(["--publish", "--out", str(out)], client=s3)
    assert s3.ops == []
