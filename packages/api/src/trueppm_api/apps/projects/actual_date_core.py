"""Django-free core of the ADR-1153 actual-date rules (#3709).

Split out of ``actual_date_rules`` so seed validation, which must stay importable
and callable without Django (the sample generators in ``scripts/seeds`` call
``validate_seed`` with no ``django.setup()``), shares the one implementation of
the rules rather than carrying a copy. Everything here works on plain dates and
status strings; ``actual_date_rules`` adapts it to ``Project`` and ``TaskStatus``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

#: Mirror of ``projects.models.MAX_PROJECT_SPAN_DAYS`` (kept here so this module
#: needs no models import); ``test_actual_date_rules_parity`` pins the two together.
MAX_PROJECT_SPAN_DAYS = 366 * 1000

#: Mirror of ``TaskStatus.REVIEW`` / ``TaskStatus.COMPLETE`` values, pinned by the
#: same parity test.
SIGNOFF_STATUS_VALUES: frozenset[str] = frozenset({"REVIEW", "COMPLETE"})


@dataclass(frozen=True)
class ActualDateViolation:
    """One violated ADR-1153 actual-date rule.

    ``field`` names the offending ``Task`` field (``actual_start`` or
    ``actual_finish``) so a caller with field-level error reporting (the DRF
    serializer) can attach the message to the right key.
    """

    field: str
    message: str
    code: str


def check_actual_date_order(
    actual_start: date | None, actual_finish: date | None
) -> ActualDateViolation | None:
    """Ordering rule: ``actual_start <= actual_finish`` when both are present.

    Mirrors the engine's own ``_validate_task_actual_order`` so no write path can
    persist a pair that detonates the project's next recompute.
    """
    if actual_start is not None and actual_finish is not None and actual_start > actual_finish:
        return ActualDateViolation(
            field="actual_finish",
            message=(
                f"Actual finish cannot be earlier than actual start ({actual_start.isoformat()})."
            ),
            code="actual_dates_out_of_order",
        )
    return None


def check_actual_date_value_bound(
    field: str, label: str, value: date | None, *, upper: date, project_start: date
) -> ActualDateViolation | None:
    """Future bound (``upper``) and absolute span-cap for one field."""
    if value is None:
        return None
    if value > upper:
        return ActualDateViolation(
            field=field,
            message=f"{label} cannot be in the future (after {upper.isoformat()}).",
            code="actual_date_in_future",
        )
    # Span cap, the same class as the ordering rule and measured as an ABSOLUTE
    # offset, so a date far in the past detonates exactly like one far in the
    # future — the future bound above does not reach that direction, and an
    # imported or hand-typed date carries no floor otherwise (#1068 class).
    if abs((value - project_start).days) > MAX_PROJECT_SPAN_DAYS:
        return ActualDateViolation(
            field=field,
            message=(
                f"{label} is more than {MAX_PROJECT_SPAN_DAYS} days from the project "
                "start; the schedule cannot be computed within a representable date range."
            ),
            code="actual_date_outside_span",
        )
    return None


def check_actual_finish_signoff(
    actual_finish: date | None, status: str | None
) -> ActualDateViolation | None:
    """Sign-off gate: ``actual_finish`` may only be recorded on a REVIEW/COMPLETE task.

    ``engine._is_complete`` reads completion as ``actual_finish is not None or
    percent_complete >= 100``, so a finish written onto an in-flight task pins it
    as complete in CPM while the board still shows it in progress.
    """
    if actual_finish is not None and status not in SIGNOFF_STATUS_VALUES:
        return ActualDateViolation(
            field="actual_finish",
            message="Actual finish can only be set on a task that is in review or complete.",
            code="actual_finish_requires_signoff",
        )
    return None


def check_resolved_actual_dates(
    *,
    actual_start: date | None,
    actual_finish: date | None,
    status: str | None,
    upper: date | None,
    project_start: date | None,
) -> ActualDateViolation | None:
    """First violated rule for a fully-resolved triple: ordering, bound/span, sign-off.

    The bound and span rules are skipped when ``upper`` or ``project_start`` is
    unknown (no project to measure against).
    """
    violation = check_actual_date_order(actual_start, actual_finish)
    if violation is not None:
        return violation
    if upper is not None and project_start is not None:
        for field, label, value in (
            ("actual_start", "Actual start", actual_start),
            ("actual_finish", "Actual finish", actual_finish),
        ):
            violation = check_actual_date_value_bound(
                field, label, value, upper=upper, project_start=project_start
            )
            if violation is not None:
                return violation
    return check_actual_finish_signoff(actual_finish, status)
