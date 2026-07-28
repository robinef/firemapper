import json

from pipeline.fetch_wind import fetch_wind, wind_sample_points

RESP = [
    {"latitude": 44.75, "longitude": -1.15,
     "current": {"time": "2026-07-24T11:45", "wind_speed_10m": 9.8,
                 "wind_direction_10m": 172, "wind_gusts_10m": 21.6,
                 "temperature_2m": 31.2, "relative_humidity_2m": 24}},
    {"latitude": 38.06, "longitude": 23.62,
     "current": {"time": "2026-07-24T11:45", "wind_speed_10m": 15.5,
                 "wind_direction_10m": 40, "wind_gusts_10m": 30.0,
                 "temperature_2m": 35.0, "relative_humidity_2m": 18}},
    {"latitude": 1.0, "longitude": 1.0, "current": {"wind_direction_10m": None}},
]


def test_fetch_wind_parses_batch():
    out = fetch_wind([(44.75, -1.15), (38.06, 23.62)], http_text=lambda u: json.dumps(RESP))
    assert len(out) == 2  # entry with no direction dropped
    assert out[0]["kmh"] == 9.8 and out[0]["dir"] == 172
    assert out[0]["temp_c"] == 31.2 and out[0]["rh"] == 24


def test_fetch_wind_survives_failure():
    def boom(url: str) -> str:
        raise RuntimeError("offline")

    assert fetch_wind([(1.0, 2.0)], http_text=boom) == []
    assert fetch_wind([]) == []


def test_sample_points_snap_to_grid_and_dedupe():
    pixels = [
        {"lat": 44.71, "lon": -1.11}, {"lat": 44.72, "lon": -1.12},  # same cell
        {"lat": 38.10, "lon": 23.60},
    ]
    pts = wind_sample_points(pixels)
    assert len(pts) == 2


def test_sample_points_caps_total():
    pixels = [{"lat": 34 + i * 0.6, "lon": -20 + i * 0.6} for i in range(400)]
    assert len(wind_sample_points(pixels, max_points=50)) == 50
