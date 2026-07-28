from datetime import datetime, timedelta, timezone

from pipeline.fetch_imagery import BASELINE_LEAD_DAYS, build_imagery, build_scars


class _Settings:
    def __init__(self, **kw):
        self.__dict__.update(kw)


NOW = datetime(2026, 7, 27, tzinfo=timezone.utc)


def _fire(lon, lat, latest_day, name=None, n=6, start_day=None):
    """A fire with `n` members; latest detection on `latest_day`."""
    start = start_day or latest_day
    ms = [
        {"lon": lon + 0.001 * i, "lat": lat, "name": name,
         "acq_time": datetime(2026, 7, start, tzinfo=timezone.utc)}
        for i in range(n - 1)
    ]
    ms.append({"lon": lon, "lat": lat, "name": name,
               "acq_time": datetime(2026, 7, latest_day, tzinfo=timezone.utc)})
    return ms


def test_recent_fire_is_active_with_latest_after():
    events = {"e1": _fire(-1.0, 44.8, 27, "Gironde", start_day=24)}  # latest today
    scars = build_scars(events, NOW)
    assert len(scars) == 1
    s = scars[0]
    assert s["kind"] == "active"
    assert s["place"] == "Gironde" and s["label"] == "Gironde · 24 Jul 2026"
    assert s["before"] == "2026-07-18"  # start 07-24 - 6
    assert s["after"] == "2026-07-26"  # yesterday


def test_scar_without_place_gets_generic_dated_label():
    # No stored name, no places list → generic label still carries the date.
    events = {"e1": _fire(2.0, 45.0, 5, start_day=3)}
    s = build_scars(events, NOW)[0]
    assert s["place"] is None
    assert s["label"] == "Burn scar · 3 Jul 2026"


def test_quiet_fire_becomes_a_past_scar():
    # Latest detection 07-10 (>48 h before 07-27) → past, settled-scar after.
    events = {"e1": _fire(-3.5, 40.1, 10, start_day=8)}
    scars = build_scars(events, NOW)
    assert scars[0]["kind"] == "past"
    assert scars[0]["before"] == "2026-07-02"  # start 07-08 - 6
    assert scars[0]["after"] == "2026-07-22"  # start 07-08 + 14 settle


def test_specks_below_min_members_skipped():
    tiny = {"t": _fire(1.0, 45.0, 27, n=2)}
    assert build_scars(tiny, NOW) == []


def test_active_listed_before_past():
    events = {
        "a": _fire(-1.0, 44.8, 27, start_day=25),  # active
        "p": _fire(2.0, 45.0, 5, start_day=3),      # past
    }
    kinds = [s["kind"] for s in build_scars(events, NOW)]
    assert kinds == ["active", "past"]


def test_build_imagery_keyless_default_and_gated_hd():
    events = {"e1": _fire(-1.0, 44.8, 27, start_day=24)}
    cfg = build_imagery(_Settings(), events, NOW)
    assert cfg["source"] == "gibs" and cfg["hd"] is None
    assert cfg["scars"] and "MODIS" in cfg["gibs_layer"]

    # Only the instance id is required for HD (the id is the WMS access token).
    hd = build_imagery(_Settings(sh_instance_id="INST"), events, NOW)
    assert hd["hd"]["wms_base"].endswith("/INST")
    assert hd["hd"]["layer"] == "TRUE-COLOR-S2L2A"

    # Layer name overridable to match the user's configuration.
    custom = build_imagery(_Settings(sh_instance_id="INST", sh_layer="MY_TC"), events, NOW)
    assert custom["hd"]["layer"] == "MY_TC"


def test_build_imagery_always_has_notable_scars():
    # Even with no live fires, the curated real megafires are present so the
    # before/after mode always has a green→black example.
    cfg = build_imagery(_Settings(), {}, NOW)
    ids = {s["id"] for s in cfg["scars"]}
    assert {"landiras-2022", "la-teste-2022", "evros-2023", "rhodes-2023"} <= ids
    assert all(s["kind"] == "past" for s in cfg["scars"])


def test_baseline_lead_reasonable():
    assert 3 <= BASELINE_LEAD_DAYS <= 14
