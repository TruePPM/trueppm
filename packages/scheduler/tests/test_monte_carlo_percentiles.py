"""``MonteCarloResult.percentiles`` is the storage; ``p50/p80/p95`` derive from it (#4514)."""

from __future__ import annotations

import dataclasses
from datetime import date, timedelta

import numpy as np
import pytest

from trueppm_scheduler import MonteCarloResult, Percentile

D1, D2, D3 = date(2026, 3, 2), date(2026, 3, 9), date(2026, 3, 16)


def test_percentiles_hold_the_levels_and_properties_derive_from_them() -> None:
    mc = MonteCarloResult(
        project_id="p",
        runs=3,
        percentiles={
            50: Percentile(D1, True),
            80: Percentile(D2),
            95: Percentile(D3, True),
        },
    )
    assert (mc.p50, mc.p80, mc.p95) == (D1, D2, D3)
    assert (mc.p50_at_day_start, mc.p80_at_day_start, mc.p95_at_day_start) == (
        True,
        False,
        True,
    )
    assert mc.distribution == [] and mc.sensitivity == []


def test_legacy_keyword_and_positional_construction_still_work() -> None:
    kw = MonteCarloResult(project_id="p", runs=3, p50=D1, p80=D2, p95=D3, p80_at_day_start=True)
    pos = MonteCarloResult("p", 3, D1, D2, D3, [D1], [], False, True, False)
    assert kw.percentiles == {
        50: Percentile(D1, False),
        80: Percentile(D2, True),
        95: Percentile(D3, False),
    }
    assert pos.percentiles == kw.percentiles
    assert pos.distribution == [D1]


def test_mixing_or_omitting_forms_is_rejected() -> None:
    with pytest.raises(TypeError):
        MonteCarloResult("p", 1, p50=D1, percentiles={50: Percentile(D1)})
    with pytest.raises(TypeError):
        MonteCarloResult("p", 1, p80_at_day_start=True, percentiles={50: Percentile(D1)})
    with pytest.raises(TypeError):
        MonteCarloResult("p", 1, p50=D1)


def test_percentiles_missing_a_required_level_is_rejected() -> None:
    with pytest.raises(TypeError, match=r"missing \[50, 80, 95\]"):
        MonteCarloResult("p", 1, percentiles={})
    with pytest.raises(TypeError, match=r"missing \[80\]"):
        MonteCarloResult("p", 1, percentiles={50: Percentile(D1), 95: Percentile(D3)})


def test_derived_properties_are_read_only() -> None:
    mc = MonteCarloResult("p", 1, D1, D2, D3)
    with pytest.raises(AttributeError):
        mc.p50 = D2  # type: ignore[misc]
    with pytest.raises(AttributeError):
        mc.p80_at_day_start = True  # type: ignore[misc]
    mc.percentiles[50] = Percentile(D2, True)  # the replacement idiom
    assert (mc.p50, mc.p50_at_day_start) == (D2, True)


def test_extra_level_round_trips_but_to_dict_ignores_it() -> None:
    levels = {
        50: Percentile(D1),
        80: Percentile(D2),
        90: Percentile(D2, True),
        95: Percentile(D3),
    }
    mc = MonteCarloResult("p", 1, percentiles=levels)
    assert mc.percentiles[90] == Percentile(D2, True)
    out = mc.to_dict()
    assert "p90" not in out and "p90_at_day_start" not in out
    assert out["p80"] == D2.isoformat() and out["p95"] == D3.isoformat()


def test_replace_with_derived_names_and_value_semantics() -> None:
    mc = MonteCarloResult("p", 1, D1, D2, D3)
    with pytest.raises(TypeError):
        dataclasses.replace(mc, p50=D2)  # type: ignore[call-arg]
    assert dataclasses.replace(mc, runs=2).p50 == D1
    assert "percentiles=" in repr(mc)
    assert mc == MonteCarloResult("p", 1, percentiles=dict(mc.percentiles))
    assert mc != MonteCarloResult("p", 1, D2, D2, D3)


def test_percentile_is_frozen() -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        Percentile(D1).at_day_start = True  # type: ignore[misc]


def test_to_dict_shape_is_unchanged() -> None:
    mc = MonteCarloResult("p", 2, D1, D2, D3, [D1, D2], [], p50_at_day_start=True)
    assert mc.to_dict() == {
        "project_id": "p",
        "runs": 2,
        "p50": "2026-03-02",
        "p80": "2026-03-09",
        "p95": "2026-03-16",
        "p50_at_day_start": True,
        "p80_at_day_start": False,
        "p95_at_day_start": False,
        "distribution": ["2026-03-02", "2026-03-09"],
        "sensitivity": [],
        # Appended by #2469: every earlier key keeps its value and its position.
        "velocity_saturated_runs": 0,
        "velocity_fallback_reasons": [],
    }
    assert list(mc.to_dict()) == [
        "project_id", "runs", "p50", "p80", "p95", "p50_at_day_start",
        "p80_at_day_start", "p95_at_day_start", "distribution", "sensitivity",
        "velocity_saturated_runs",
        "velocity_fallback_reasons",
    ]  # fmt: skip


# --- Precision at low run counts and the midpoint tie (#4540) ---------------------

_WD = [date(2026, 3, 2) + timedelta(days=i) for i in range(40)]


def _readings(offsets: list[float]) -> list[tuple[date, bool]]:
    from trueppm_scheduler.engine import _mc_percentiles

    arr = np.asarray(offsets, dtype=np.float64)
    return _mc_percentiles(arr, arr, _WD, None, False)


def _share_on_or_before(offsets: list[float], reading: date) -> float:
    from trueppm_scheduler.engine.montecarlo.run import _offset_to_date

    return sum(_offset_to_date(float(o), _WD, None) <= reading for o in offsets) / len(offsets)


def test_ten_runs_p95_can_cover_only_ninety_percent() -> None:
    """The documented low-N imprecision, pinned: a P95 between two far-apart runs."""
    offsets = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20]  # linear P95 position 15.05: no run there
    p95 = _readings(offsets)[2][0]
    assert _share_on_or_before(offsets, p95) == 0.9


@pytest.mark.parametrize("n", [10, 11, 20, 22, 37, 100])
@pytest.mark.parametrize("q_index, q", [(0, 50), (1, 80), (2, 95)])
def test_coverage_is_above_the_documented_bound(n: int, q_index: int, q: int) -> None:
    """With n runs a Pq reading has more than q*(1 - 1/n) percent of runs on or before it."""
    rng = np.random.default_rng(n * 100 + q)
    for _ in range(25):
        # Sparse, widely spaced whole-day positions make "no run at k" common.
        offsets = sorted(float(x) for x in rng.integers(1, 39, size=n))
        reading = _readings(offsets)[q_index][0]
        assert _share_on_or_before(offsets, reading) > (q / 100) * (1 - 1 / n)


def test_an_exact_midpoint_reads_the_later_day_not_half_to_even() -> None:
    """Two runs: P50 is their midpoint, and it goes up, whichever day is even."""
    for lo in (4.0, 5.0):
        p50 = _readings([lo, lo + 1])[0][0]
        assert p50 == _readings([lo + 1, lo + 1])[0][0]
