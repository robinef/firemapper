from datetime import datetime, timedelta, timezone

from pipeline.fetch_imagery import (
    BASELINE_LEAD_DAYS,
    MAX_SCARS,
    HD_PROXY_PATH,
    build_imagery,
    hd_config,
    build_scars,
)


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

    # HD is a flag, not a credential: the Sentinel Hub instance id lives in the
    # Worker, and the manifest only ever names the proxy path.
    hd = build_imagery(_Settings(sh_proxy=True), events, NOW)
    assert hd["hd"]["wms_base"] == HD_PROXY_PATH
    assert hd["hd"]["layer"] == "TRUE_COLOR"

    # Layer name overridable to match the user's configuration.
    custom = build_imagery(_Settings(sh_proxy=True, sh_layer="MY_TC"), events, NOW)
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


def test_past_scars_rank_by_size_so_a_big_fire_is_not_crowded_out():
    """A significant fire must survive a flurry of small fresh ones.

    Live on 2026-08-03 the past section held fifteen scars, all started within
    two days, and a large Bordeaux fire from the week before was nowhere in it:
    the cap was filled by recency, so the only way to reach that fire's card had
    silently disappeared. Size is the proxy for "worth comparing" — that is what
    the docstring always claimed this did.
    """
    events = {"big": _fire(-0.6, 44.8, 20, "Bordeaux", n=40, start_day=18)}
    for i in range(MAX_SCARS + 5):  # newer, but each tiny
        events[f"small{i}"] = _fire(10.0 + i, 40.0, 24, f"Small{i}", n=5, start_day=24)

    past = [s for s in build_scars(events, NOW) if s["kind"] == "past"]

    assert len(past) <= MAX_SCARS
    assert past[0]["place"] == "Bordeaux", "biggest past scar must rank first"
    assert any(s["place"] == "Bordeaux" for s in past), "big fire must not be crowded out"


def test_scars_carry_their_size():
    """The cell count is what the ranking sorts on, and what a fire list needs
    to show how big a burn was."""
    events = {"e1": _fire(-1.0, 44.8, 20, "Gironde", n=9, start_day=18)}
    assert build_scars(events, NOW)[0]["cells"] == 9


def test_equal_size_past_scars_fall_back_to_recency():
    events = {
        "older": _fire(-1.0, 44.8, 18, "Older", n=8, start_day=17),
        "newer": _fire(5.0, 44.8, 22, "Newer", n=8, start_day=21),
    }
    past = [s for s in build_scars(events, NOW) if s["kind"] == "past"]
    assert [s["place"] for s in past] == ["Newer", "Older"]


def test_hd_config_publishes_a_relative_proxy_base_not_the_instance_id():
    """The manifest must never carry the Sentinel Hub instance id.

    That id IS the bearer token for the whole configuration — GetCapabilities
    enumerates its layers, WCS returns raw raster, FIS returns statistics — and
    docs/DEPLOYMENT.md has always said never to expose it to a public deploy.
    The browser asks the Worker, which holds the id as a Worker secret."""
    cfg = hd_config(_Settings(sh_proxy=True, sh_layer="TRUE_COLOR"))
    assert cfg == {"wms_base": HD_PROXY_PATH, "layer": "TRUE_COLOR"}
    assert "copernicus" not in cfg["wms_base"]


def test_hd_config_off_without_the_flag():
    assert hd_config(_Settings(sh_proxy=False, sh_layer="TRUE_COLOR")) is None


def test_hd_config_needs_no_credential_in_the_pipeline_at_all():
    """The refresh job holds R2 write credentials. Not needing the Sentinel Hub
    secret there too is the point: it lives only in the Worker."""
    s = _Settings(sh_proxy=True)
    assert not hasattr(s, "sh_instance_id")
    assert hd_config(s) is not None
