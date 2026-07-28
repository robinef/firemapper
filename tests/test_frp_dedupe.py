from pipeline.export import dedupe_frp_points


def p(lon, lat, age, frp, t=None):
    return {"lon": lon, "lat": lat, "age_min": age, "frp": frp, "time": t, "conf": 90}


def test_collapses_repeat_observations_of_one_pixel():
    # MTG re-reports the same pixel every ~10 min.
    aged = [p(8.0, 45.0, 100, 20.0), p(8.0, 45.0, 40, 55.0), p(8.0, 45.0, 70, 33.0)]
    out = dedupe_frp_points(aged)
    assert len(out) == 1
    assert out[0]["age_min"] == 40      # freshest wins
    assert out[0]["first_min"] == 100   # oldest = when it first appeared
    assert out[0]["frp"] == 55.0        # peak intensity
    assert out[0]["n"] == 3             # observed 3 times


def test_keeps_distinct_locations_separate():
    aged = [p(8.0, 45.0, 10, 5.0), p(8.1, 45.0, 10, 5.0), p(8.0, 45.1, 10, 5.0)]
    assert len(dedupe_frp_points(aged)) == 3


def test_freshest_timestamp_travels_with_freshest_age():
    aged = [p(8.0, 45.0, 90, 1.0, "T-old"), p(8.0, 45.0, 12, 1.0, "T-new")]
    assert dedupe_frp_points(aged)[0]["time"] == "T-new"


def test_handles_missing_ages():
    aged = [p(8.0, 45.0, None, 4.0), p(8.0, 45.0, 30, 9.0)]
    out = dedupe_frp_points(aged)
    assert len(out) == 1 and out[0]["age_min"] == 30 and out[0]["n"] == 2
