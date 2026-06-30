"""Shared pytest/Hypothesis configuration for the scheduler test suite.

Two Hypothesis profiles back the two-tier contract-fuzzing strategy (#1456):

* ``gate`` (default) — deterministic and fast, for the blocking ``scheduler:test``
  CI job and local runs. ``derandomize=True`` fixes the example stream from a
  seed derived from the test name, so the same inputs are generated on every run:
  a property fuzzer on the PR-blocking path must never flake the gate by failing
  on a *different* input than the one the previous pipeline saw.

* ``deep`` — stochastic and exhaustive, for the scheduled ``scheduler:fuzz-deep``
  job only (never on MR pipelines). Cranks ``max_examples`` and lets Hypothesis
  vary the stream and persist its example database as a corpus, so the search
  keeps probing new inputs over time. A finding here is triaged into a
  deterministic regression case in ``test_redteam_hardening.py``.

Select with ``HYPOTHESIS_PROFILE=deep``; the example budget for the deep profile
is overridable with ``FUZZ_MAX_EXAMPLES``.
"""

from __future__ import annotations

import os

from hypothesis import HealthCheck, settings

# The engine's hard caps (MAX_PROJECT_SPAN_DAYS, MAX_DURATION_DAYS, …) bound the
# work per example, so a single example is never pathologically slow on its own;
# suppress the per-example ``too_slow`` health check so a cold CI runner's first
# few (JIT/import-warm) examples don't abort the run. The contract property
# enforces its own hard hang ceiling via an in-test SIGALRM watchdog instead.
_COMMON = {
    "deadline": None,
    "suppress_health_check": [HealthCheck.too_slow],
    "print_blob": True,
}

settings.register_profile("gate", max_examples=200, derandomize=True, **_COMMON)
settings.register_profile(
    "deep",
    max_examples=int(os.environ.get("FUZZ_MAX_EXAMPLES", "50000")),
    derandomize=False,
    **_COMMON,
)

settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "gate"))
