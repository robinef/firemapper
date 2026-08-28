"""Pure helpers for the api2.effis.emergency.copernicus.eu stats source —
the season page's data, kept separate from fetch_effis_season.py (which
fetch_effis_ba also depends on for live-map scars, see fetch_effis_stats.py's
module docstring for why these must not share a snapshot).
"""
from pipeline.fetch_effis_stats import _fault, _latest_cumulative


def cumulative(*entries):
    return {"banfcumulative": [
        {"week": i + 1, "mddate": e.get("mddate", f"2026010{i + 1}"),
         "events": e.get("events"), "area_ha": e.get("area_ha")}
        for i, e in enumerate(entries)
    ]}


def test_latest_cumulative_picks_last_non_null_entry():
    payload = cumulative(
        {"mddate": "20260101", "events": 1, "area_ha": 10},
        {"mddate": "20260108", "events": 3, "area_ha": 40},
        {"mddate": "20260115", "events": None, "area_ha": None},  # future week
    )
    assert _latest_cumulative(payload) == {
        "week": 2, "mddate": "20260108", "events": 3, "area_ha": 40,
    }


def test_latest_cumulative_is_none_when_every_entry_is_null():
    payload = cumulative({"area_ha": None}, {"area_ha": None})
    assert _latest_cumulative(payload) is None


def test_latest_cumulative_is_none_when_list_is_empty():
    assert _latest_cumulative({"banfcumulative": []}) is None


def test_latest_cumulative_is_none_when_key_is_missing():
    assert _latest_cumulative({}) is None


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def test_fault_extracts_json_detail_from_response_body():
    exc = RuntimeError("500 Server Error")
    exc.response = FakeResponse(500, '{"detail": "database unavailable"}')
    assert _fault(exc) == "HTTP 500: database unavailable"


def test_fault_falls_back_to_raw_body_when_not_json():
    exc = RuntimeError("502 Bad Gateway")
    exc.response = FakeResponse(502, "<html>gateway timeout</html>")
    assert _fault(exc) == "HTTP 502: <html>gateway timeout</html>"


def test_fault_falls_back_to_exception_text_with_no_response():
    exc = RuntimeError("network down")
    assert _fault(exc) == "network down"


def test_fault_falls_back_to_exception_text_when_body_is_empty():
    exc = RuntimeError("timeout")
    exc.response = FakeResponse(504, "")
    assert _fault(exc) == "HTTP 504: timeout"
