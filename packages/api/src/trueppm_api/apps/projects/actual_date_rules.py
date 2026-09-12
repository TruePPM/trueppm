"""Shared ADR-1153 actual-date invariants (#3709).

``TaskSerializer._validate_actual_dates`` was the only place these rules were
enforced until this issue: the MS Project importer, seed replay, and inbound
external-source sync all write ``Task.actual_start`` / ``Task.actual_finish``
directly, bypassing the serializer entirely (REST, ``task_bulk.py``, and
``sync/upload.py`` all reuse ``TaskSerializer``, so they were already covered).
This module holds one implementation of the ordering, future-bound, span-cap,
and sign-off rules so every write path enforces the same thing instead of two
implementations that can drift.

Callers own how a violation surfaces — the serializer raises a field-level DRF
``ValidationError``; the MS Project importer drops the offending field and
records a per-row warning instead of persisting it; seed replay does the same
defensively (its beats are deterministic and should never trip this).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING

from django.utils import timezone

from trueppm_api.apps.projects.models import MAX_PROJECT_SPAN_DAYS, TaskStatus

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project

#: Statuses on which an ``actual_finish`` may be recorded (ADR-1153 sign-off gate).
#: Both mean "delivered" — ``Task._coerce_signoff_percent`` forces them to 100%.
SIGNOFF_STATUSES: frozenset[str] = frozenset({TaskStatus.REVIEW, TaskStatus.COMPLETE})


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


def check_actual_date_bound(
    field: str, label: str, value: date | None, project: Project
) -> ActualDateViolation | None:
    """Future bound (``max(data date, today)``) and absolute span-cap for one field.

    ``field``/``label`` name which of ``actual_start`` / ``actual_finish`` is
    being checked, so the caller can attach either rule's message to the right
    key without re-deriving it.
    """
    if value is None:
        return None

    from trueppm_api.apps.scheduling.services import resolve_cpm_status_date

    upper = max(resolve_cpm_status_date(project.status_date), timezone.localdate())
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
    if abs((value - project.start_date).days) > MAX_PROJECT_SPAN_DAYS:
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
    if actual_finish is not None and status not in SIGNOFF_STATUSES:
        return ActualDateViolation(
            field="actual_finish",
            message="Actual finish can only be set on a task that is in review or complete.",
            code="actual_finish_requires_signoff",
        )
    return None


def check_actual_dates(
    *,
    actual_start: date | None,
    actual_finish: date | None,
    status: str | None,
    project: Project | None,
) -> ActualDateViolation | None:
    """Validate a fully-resolved ``(actual_start, actual_finish, status)`` triple.

    Convenience wrapper for a caller that writes an entire row at once — the MS
    Project importer, seed replay — where there is no payload/instance merge to
    do first because every value passed here is already final.

    ``TaskSerializer._validate_actual_dates`` does **not** use this wrapper: a
    partial ``PATCH`` needs different field-touch semantics per rule (ordering
    resolves payload-else-instance so a partial write that crosses the invariant
    against a stored value is still rejected, but the bound and sign-off checks
    apply only to a field the write actually touches, so an unrelated PATCH on a
    task with pre-existing invalid actuals is not blocked) — see that method's
    own docstring. It calls :func:`check_actual_date_order`,
    :func:`check_actual_date_bound`, and :func:`check_actual_finish_signoff`
    directly instead.

    Returns the first violated rule (ordering, then future/span bound, then
    sign-off), or ``None``.
    """
    violation = check_actual_date_order(actual_start, actual_finish)
    if violation is not None:
        return violation

    if project is not None:
        for field, label, value in (
            ("actual_start", "Actual start", actual_start),
            ("actual_finish", "Actual finish", actual_finish),
        ):
            violation = check_actual_date_bound(field, label, value, project)
            if violation is not None:
                return violation

    return check_actual_finish_signoff(actual_finish, status)
