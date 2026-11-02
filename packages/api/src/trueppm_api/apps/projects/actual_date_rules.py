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

from datetime import date
from typing import TYPE_CHECKING

from django.utils import timezone

from trueppm_api.apps.projects.actual_date_core import (
    ActualDateViolation,
    check_actual_date_order,
    check_actual_date_value_bound,
    check_actual_finish_signoff,
    check_resolved_actual_dates,
)
from trueppm_api.apps.projects.models import TaskStatus

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project

__all__ = [
    "SIGNOFF_STATUSES",
    "ActualDateViolation",
    "check_actual_date_bound",
    "check_actual_date_order",
    "check_actual_dates",
    "check_actual_finish_signoff",
]

#: Statuses on which an ``actual_finish`` may be recorded (ADR-1153 sign-off gate).
#: Both mean "delivered" — ``Task._coerce_signoff_percent`` forces them to 100%.
SIGNOFF_STATUSES: frozenset[str] = frozenset({TaskStatus.REVIEW, TaskStatus.COMPLETE})


def _bound_upper(project: Project) -> date:
    from trueppm_api.apps.scheduling.services import resolve_cpm_status_date

    return max(resolve_cpm_status_date(project.status_date), timezone.localdate())


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
    return check_actual_date_value_bound(
        field, label, value, upper=_bound_upper(project), project_start=project.start_date
    )


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
    return check_resolved_actual_dates(
        actual_start=actual_start,
        actual_finish=actual_finish,
        status=status,
        upper=_bound_upper(project) if project is not None else None,
        project_start=project.start_date if project is not None else None,
    )
