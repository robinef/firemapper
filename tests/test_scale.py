import pytest
from pipeline.scale import UNITS, pick_unit


def test_europe_record_season_lands_on_greater_london():
    got = pick_unit(20000.0)
    assert got["name"] == "Greater London"
    assert got["km2"] == 1572.0
    assert got["count"] == 12.7


def test_typical_europe_season_lands_on_greater_london():
    got = pick_unit(10240.3)
    assert got["name"] == "Greater London"
    assert got["count"] == 6.5


def test_country_scale_lands_on_paris():
    got = pick_unit(1720.0)
    assert got["name"] == "Paris"
    assert got["count"] == 16.3


def test_small_country_lands_on_gibraltar():
    # 42 / 6.8 = 6.2 (in band) vs 42 / 105.4 = 0.4 (out) — Gibraltar wins here.
    got = pick_unit(42.0)
    assert got["name"] == "Gibraltar"
    assert got["count"] == 6.2


def test_below_the_ladder_falls_back_to_smallest():
    got = pick_unit(5.0)
    assert got["name"] == "Gibraltar"
    assert got["count"] == 0.7


def test_above_the_ladder_falls_back_to_largest():
    got = pick_unit(200000.0)
    assert got["name"] == "Greater London"
    assert got["count"] == 127.2


def test_the_known_gap_still_returns_a_usable_unit():
    # 306-316 km2 sits outside the band for both Gibraltar and Paris.
    got = pick_unit(310.0)
    assert got["name"] in {"Gibraltar", "Paris"}
    assert got["count"] > 0


def test_two_units_in_band_prefers_nearest_target():
    # 4720 / 105.4 = 44.8 (Paris, in band)
    # 4720 / 1572.0 = 3.0 (Greater London, in band)
    # Paris at 44.8 is closer to TARGET=12 than Greater London at 3.0
    got = pick_unit(4720.0)
    assert got["name"] == "Paris"
    assert got["count"] == 44.8


def test_band_lower_boundary_is_inclusive():
    # 4716.0 / 1572.0 = 3.0 (exactly at BAND_MIN)
    # Greater London at exactly 3.0 must be treated as in-band
    # Also, Paris at 4716/105.4=44.76 is in band and closer to TARGET=12
    got = pick_unit(4716.0)
    assert got["name"] == "Paris"
    assert got["count"] == 44.7


def test_band_upper_boundary_is_inclusive():
    # 306.0 / 6.8 = 45.0 (exactly at BAND_MAX)
    # Gibraltar must be treated as in-band
    got = pick_unit(306.0)
    assert got["name"] == "Gibraltar"
    assert got["count"] == 45.0


def test_zero_is_rejected():
    with pytest.raises(ValueError):
        pick_unit(0.0)


def test_negative_is_rejected():
    with pytest.raises(ValueError):
        pick_unit(-1.0)


def test_units_are_the_pinned_trio():
    assert UNITS == [("Gibraltar", 6.8), ("Paris", 105.4), ("Greater London", 1572.0)]
