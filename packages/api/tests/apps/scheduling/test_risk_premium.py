"""Unit tests for the added-time (schedule risk premium) derivation (#2483).

The load-bearing case is :class:`TestStructuralZeroIsNotAMeasuredZero`. Everything
else here is arithmetic; that class is the reason the metric is safe to render.
"""

from __future__ import annotations

import datetime
from types import SimpleNamespace
from typing import Any

import pytest

from trueppm_api.apps.scheduling.risk_premium import (
    STALE_AFTER_DAYS,
    build_risk_premium,
    delta_vs_cpm_days,
    risk_premium_for_forecast_payload,
    risk_premium_from_values,
)

TODAY = datetime.date(2026, 7, 27)
CPM = datetime.date(2026, 10, 24)


def make_run(
    *,
    p80: datetime.date | None = datetime.date(2026, 11, 4),
    cpm_finish: datetime.date | None = CPM,
    age_days: int = 0,
    diagnostic: dict[str, Any] | None = None,
) -> SimpleNamespace:
    """A stand-in for a ``MonteCarloRun`` row — no DB needed for a pure derivation."""
    taken_at = datetime.datetime.combine(
        TODAY - datetime.timedelta(days=age_days),
        datetime.time(9, 12),
        tzinfo=datetime.UTC,
    )
    return SimpleNamespace(p80=p80, cpm_finish=cpm_finish, taken_at=taken_at, diagnostic=diagnostic)


def banded(reason: str | None, *, with_variance: int, deterministic: bool = True) -> dict[str, Any]:
    return {
        "deterministic": deterministic,
        "reason": reason,
        "tasks_total": 12,
        "tasks_with_variance": with_variance,
    }


class TestDeltaVsCpmDays:
    def test_positive_when_p80_lands_after_the_computed_finish(self) -> None:
        assert delta_vs_cpm_days(datetime.date(2026, 11, 4), CPM) == 11

    def test_negative_when_p80_lands_before_it(self) -> None:
        assert delta_vs_cpm_days(datetime.date(2026, 10, 20), CPM) == -4

    @pytest.mark.parametrize(
        ("percentile", "cpm"),
        [(None, CPM), (datetime.date(2026, 11, 4), None), (None, None)],
    )
    def test_undefined_inputs_yield_none_not_zero(
        self, percentile: datetime.date | None, cpm: datetime.date | None
    ) -> None:
        assert delta_vs_cpm_days(percentile, cpm) is None


class TestStructuralZeroIsNotAMeasuredZero:
    """The safety property: an unestimated project must never read as low-risk.

    A project with no three-point estimates simulates flat, so its premium is
    exactly 0 days — numerically identical to a project whose estimates exist and
    whose variance is genuinely low. Presenting the two the same way would tell the
    unestimated project it carries no schedule risk, which inverts the truth.
    """

    def test_no_estimates_resolves_to_unmeasurable_not_zero(self) -> None:
        run = make_run(p80=CPM, diagnostic=banded("no_estimates", with_variance=0))
        premium = build_risk_premium(run, today=TODAY)

        assert premium["risk_premium_state"] == "unmeasurable"
        assert premium["risk_premium_reason"] == "no_estimates"

    def test_unmeasurable_withholds_the_p80_so_no_commitment_can_be_read_off_it(self) -> None:
        """A flat run's "P80" is the CPM date wearing a percentile's name."""
        run = make_run(p80=CPM, diagnostic=banded("no_estimates", with_variance=0))
        premium = build_risk_premium(run, today=TODAY)

        assert premium["risk_premium_p80"] is None
        # The computed finish is still real and still rendered — only the forecast
        # the simulation never produced is withheld.
        assert premium["risk_premium_cpm_finish"] == "2026-10-24"

    def test_estimates_present_with_low_variance_is_a_real_zero(self) -> None:
        run = make_run(p80=CPM, diagnostic=banded(None, with_variance=6, deterministic=False))
        premium = build_risk_premium(run, today=TODAY)

        assert premium["risk_premium_state"] == "zero"
        assert premium["risk_premium_days"] == 0

    @pytest.mark.parametrize(
        "reason",
        ["no_estimates", "no_committed_tasks", "estimates_pending_approval", "no_velocity_history"],
    )
    def test_every_reason_that_withholds_variance_is_unmeasurable(self, reason: str) -> None:
        """Not only ``no_estimates``.

        Estimates that exist but are pending approval are withheld from the
        simulation, and an agile project with no velocity history has nothing to
        sample — in both cases the flat result is a missing measurement, not a
        low-risk finding, so the safety bias covers them too.
        """
        run = make_run(p80=CPM, diagnostic=banded(reason, with_variance=0))
        assert build_risk_premium(run, today=TODAY)["risk_premium_state"] == "unmeasurable"

    def test_all_complete_is_the_one_zero_variance_run_that_measured_something(self) -> None:
        """Finished work has no remaining duration left to vary — the zero is real."""
        run = make_run(p80=CPM, diagnostic=banded("all_complete", with_variance=0))
        assert build_risk_premium(run, today=TODAY)["risk_premium_state"] == "zero"

    def test_missing_diagnostic_reports_measured_rather_than_guessing(self) -> None:
        """Runs recorded before #2483 carry no reason code.

        Absence of a reason is not evidence of a missing estimate, so a legacy run
        must not be inflated into ``unmeasurable`` — it reports what it measured and
        lets the band collapse.
        """
        run = make_run(p80=CPM, diagnostic=None)
        assert build_risk_premium(run, today=TODAY)["risk_premium_state"] == "zero"

    def test_unmeasurable_outranks_staleness(self) -> None:
        """An old run that never had anything to measure is still unmeasurable."""
        run = make_run(
            p80=CPM,
            age_days=STALE_AFTER_DAYS + 5,
            diagnostic=banded("no_estimates", with_variance=0),
        )
        assert build_risk_premium(run, today=TODAY)["risk_premium_state"] == "unmeasurable"


class TestRatioNormalization:
    """The ratio is what makes two projects comparable; days alone are not."""

    def test_expresses_the_premium_as_a_share_of_remaining_duration(self) -> None:
        # 11 days of premium against 89 remaining days (Jul 27 → Oct 24).
        premium = build_risk_premium(make_run(), today=TODAY)
        assert premium["risk_premium_days"] == 11
        assert premium["risk_premium_ratio"] == pytest.approx(0.124, abs=0.001)

    def test_same_day_count_is_a_larger_share_of_a_shorter_project(self) -> None:
        near = build_risk_premium(
            make_run(p80=datetime.date(2026, 8, 21), cpm_finish=datetime.date(2026, 8, 10)),
            today=TODAY,
        )
        far = build_risk_premium(make_run(), today=TODAY)
        assert near["risk_premium_days"] == far["risk_premium_days"] == 11
        assert near["risk_premium_ratio"] > far["risk_premium_ratio"]

    def test_undefined_once_the_computed_finish_is_in_the_past(self) -> None:
        """No remaining duration to express the premium as a share of."""
        run = make_run(p80=datetime.date(2026, 7, 1), cpm_finish=datetime.date(2026, 6, 20))
        premium = build_risk_premium(run, today=TODAY)

        assert premium["risk_premium_days"] == 11
        assert premium["risk_premium_ratio"] is None


class TestOperationalStates:
    def test_never_simulated_reports_not_run_with_every_value_null(self) -> None:
        premium = build_risk_premium(None, today=TODAY)

        assert premium["risk_premium_state"] == "not_run"
        assert premium["risk_premium_days"] is None
        assert premium["risk_premium_ratio"] is None
        assert premium["risk_premium_as_of"] is None
        assert premium["risk_premium_cpm_finish"] is None
        assert premium["risk_premium_p80"] is None

    def test_a_measured_premium_carries_both_endpoints_of_the_gap(self) -> None:
        """A delta whose baseline is off-screen is unverifiable (#2426)."""
        premium = build_risk_premium(make_run(), today=TODAY)

        assert premium["risk_premium_cpm_finish"] == "2026-10-24"
        assert premium["risk_premium_p80"] == "2026-11-04"

    def test_a_run_missing_its_cpm_spine_has_no_premium_to_report(self) -> None:
        premium = build_risk_premium(make_run(cpm_finish=None), today=TODAY)
        assert premium["risk_premium_state"] == "not_run"
        assert premium["risk_premium_days"] is None

    def test_run_older_than_the_freshness_window_is_stale(self) -> None:
        premium = build_risk_premium(make_run(age_days=STALE_AFTER_DAYS + 1), today=TODAY)
        assert premium["risk_premium_state"] == "stale"
        # The number survives — stale means "measured a while ago", not "unknown".
        assert premium["risk_premium_days"] == 11

    def test_run_at_the_freshness_boundary_is_still_current(self) -> None:
        premium = build_risk_premium(make_run(age_days=STALE_AFTER_DAYS), today=TODAY)
        assert premium["risk_premium_state"] == "premium"

    def test_p80_before_the_computed_finish_is_reported_as_negative(self) -> None:
        run = make_run(p80=datetime.date(2026, 10, 20))
        premium = build_risk_premium(run, today=TODAY)

        assert premium["risk_premium_state"] == "negative"
        assert premium["risk_premium_days"] == -4

    def test_provenance_rides_along_so_a_number_can_always_be_dated(self) -> None:
        premium = build_risk_premium(make_run(), today=TODAY)
        assert premium["risk_premium_as_of"] is not None
        assert premium["risk_premium_as_of"].startswith("2026-07-27T09:12")


class TestBandIsWithheldUntilItCanBeDefended:
    """Thresholds picked without evidence are the tuning constant this metric avoids."""

    @pytest.mark.parametrize("p80", [CPM, datetime.date(2026, 11, 4), datetime.date(2027, 1, 20)])
    def test_no_verdict_is_emitted_at_any_magnitude(self, p80: datetime.date) -> None:
        assert build_risk_premium(make_run(p80=p80), today=TODAY)["risk_premium_band"] is None


class TestValuesEntryPointIsTheOnlyDerivation:
    """#2531 / ADR-0698 — every caller reaches the state machine through one function.

    The forecast payload needed the premium too, and the live Monte Carlo path has no
    persisted run in hand when it builds its response. Rather than let that path grow a
    second derivation — the one thing the metric cannot survive — the module exposes a
    values-level entry point that ``build_risk_premium`` itself delegates to.
    """

    def test_matches_the_run_adapter_for_the_same_inputs(self) -> None:
        run = make_run()
        assert risk_premium_from_values(
            p80=run.p80,
            cpm_finish=run.cpm_finish,
            taken_at=run.taken_at,
            diagnostic=run.diagnostic,
            today=TODAY,
        ) == build_risk_premium(run, today=TODAY)

    def test_a_never_run_project_is_all_null(self) -> None:
        premium = risk_premium_from_values(
            p80=None, cpm_finish=None, taken_at=None, diagnostic=None, today=TODAY
        )
        assert premium["risk_premium_state"] == "not_run"
        assert premium["risk_premium_days"] is None
        assert premium["risk_premium_as_of"] is None

    def test_the_structural_zero_guard_survives_the_indirection(self) -> None:
        """The whole point of the refactor is that this cannot be bypassed."""
        premium = risk_premium_from_values(
            p80=CPM,
            cpm_finish=CPM,
            taken_at=datetime.datetime.combine(TODAY, datetime.time(9), tzinfo=datetime.UTC),
            diagnostic=banded("no_estimates", with_variance=0),
            today=TODAY,
        )
        assert premium["risk_premium_state"] == "unmeasurable"
        # Not a calm zero: the P80 is withheld and no measured presentation exists.
        assert premium["risk_premium_p80"] is None


class TestForecastPayloadAdapter:
    """The cached-forecast read path (#2531).

    The 24-hour ``mc_latest`` entry stores a plain dict, so the premium is derived from
    it on every read rather than frozen into it — see
    :class:`TestRatioIsNotSafeToFreeze`.
    """

    def payload(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "p50": "2026-10-30",
            "p80": "2026-11-04",
            "p95": "2026-11-20",
            "cpm_finish": "2026-10-24",
            "last_run_at": "2026-07-27T09:12:00+00:00",
            "forecast_diagnostic": banded(None, with_variance=9, deterministic=False),
        }
        base.update(overrides)
        return base

    def test_reads_a_live_shaped_entry(self) -> None:
        premium = risk_premium_for_forecast_payload(self.payload(), today=TODAY)
        assert premium["risk_premium_state"] == "premium"
        assert premium["risk_premium_days"] == 11
        assert premium["risk_premium_cpm_finish"] == "2026-10-24"

    def test_a_legacy_entry_without_a_cpm_spine_reads_as_not_run(self) -> None:
        """Absence is "we do not know", never a measured state assembled from scraps."""
        premium = risk_premium_for_forecast_payload(self.payload(cpm_finish=None), today=TODAY)
        assert premium["risk_premium_state"] == "not_run"
        assert premium["risk_premium_days"] is None

    def test_an_entry_predating_the_field_entirely_reads_as_not_run(self) -> None:
        premium = risk_premium_for_forecast_payload({"p50": "2026-10-30"}, today=TODAY)
        assert premium["risk_premium_state"] == "not_run"

    @pytest.mark.parametrize("bad", ["yesterday", "", 17, None])
    def test_an_unparseable_timestamp_degrades_instead_of_raising(self, bad: Any) -> None:
        """A malformed cache entry must not 500 the forecast read."""
        premium = risk_premium_for_forecast_payload(self.payload(last_run_at=bad), today=TODAY)
        assert premium["risk_premium_as_of"] is None
        # Ageless, so it cannot be classified stale — but the gap itself is still true.
        assert premium["risk_premium_days"] == 11

    def test_the_structural_zero_guard_applies_to_cached_entries_too(self) -> None:
        premium = risk_premium_for_forecast_payload(
            self.payload(
                p80="2026-10-24",
                forecast_diagnostic=banded("no_estimates", with_variance=0),
            ),
            today=TODAY,
        )
        assert premium["risk_premium_state"] == "unmeasurable"


class TestRatioIsNotSafeToFreeze:
    """Why the premium is derived per response and never written into the cache.

    ``ratio`` divides by the duration still remaining *today*. A cached forecast is
    served for up to 24 hours and the same run can be read back after its computed
    finish has passed — at which point there is no remainder to take a share of, and a
    stored percentage would be describing a window that has already closed.
    """

    def test_the_same_run_reports_a_ratio_before_the_finish_and_none_after(self) -> None:
        run = make_run()
        before = build_risk_premium(run, today=TODAY)
        after = build_risk_premium(run, today=CPM + datetime.timedelta(days=1))

        assert before["risk_premium_ratio"] is not None
        assert after["risk_premium_ratio"] is None
        # The gap itself is time-invariant; only its normalization is not.
        assert before["risk_premium_days"] == after["risk_premium_days"] == 11
