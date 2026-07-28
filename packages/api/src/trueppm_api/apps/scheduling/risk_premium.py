"""The schedule risk premium — "added time" — as a first-class project fact (#2483).

The premium is the gap between the two finishes the platform already computes: the
deterministic CPM finish (what the plan says if nothing varies) and the P80
commitment date (the date 80% of simulations finished by). Its whole reason for
existing is that these two disagree, and the disagreement *is* the finding — so the
platform exposes the gap rather than blending the two into one number. A blend would
destroy the probability semantics of P80: you could no longer say "80% of runs
finished by here", and a date that cannot state what it means cannot be falsified.

The derivation itself is not new — :func:`delta_vs_cpm_days` has anchored the Monte
Carlo panel since #987. What this module adds is everything needed to carry that
number *off* the forecast payload and onto the project: a duration-normalized ratio
so two projects can be compared, a machine-readable state so no consumer re-decides
what the number means, and the provenance to say how stale it is.

Read together with :class:`~trueppm_api.apps.scheduling.models.MonteCarloRun`.
"""

from __future__ import annotations

import datetime
from typing import Any, Literal, TypedDict

# A run older than this reads as stale: its premium is reported, but marked, because
# the schedule it was computed against has had a week to move underneath it. The
# stronger trigger — "the schedule actually mutated since the run" — needs a cheap
# per-project mutation counter that does not exist yet (#2483 open question 2), so
# the age rule ships first. Both resolve to the same client-visible state.
STALE_AFTER_DAYS = 7

# The one reason code whose flat forecast is a genuine measured result rather than a
# missing one: every task is complete, so there is no remaining duration left to vary.
# Every *other* structurally-flat run means the simulation had nothing to measure —
# see :func:`_premium_state`.
_FORECAST_ALL_COMPLETE = "all_complete"

RiskPremiumState = Literal["not_run", "unmeasurable", "stale", "zero", "premium", "negative"]


class RiskPremium(TypedDict):
    """The added-time metric as it appears on a project payload."""

    risk_premium_days: int | None
    risk_premium_ratio: float | None
    risk_premium_band: str | None
    risk_premium_as_of: str | None
    risk_premium_reason: str | None
    risk_premium_state: RiskPremiumState
    # The two endpoints the gap is measured between, carried from the same run as
    # the gap itself. A signed day-count whose baseline is not on screen is an
    # unverifiable delta (#2426), so any surface rendering the premium needs both
    # dates — and taking them from a second source (the live forecast cache) would
    # let the card's three numbers disagree with each other after a recompute.
    risk_premium_cpm_finish: str | None
    risk_premium_p80: str | None


def delta_vs_cpm_days(
    percentile: datetime.date | None,
    cpm_finish: datetime.date | None,
) -> int | None:
    """Signed calendar-day delta of a percentile finish vs the deterministic CPM finish.

    Positive means the probabilistic finish lands *later* than the deterministic
    spine — the schedule risk pushes the date out (worse). ``None`` when either input
    is missing. Server-owned so a headless/MCP client reads the risk premium directly
    instead of re-subtracting dates (API-first, #987/#986).
    """
    if percentile is None or cpm_finish is None:
        return None
    return (percentile - cpm_finish).days


def _premium_state(
    *,
    days: int | None,
    diagnostic: dict[str, Any] | None,
    age_days: int | None,
) -> RiskPremiumState:
    """Classify one run into the state its presentation is allowed to use.

    Evaluated in a fixed order, and the order is the safety property: ``unmeasurable``
    is decided *before* the zero branch, so a structural zero can never fall through
    into the good-news presentation.

    That ordering exists because of a specific way this metric can lie. A project with
    no three-point estimates simulates flat — every run returns the same date — so its
    premium is exactly 0 days. Rendered as a number, "0 days of added time" tells a
    completely unestimated project that it carries no schedule risk, which is not a
    weaker claim than the truth but the *inverse* of it. The discriminator is whether
    any task could have contributed duration variance at all: if none could, the
    simulation did not measure a low risk, it measured nothing.

    ``all_complete`` is the one flat-with-no-variance run that is a real result — the
    work is finished, so there is genuinely no remaining duration left to vary.

    A missing ``diagnostic`` (runs recorded before #2483) is deliberately *not* treated
    as unmeasurable: absence of a reason code is not evidence of a missing estimate, and
    guessing would invent the same false verdict in the other direction. Those runs
    report the measured state and let the band collapse.
    """
    if days is None:
        return "not_run"

    if diagnostic is not None:
        deterministic = bool(diagnostic.get("deterministic"))
        with_variance = diagnostic.get("tasks_with_variance") or 0
        reason = diagnostic.get("reason")
        if deterministic and not with_variance and reason != _FORECAST_ALL_COMPLETE:
            return "unmeasurable"

    if age_days is not None and age_days > STALE_AFTER_DAYS:
        return "stale"
    if days > 0:
        return "premium"
    if days < 0:
        return "negative"
    return "zero"


def build_risk_premium(run: Any | None, *, today: datetime.date) -> RiskPremium:
    """Derive the added-time metric from a project's most recent Monte Carlo run.

    ``run`` is a :class:`~trueppm_api.apps.scheduling.models.MonteCarloRun` or ``None``
    when the project has never been simulated.

    Undefined is always ``None``, never ``0`` — the same discipline the per-task SPI
    serializer follows. Three quantities can independently be undefined:

    * **days** — needs both a P80 and a CPM finish on the run.
    * **ratio** — ``days`` divided by the remaining CPM duration (today → CPM finish),
      which is what makes the premium comparable across projects: 29 days on a
      six-week project and 29 days on a three-year one are not the same finding.
      Undefined once the CPM finish is in the past, because there is no remaining
      duration to express the premium as a share of.
    * **band** — the verdict. Deliberately always ``None`` today: threshold cut points
      picked without evidence would be exactly the unfalsifiable tuning constant this
      metric exists to avoid, so the band waits on the measured actual-vs-estimate
      distributions from the calibration flywheel (#2299). ``days`` and ``ratio`` are
      both fully true without it, and every consumer already renders a collapsed band.
    """
    if run is None:
        return RiskPremium(
            risk_premium_days=None,
            risk_premium_ratio=None,
            risk_premium_band=None,
            risk_premium_as_of=None,
            risk_premium_reason=None,
            risk_premium_state="not_run",
            risk_premium_cpm_finish=None,
            risk_premium_p80=None,
        )

    cpm_finish: datetime.date | None = run.cpm_finish
    days = delta_vs_cpm_days(run.p80, cpm_finish)

    ratio: float | None = None
    if days is not None and cpm_finish is not None:
        remaining = (cpm_finish - today).days
        if remaining > 0:
            ratio = round(days / remaining, 3)

    taken_at = run.taken_at
    age_days = (today - taken_at.date()).days if taken_at is not None else None
    diagnostic = run.diagnostic if isinstance(run.diagnostic, dict) else None
    state = _premium_state(days=days, diagnostic=diagnostic, age_days=age_days)

    return RiskPremium(
        risk_premium_days=days,
        risk_premium_ratio=ratio,
        risk_premium_band=None,
        risk_premium_as_of=taken_at.isoformat() if taken_at is not None else None,
        # Carried even in measured states: the panel explains a flat-but-real forecast
        # from the same code, so a consumer never has to fetch the run to caption it.
        risk_premium_reason=(diagnostic or {}).get("reason"),
        risk_premium_state=state,
        risk_premium_cpm_finish=cpm_finish.isoformat() if cpm_finish is not None else None,
        # Withheld in the unmeasurable state: a flat run's "P80" is the CPM date
        # wearing a percentile's name, and offering it as a commitment would hand the
        # reader a forecast to act on that the simulation never actually produced.
        risk_premium_p80=(
            run.p80.isoformat() if run.p80 is not None and state != "unmeasurable" else None
        ),
    )
