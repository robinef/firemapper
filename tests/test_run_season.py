"""The season snapshot's place in a pipeline run.

Three things here are load-bearing and none is visible from reading the
season modules alone:

1. ORDER. `fetch_effis_ba` no longer talks to the network — it reads the
   snapshot `fetch_season_snapshot` writes. Fetch second and a cold start
   publishes a map with no burn scars for a whole run, silently. This is
   about the live map's scars, unrelated to season_status below.
2. INDEPENDENCE. `/scale`'s season totals come from `fetch_stats_snapshot`
   (fetch_effis_stats.py, a different EFFIS backend), fetched separately from
   the scars snapshot above with no ordering dependency on it.
3. The `pick_unit` GUARD. `pick_unit` raises on a non-positive total by
   design, and a country's km2 rounds independently of the season total. An
   empty fire season must not become a crashed pipeline run.
"""
import pytest

from pipeline import run
from pipeline.config import load_settings
from tests.synth import T

NOW = T(20, 12)


def a_season(**overrides) -> dict:
    """A fresh season_totals()-shaped dict, nested dicts included.

    A factory, not a constant: run.py attaches units by MUTATING this structure
    in place, so a shared literal would leak a unit from one test into the next
    — which is how the zero-total case first passed for the wrong reason.

    Values chosen so the real pick_unit lands in-band at both levels:
    10240.3/1572 = 6.5 (Greater London), 2940.1/105.4 = 27.9 (Paris).
    """
    base = {
        "season_year": 2026, "total_km2": 10240.3, "event_count": 1184,
        "countries": [
            {"name": "Spain", "km2": 2940.1, "events": 402},
            {"name": "Portugal", "km2": 812.4, "events": 118},
        ],
    }
    base.update(overrides)
    return base


def _settings(tmp_path):
    return load_settings(env={
        "DATA_DIR": str(tmp_path / "d"), "OUT_DIR": str(tmp_path / "o"),
    })


@pytest.fixture
def captured(monkeypatch, tmp_path):
    """Run process() with every network layer stubbed, returning the kwargs
    export was called with. export itself is faked: this file is about what
    run.py computes and hands over, not about what export writes."""
    seen: dict = {}

    monkeypatch.setattr(run, "fetch_gdacs", lambda *a, **k: [])
    monkeypatch.setattr(run, "mtg_frp_extent", lambda *a, **k: None)
    monkeypatch.setattr(run, "fetch_frp_points", lambda *a, **k: [])
    monkeypatch.setattr(run, "fetch_wind", lambda *a, **k: [])
    monkeypatch.setattr(run, "build_imagery", lambda *a, **k: None)
    monkeypatch.setattr(run, "fetch_effis_ba", lambda *a, **k: [])
    # Defaulted here, not per test: under a fresh tmp_path there is no snapshot,
    # so should_fetch() says yes and the real EFFIS request fires. A test that
    # forgets to stub one of these would silently go to the network. Tests
    # that care about a status override it afterwards.
    monkeypatch.setattr(run, "fetch_season_snapshot", lambda *a, **k: "fresh")
    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "fresh")

    def fake_export(*args, **kwargs):
        seen.update(kwargs)
        return tmp_path / "gen-x"

    monkeypatch.setattr(run, "export", fake_export)

    settings = _settings(tmp_path)

    def go(now=NOW):
        run.process(settings, now=now)
        return seen

    go.settings = settings
    return go


def test_the_snapshot_is_fetched_before_the_scars_are_read(monkeypatch, captured):
    """fetch_effis_ba reads the file fetch_season_snapshot writes. Backwards,
    and a cold start loses every burn scar for one full run."""
    order: list[str] = []
    monkeypatch.setattr(
        run, "fetch_season_snapshot",
        lambda *a, **k: (order.append("scars-fetch"), "fresh")[1],
    )
    monkeypatch.setattr(
        run, "fetch_effis_ba", lambda *a, **k: (order.append("effis-ba"), [])[1],
    )

    captured()

    assert order == ["scars-fetch", "effis-ba"]


def test_the_stats_snapshot_is_fetched_for_the_run_s_own_clock(monkeypatch, captured):
    """The rate-limit gate compares against `now`; a replayed run must ask for
    its own window, not wall-clock time."""
    seen: dict = {}
    monkeypatch.setattr(
        run, "fetch_stats_snapshot",
        lambda settings, now, **k: (seen.update(now=now), "fresh")[1],
    )

    captured(now=T(19, 3))

    assert seen["now"] == T(19, 3)
    assert seen["now"].tzinfo is not None


def test_a_raising_stats_fetch_does_not_stop_the_run(monkeypatch, captured):
    """fetch_stats_snapshot is documented as non-raising, but a bad EFFIS week
    must never stop us publishing live fire data even if that contract breaks."""
    def boom(*a, **k):
        raise RuntimeError("EFFIS exploded")

    monkeypatch.setattr(run, "fetch_stats_snapshot", boom)

    seen = captured()

    assert seen["season_status"] == "stale"


def test_a_raising_stats_fetch_does_not_touch_the_scars_snapshot(monkeypatch, captured):
    """The season stats fetch and the scars snapshot are independent — a bad
    season-stats week must not take the live map's scars down with it."""
    def boom(*a, **k):
        raise RuntimeError("EFFIS exploded")

    monkeypatch.setattr(run, "fetch_stats_snapshot", boom)
    scars_calls: list = []
    monkeypatch.setattr(
        run, "fetch_season_snapshot",
        lambda *a, **k: (scars_calls.append(1), "fresh")[1],
    )

    captured()

    assert scars_calls == [1]


def test_the_stats_fetch_status_travels_to_export(monkeypatch, captured):
    """"reused" (rate-limited skip) is not "fresh" — the page's "as of" line
    depends on the difference, so run.py must not flatten it."""
    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "reused")

    seen = captured()

    assert seen["season_status"] == "reused"


def test_the_totals_are_read_from_the_snapshot_the_stats_fetch_writes(monkeypatch, captured):
    """Reading anywhere else would aggregate a file nothing refreshes."""
    from pipeline.fetch_effis_stats import snapshot_path

    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "fresh")
    asked: dict = {}

    def fake_totals(path, year, *a, **k):
        asked.update(path=path, year=year)
        return a_season()

    monkeypatch.setattr(run, "season_totals", fake_totals)

    captured()

    assert asked["path"] == snapshot_path(captured.settings)
    assert asked["year"] == NOW.year


def test_the_total_and_every_country_get_a_scale_unit(monkeypatch, captured):
    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "fresh")
    monkeypatch.setattr(run, "season_totals", lambda *a, **k: a_season())

    season = captured()["season"]

    assert season["unit"]["name"] == "Greater London"
    assert season["unit"]["count"] == 6.5
    assert [c["unit"]["name"] for c in season["countries"]] == ["Paris", "Paris"]


def test_a_zero_season_gets_no_unit_and_does_not_crash(monkeypatch, capsys, captured):
    """pick_unit raises on a non-positive total by design — zero is a separate
    page state, not a grid of no tiles.

    The stderr assertion is what makes this test bite. Without it, deleting the
    guard still passes: pick_unit would raise, _safe would swallow it, and the
    unit would be absent for that reason instead of by decision. Asserting
    nothing was swallowed distinguishes "we declined to pick a unit" from
    "we crashed picking one and someone caught it".
    """
    monkeypatch.setattr(run, "season_totals", lambda *a, **k: a_season(
        total_km2=0.0, event_count=0, countries=[],
    ))

    season = captured()["season"]

    assert season["total_km2"] == 0.0
    assert season.get("unit") is None
    assert "season-units failed" not in capsys.readouterr().err


def test_a_country_rounding_to_zero_does_not_crash_the_run(monkeypatch, capsys, captured):
    """season_totals rounds each country independently of the total, so a 4 ha
    perimeter becomes 0.0 km2 while the season total is healthy.

    The zero country is deliberately FIRST. Ordered last, this test passes with
    the guard deleted — the total and Spain would already have their units
    before pick_unit raised and _safe swallowed it, leaving every assertion
    true. First, an unguarded call aborts the loop and Spain silently loses its
    unit, which is what the assertions below catch.
    """
    monkeypatch.setattr(run, "season_totals", lambda *a, **k: a_season(countries=[
        {"name": "Malta", "km2": 0.0, "events": 1},
        {"name": "Spain", "km2": 2940.1, "events": 402},
    ]))

    season = captured()["season"]

    assert season["unit"]["name"] == "Greater London"
    by_name = {c["name"]: c for c in season["countries"]}
    assert by_name["Malta"].get("unit") is None
    assert by_name["Spain"]["unit"]["name"] == "Paris", "the loop must not abort"
    assert "season-units failed" not in capsys.readouterr().err


def test_no_snapshot_yields_a_null_season(monkeypatch, captured):
    """season_totals returns None when no snapshot exists at all — a different
    thing from a total of zero, and export renders it differently."""
    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "stale")
    monkeypatch.setattr(run, "season_totals", lambda *a, **k: None)

    seen = captured()

    assert seen["season"] is None
    assert seen["season_status"] == "stale"


def test_a_raising_season_totals_does_not_stop_the_run(monkeypatch, captured):
    """An unreadable snapshot degrades the season panel, not the whole map."""
    def boom(*a, **k):
        raise RuntimeError("json is a picture of a duck")

    monkeypatch.setattr(run, "fetch_stats_snapshot", lambda *a, **k: "fresh")
    monkeypatch.setattr(run, "season_totals", boom)

    seen = captured()

    assert seen["season"] is None
