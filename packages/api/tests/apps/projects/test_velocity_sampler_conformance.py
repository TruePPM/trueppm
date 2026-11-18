"""The API velocity sampler is bound to the scheduler's, run for run (#2645).

``_sample_backlog_sprint_counts`` documents that it matches the scheduler's
``_sample_velocity_durations``. Nothing enforced that, and the two drifted on the
horizon cap (2000 vs 10,000). This pins them together under a shared seed: same
observation filter, same horizon formula and cap, same reach tolerance, same
row-major stream order — and the same saturation flag (#2469).
"""

from __future__ import annotations

import numpy as np
import pytest
from trueppm_scheduler.engine import _sample_velocity_durations

from trueppm_api.apps.projects.services import _sample_backlog_sprint_counts

CASES = [
    (35.0, [10.0, 10.0]),
    (37.0, [5.0, 15.0]),
    (60.0, [20.0, 0.0, 0.0, 0.0] * 2),
    (113.0, [3.0, 8.0, 13.0, 21.0, 0.0, 5.0]),
    (0.7, [0.1]),  # ulp-short accumulation (#4699)
    (100.0, [100.0] + [0.0] * 99),  # saturates ~1.6% of runs
    # Horizon past the old API cap of 2000: ceil(900 / 1) * 4 + 10 = 3610.
    (900.0, [1.0] + [0.0] * 999 + [999.0]),
]


@pytest.mark.parametrize(("points", "samples"), CASES)
@pytest.mark.parametrize("seed", [1, 2645])
def test_api_sampler_matches_library_run_for_run(
    points: float, samples: list[float], seed: int
) -> None:
    runs = 1_500
    saturated = np.zeros(runs, dtype=bool)
    library = _sample_velocity_durations(
        points, samples, 1, runs, np.random.default_rng(seed), saturated
    )
    api = _sample_backlog_sprint_counts(points, samples, runs=runs, seed=seed)
    assert library is not None
    assert api is not None
    assert np.array_equal(api.counts, library)
    assert api.saturated_runs == int(np.count_nonzero(saturated))


@pytest.mark.parametrize("samples", [[], [0.0, 0.0], [None, -1.0]])
def test_both_report_no_signal_alike(samples: list[float]) -> None:
    assert _sample_velocity_durations(10.0, samples, 1, 5, np.random.default_rng(1)) is None
    assert _sample_backlog_sprint_counts(10.0, samples, runs=5, seed=1) is None
