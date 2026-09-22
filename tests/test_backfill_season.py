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


def test_an_archived_fire_that_rekindles_and_is_still_burning_at_the_last_step_is_too_recent(tmp_path):
    """Review repro: a 37-cell fire quiet from Jul 4 is archived at the Jul 8
    step, then rekindles two rings off its edge Jul 10-15 (bridged: same id).
    Still burning at the last step, its body is never rewritten — but the
    guard must see the Jul 15 detection, not the stale Jul 4 one."""
    center = h3.latlng_to_cell(*MADRID, H3_RES)
    t0 = U(2026, 7, 4, 12)
    dets = [(*h3.cell_to_latlng(c), t0, 20.0) for c in sorted(h3.grid_disk(center, 3))]
    lat, lon = h3.cell_to_latlng(sorted(h3.grid_ring(center, 5))[0])
    dets += _fire(lat, lon, U(2026, 7, 10, 0), n=11)  # every 12 h, Jul 10 .. Jul 15 00:00
    index, meta, _ = bf.backfill_tracks(_rows(dets), [U(2026, 7, 8), U(2026, 7, 16)], tmp_path)

    assert len(index) == 1
    (eid,) = index
    assert meta[eid]["last"] == U(2026, 7, 15)
    kept, skipped = bf.guard(index, meta, {}, {}, cutoff=U(2026, 7, 13))
    assert kept == {} and skipped["too_recent"] == [eid]


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
    assert summary["overlap_checked"] is True and summary["live_cells_fires"] == 1
    assert summary["kept"] == 0 and len(summary["skipped"]["overlap"]) == 1
    assert summary["preview"]["fires"] == 0


@pytest.mark.parametrize("flaky", [False, True], ids=["missing", "read-error"])
def test_main_build_fails_when_the_live_cells_file_cannot_be_read(tmp_path, monkeypatch, flaky):
    """Without the cells file the overlap guard checks nothing, and every
    SP/NRT duplicate would be published: a build that could not read it must
    not look like a good one."""
    _r2_env(monkeypatch, tmp_path)
    monkeypatch.setenv("FIRMS_MAP_KEY", KEY)
    fake = FakeFirms({"VIIRS_SNPP_SP": _fire(*MADRID, U(2026, 2, 10, 1)) + _fire(*ZARAGOZA, U(2026, 7, 14, 1))})
    s3 = (_FlakyCells if flaky else PublishS3)({INDEX_KEY: json.dumps({"live1": "a"}).encode()})
    if flaky:
        s3.objects["data/archive/season_2026_cells.json"] = b"{}"

    rc = bf.main([], client=s3, http_get=fake)

    assert rc != 0
    summary = json.loads((tmp_path / "d" / "backfill" / "out" / "summary.json").read_text())
    assert summary["overlap_checked"] is False and summary["live_cells_fires"] == 0


def _publishable_build(out, **summary):
    _built(out, {"bf1": "{}"})
    base = {"fetch": {"failed": []}, "overlap_checked": True, "live_cells_fires": 5}
    (out / "summary.json").write_text(json.dumps({**base, **summary}))


@pytest.mark.parametrize("summary", [
    {"overlap_checked": False},
    {"live_cells_fires": 0},
    {"overlap_checked": None},
], ids=["unchecked", "no-live-fires", "missing"])
def test_main_publish_refuses_a_build_whose_overlap_check_did_not_run(tmp_path, monkeypatch, summary):
    out = tmp_path / "bf"
    _publishable_build(out, **summary)
    if summary.get("overlap_checked", True) is None:
        s = json.loads((out / "summary.json").read_text())
        del s["overlap_checked"]
        (out / "summary.json").write_text(json.dumps(s))
    s3 = PublishS3({INDEX_KEY: b"{}"})
    _r2_env(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        bf.main(["--publish", "--out", str(out)], client=s3)
    assert s3.ops == []


def test_main_publishes_a_complete_build(tmp_path, monkeypatch):
    out = tmp_path / "bf"
    _publishable_build(out)
    s3 = PublishS3({INDEX_KEY: b"{}"})
    _r2_env(monkeypatch, tmp_path)
    assert bf.main(["--publish", "--out", str(out)], client=s3) == 0
    assert json.loads(s3.objects[INDEX_KEY]) == {"bf1": "sha-bf1"}


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

    def delete_object(self, Bucket, Key):
        self.ops.append(("delete", Key))
        super().delete_object(Bucket, Key)


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
    # `shared` is live's already: live wins for its body too, not only its entry
    assert set(s3.ops[1:-1]) == {("put", "data/archive/tracks/bf1.json")}
    assert "data/archive/tracks/shared.json" not in s3.objects
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


class _FlakyCells(PublishS3):
    def get_object(self, Bucket, Key):
        if Key == "data/archive/season_2026_cells.json":
            raise RuntimeError("R2 503")
        return super().get_object(Bucket, Key)


# --- rollback ---------------------------------------------------------------

STAMP = "20261001T080000Z"
SEASON_STATE = "data/archive/season_state.json"
SEASON_CELLS = "data/archive/season_2026_cells.json"
SEASON_SIZES = "data/archive/season_2026_sizes.json"
SCALE_STATE = "data/archive/scale_blob_state.json"
SCALE_BLOB = "data/archive/blob_2026.json"
SCALE_FIRES = "data/archive/blob_2026_fires.json"


def _j(obj) -> bytes:
    return json.dumps(obj).encode()


def _ingested_bucket(scale_has_backfill=True):
    """The bucket after publish + a few refreshes: the backfill ids bfA, bfB
    are in the index and have been taken into the season and scale files; a
    live refresh added liveNew after the publish."""
    scale_ids = ["live1", "bfA"] if scale_has_backfill else ["live1"]
    return {
        INDEX_KEY: _j({"live1": "a", "bfA": "x", "bfB": "y", "liveNew": "n"}),
        f"{INDEX_KEY}.pre-backfill-20260923T100000Z": _j({"live1": "a"}),
        f"{INDEX_KEY}.pre-backfill-20260924T100000Z": _j({"live1": "a", "bfA": "x"}),
        SEASON_STATE: _j({"live1": {"digest": "a", "year": 2026}, "bfA": {"digest": "x", "year": 2026},
                          "__zone__": {"cells": [], "computed_at": "t"}}),
        SEASON_CELLS: _j({"live1": {"digest": "a", "first": "2026-07-20", "cells": []},
                          "bfA": {"digest": "x", "first": "2026-02-10", "cells": []}}),
        SEASON_SIZES: _j({"year": 2026, "fires": {"live1": [1.0, "ES", "2026-07-20"], "bfA": [2.0, "ES", "2026-02-10"]}}),
        SCALE_STATE: _j({i: {"digest": "d", "year": 2026} for i in scale_ids}),
        SCALE_BLOB: _j([{"fire_id": i, "index": n} for n, i in enumerate(scale_ids)]),
        SCALE_FIRES: _j({i: {"country": "ES", "area_km2": 1.0} for i in scale_ids}),
    }


def test_rollback_removes_exactly_the_backfill_ids_from_every_file_after_backing_each_up(tmp_path):
    objects = _ingested_bucket()
    before = dict(objects)
    s3 = PublishS3(objects)
    # live1 is listed too: it predates the publish (earliest backup), so it stays
    plan = bf.rollback(s3, "bucket", {"bfA", "bfB", "live1"}, now=datetime(2026, 10, 1, 8, tzinfo=timezone.utc))

    assert json.loads(s3.objects[INDEX_KEY]) == {"live1": "a", "liveNew": "n"}
    assert set(json.loads(s3.objects[SEASON_STATE])) == {"live1", "__zone__"}
    assert set(json.loads(s3.objects[SEASON_CELLS])) == {"live1"}
    assert json.loads(s3.objects[SEASON_SIZES]) == {"year": 2026, "fires": {"live1": [1.0, "ES", "2026-07-20"]}}
    for key in (SCALE_STATE, SCALE_BLOB, SCALE_FIRES):  # cold rebuild: packed spiral can't lose a fire
        assert key not in s3.objects
    written = [INDEX_KEY, SEASON_STATE, SEASON_CELLS, SEASON_SIZES, SCALE_STATE, SCALE_BLOB, SCALE_FIRES]
    for key in written:
        assert s3.objects[f"{key}.pre-rollback-{STAMP}"] == before[key]
    kinds = [k for k, _ in s3.ops]
    assert kinds[:len(written)] == ["copy"] * len(written)  # every backup before any change
    assert s3.ops[len(written)] == ("put", INDEX_KEY)       # the index goes first
    assert plan["ids"] == ["bfA", "bfB"]


def test_rollback_dry_run_writes_nothing(tmp_path):
    s3 = PublishS3(_ingested_bucket())
    plan = bf.rollback(s3, "bucket", {"bfA", "bfB"}, now=datetime(2026, 10, 1, 8, tzinfo=timezone.utc), dry_run=True)
    assert s3.ops == []
    assert plan["removed"][INDEX_KEY] == 2 and plan["delete"] == [SCALE_STATE, SCALE_BLOB, SCALE_FIRES]


def test_rollback_leaves_the_scale_blob_alone_when_it_never_took_a_backfill_fire(tmp_path):
    s3 = PublishS3(_ingested_bucket(scale_has_backfill=False))
    bf.rollback(s3, "bucket", {"bfA", "bfB"}, now=datetime(2026, 10, 1, 8, tzinfo=timezone.utc))
    assert all(key in s3.objects for key in (SCALE_STATE, SCALE_BLOB, SCALE_FIRES))
    assert not any(k == "delete" for k, _ in s3.ops)


def test_rollback_refuses_without_a_pre_backfill_backup(tmp_path):
    objects = {k: v for k, v in _ingested_bucket().items() if ".pre-backfill-" not in k}
    s3 = PublishS3(objects)
    with pytest.raises(SystemExit):
        bf.rollback(s3, "bucket", {"bfA"}, now=datetime(2026, 10, 1, 8, tzinfo=timezone.utc))
    assert s3.ops == []


def test_rollback_ids_come_from_an_artifact_dir_or_an_ids_file(tmp_path):
    out = tmp_path / "bf"
    _built(out, {"bfA": "{}", "bfB": "{}"})
    assert bf.load_rollback_ids(out) == {"bfA", "bfB"}
    ids_file = tmp_path / "ids.json"
    ids_file.write_text(json.dumps(["bfA"]))
    assert bf.load_rollback_ids(ids_file) == {"bfA"}


def test_main_rollback_and_publish_are_mutually_exclusive(tmp_path, monkeypatch):
    out = tmp_path / "bf"
    _publishable_build(out)
    s3 = PublishS3(_ingested_bucket())
    _r2_env(monkeypatch, tmp_path)
    with pytest.raises(SystemExit):
        bf.main(["--publish", "--rollback", str(out), "--out", str(out)], client=s3)
    assert s3.ops == []


def test_main_rollback_dry_run(tmp_path, monkeypatch):
    out = tmp_path / "bf"
    _built(out, {"bfA": "{}", "bfB": "{}"})
    s3 = PublishS3(_ingested_bucket())
    _r2_env(monkeypatch, tmp_path)
    assert bf.main(["--rollback", str(out), "--dry-run"], client=s3) == 0
    assert s3.ops == []


def test_rollback_aborts_on_a_read_error_rather_than_skipping_the_file(tmp_path):
    """A transient R2 error on the season state must not read as "no such
    file" — that would leave the backfill in the season layer for good."""
    class Flaky(PublishS3):
        def get_object(self, Bucket, Key):
            if Key == SEASON_STATE:
                raise RuntimeError("R2 503")
            return super().get_object(Bucket, Key)

    s3 = Flaky(_ingested_bucket())
    with pytest.raises(RuntimeError):
        bf.rollback(s3, "bucket", {"bfA"}, now=datetime(2026, 10, 1, 8, tzinfo=timezone.utc))
    assert s3.ops == []
