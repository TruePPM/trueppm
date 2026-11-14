"""``monte_carlo(deadline=...)`` stops an overrunning simulation (#4496).

The size caps bound cost only indirectly. A deadline bounds wall time directly, for
overruns the cell count does not capture, so an embedder on a request path can
answer with a documented error instead of letting the worker time out.
"""

from __future__ import annotations

import time
from datetime import date, timedelta

import pytest

from trueppm_scheduler import (
    InvalidScheduleInput,
    Project,
    SimulationCapExceeded,
    SimulationTimeExceeded,
    Task,
    monte_carlo,
)
from trueppm_scheduler.engine.montecarlo import run as mc_run


def _project(n: int = 5) -> Project:
    return Project(
        id="p",
        name="P",
        start_date=date(2026, 3, 2),
        tasks=[
            Task(
                id=f"t{i}",
                name=f"T{i}",
                duration=timedelta(days=3),
                optimistic_duration=timedelta(days=2),
                most_likely_duration=timedelta(days=3),
                pessimistic_duration=timedelta(days=8),
            )
            for i in range(n)
        ],
    )


def test_time_exceeded_is_a_cap_exceeded() -> None:
    """Handlers written for the size caps keep catching the new refusal."""
    assert issubclass(SimulationTimeExceeded, SimulationCapExceeded)


def test_a_generous_deadline_changes_nothing() -> None:
    project = _project()
    without = monte_carlo(project, runs=200, seed=7).to_dict()
    with_deadline = monte_carlo(
        project, runs=200, seed=7, deadline=time.monotonic() + 3600
    ).to_dict()
    assert with_deadline == without


def test_a_deadline_already_passed_raises_before_sampling(monkeypatch: pytest.MonkeyPatch) -> None:
    def _never(*_a: object, **_k: object) -> None:
        raise AssertionError("sampled past an expired deadline")

    monkeypatch.setattr(mc_run, "_sample_duration_matrix", _never)
    with pytest.raises(SimulationTimeExceeded, match="time budget"):
        monte_carlo(_project(), runs=100, deadline=time.monotonic() - 1)


def test_a_slow_sampler_overruns_and_stops_before_the_forward_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A synthetic slow phase: the clock jumps past the deadline during sampling."""
    real_sample = mc_run._sample_duration_matrix
    clock = [1000.0]
    monkeypatch.setattr(mc_run.time, "monotonic", lambda: clock[0])

    def _slow_sample(*args: object, **kwargs: object) -> object:
        out = real_sample(*args, **kwargs)  # type: ignore[arg-type]
        clock[0] += 60.0  # the sampler took a minute
        return out

    def _no_forward(*_a: object, **_k: object) -> None:
        raise AssertionError("ran the forward pass past the deadline")

    monkeypatch.setattr(mc_run, "_sample_duration_matrix", _slow_sample)
    monkeypatch.setattr(mc_run, "_mc_forward_pass", _no_forward)
    with pytest.raises(SimulationTimeExceeded):
        monte_carlo(_project(), runs=100, seed=1, deadline=1030.0)


def test_the_deadline_is_checked_between_forward_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    """With one-run chunks, a clock that passes the deadline mid-pass stops the pass."""
    monkeypatch.setattr(mc_run, "_MC_FORWARD_CHUNK_CELLS", 1)
    real_forward = mc_run._mc_forward_pass
    clock = [0.0]
    chunks = [0]
    monkeypatch.setattr(mc_run.time, "monotonic", lambda: clock[0])

    def _counting_forward(*args: object, **kwargs: object) -> object:
        chunks[0] += 1
        clock[0] += 1.0
        return real_forward(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(mc_run, "_mc_forward_pass", _counting_forward)
    with pytest.raises(SimulationTimeExceeded):
        monte_carlo(_project(), runs=50, seed=1, deadline=3.5)
    assert chunks[0] == 4  # chunks 1-4 ran; the check before chunk 5 refused


@pytest.mark.parametrize("bad", [True, "soon", float("nan"), float("inf"), [1.0]])
def test_a_malformed_deadline_is_invalid_input(bad: object) -> None:
    with pytest.raises(InvalidScheduleInput, match="deadline"):
        monte_carlo(_project(), runs=10, deadline=bad)  # type: ignore[arg-type]
