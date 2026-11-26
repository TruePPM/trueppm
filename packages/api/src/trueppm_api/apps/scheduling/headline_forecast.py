"""Which forecast a project headlines (ADR-1485 D4, #5130).

The kind is a **server fact** so that every client (web, export, MCP) headlines
the same forecast. :func:`project_headline_forecast` is the one rule;
:func:`caller_headline_forecast` applies the velocity audience (ADR-0104) on top,
and :func:`note_headline_forecast_kind` announces a change of the project's kind.

Both enums are part of the public API contract. Adding a value needs a changelog
entry and an update to ``docs/api`` — consumers branch on them.
"""

from __future__ import annotations

import logging
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded
from django.db import transaction
from django.db.models import Q, TextChoices

logger = logging.getLogger(__name__)


class HeadlineForecastKind(TextChoices):
    CPM_MONTE_CARLO = "cpm_monte_carlo", "CPM / Monte Carlo"
    TEAM_VELOCITY = "team_velocity", "Team velocity"


class HeadlineForecastReason(TextChoices):
    # team_velocity
    SPARSE_DEPENDENCY_NETWORK = "sparse_dependency_network", "Fewer than half of tasks are linked"
    # cpm_monte_carlo
    NO_SPRINTS = "no_sprints", "The project has no sprints"
    NO_SCHEDULED_TASKS = "no_scheduled_tasks", "No task has scheduled dates"
    DEPENDENCY_NETWORK = "dependency_network", "At least half of tasks are linked"
    NO_VELOCITY_FORECAST = "no_velocity_forecast", "Not enough velocity history"
    VELOCITY_WITHHELD = "velocity_withheld", "Velocity is not shared with this caller"


def _finish_delta_working_days(project_id: Any, before: Any, after: Any) -> int | None:
    """Working days the project finish moved between two checks, or ``None`` if unknown.

    Read with the variance read's own working-day arithmetic over the project's
    scheduling calendar (the API does not reimplement engine math). Positive is a
    later finish. ``None`` when either finish is unknown, which is the first check
    after CPM first ran. Not velocity-derived, so it carries no audience gate beyond
    the event's own.
    """
    if before is None or after is None:
        return None
    from trueppm_api.apps.projects.baseline_variance import _finish_delta, _memoized_count
    from trueppm_api.apps.scheduling.calendars import project_sched_calendars

    calendar = project_sched_calendars([project_id])[str(project_id)]
    return _finish_delta((before, False), (after, False), calendar, _memoized_count(calendar))


def dependency_linked_share(project_id: Any) -> tuple[int, int]:
    """``(linked, scheduled)`` counts of the project's scheduled leaf tasks.

    A scheduled task is a live leaf task with a computed ``early_finish``; a
    summary is a roll-up, not work. A task *touches a dependency edge* when it, or
    a summary above it, is either end of a live dependency — the engine expands a
    summary link onto the summary's leaves (ADR-0105), so those leaves are linked.
    """
    from trueppm_api.apps.projects.models import Dependency, Task

    rows = list(
        Task.objects.filter(project_id=project_id, is_deleted=False).values_list(
            "id", "wbs_path", "early_finish"
        )
    )
    paths = {str(path) for _, path, _ in rows if path}
    parents: set[str] = set()
    for leaf_path in paths:
        parts = leaf_path.split(".")
        parents.update(".".join(parts[:i]) for i in range(1, len(parts)))

    ids = [task_id for task_id, _, _ in rows]
    endpoints: set[Any] = set()
    for predecessor_id, successor_id in Dependency.live.filter(
        Q(predecessor_id__in=ids) | Q(successor_id__in=ids)
    ).values_list("predecessor_id", "successor_id"):
        endpoints.add(predecessor_id)
        endpoints.add(successor_id)
    linked_paths = {str(path) for task_id, path, _ in rows if path and task_id in endpoints}

    linked = scheduled = 0
    for task_id, path, early_finish in rows:
        text = str(path) if path else ""
        if early_finish is None or text in parents:
            continue
        scheduled += 1
        parts = text.split(".") if text else []
        if task_id in endpoints or any(
            ".".join(parts[:i]) in linked_paths for i in range(1, len(parts))
        ):
            linked += 1
    return linked, scheduled


def project_headline_forecast(project_id: Any) -> tuple[str, str]:
    """``(kind, reason)`` for the project, before any audience rule. The one rule.

    ``team_velocity`` when the project has sprints, fewer than half of its
    scheduled tasks touch a dependency edge, **and** the sprint forecast has
    velocity-basis values. A throughput (flow) forecast is not a team velocity
    forecast, so it does not qualify. Cheap checks run first: the velocity Monte
    Carlo is only asked for when the other two conditions already hold.

    Not audience-gated: never return this to a caller directly, use
    :func:`caller_headline_forecast`.
    """
    from trueppm_api.apps.projects.models import Sprint
    from trueppm_api.apps.projects.services import sprint_forecast

    cpm = HeadlineForecastKind.CPM_MONTE_CARLO.value
    if not Sprint.objects.filter(project_id=project_id, is_deleted=False).exists():
        return cpm, HeadlineForecastReason.NO_SPRINTS.value
    linked, scheduled = dependency_linked_share(project_id)
    if scheduled == 0:
        return cpm, HeadlineForecastReason.NO_SCHEDULED_TASKS.value
    if 2 * linked >= scheduled:
        return cpm, HeadlineForecastReason.DEPENDENCY_NETWORK.value
    # velocity-unfiltered-ok: only the forecast's presence and basis are read, and
    # they leave this function as a kind/reason pair, never a velocity figure. The
    # audience gate is caller_headline_forecast (callers below it never get here).
    forecast = sprint_forecast(project_id)
    if (
        forecast.get("forecast_basis") != "velocity"
        or forecast.get("p50_sprints") is None
        or forecast.get("p50_date") is None
    ):
        return cpm, HeadlineForecastReason.NO_VELOCITY_FORECAST.value
    return (
        HeadlineForecastKind.TEAM_VELOCITY.value,
        HeadlineForecastReason.SPARSE_DEPENDENCY_NETWORK.value,
    )


def caller_headline_forecast(project_id: Any, *, velocity_visible: bool) -> tuple[str, str]:
    """``(kind, reason)`` as one caller may see it.

    A caller below the velocity audience always gets ``velocity_withheld`` —
    without evaluating the rule. Answering it only when the project would have
    headlined velocity would itself tell the caller that a velocity forecast exists.
    """
    if not velocity_visible:
        return (
            HeadlineForecastKind.CPM_MONTE_CARLO.value,
            HeadlineForecastReason.VELOCITY_WITHHELD.value,
        )
    return project_headline_forecast(project_id)


def note_headline_forecast_kind(project_id: Any) -> bool:
    """Record the project's kind and emit ``schedule.finish_changed`` if it changed.

    Called after a recalculation and after a sprint close, the two moments the
    rule's inputs settle. The first observation of a project records and stays
    silent: there is no earlier kind to have switched from. Never raises — the
    callers are a recalculation and a sprint close, and neither may fail or retry
    over an announcement. Returns whether the event was queued.

    Nothing is dispatched unless the team shares velocity outward
    (``program_shared``). A webhook consumer is external to the team, and the event
    only exists on a switch between two kinds from a known starting kind, so even
    an event with its fields blanked would disclose the kind (ADR-1485 D6). The
    recorded state moves either way, so sharing later announces only later
    switches. The payload carries the kind and reason: no velocity figure.

    The state row is locked before the kind is computed. A recalculation and a
    sprint close can run this at once, and a kind computed before the lock could
    be older than the one the other caller just recorded.
    """
    from trueppm_api.apps.projects.amend import current_finish
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.projects.signal_privacy_services import velocity_shared_externally

    # Through the projects wrapper: scheduling does not import webhooks (layering).
    from trueppm_api.apps.projects.views import _dispatch_webhooks

    from .models import HeadlineForecastState

    try:
        pid = str(project_id)
        project = Project.objects.filter(pk=pid, is_deleted=False).first()
        if project is None:
            return False
        with transaction.atomic():
            # "" marks a row nobody has computed yet. It is always overwritten
            # before commit. get_or_create resolves a concurrent first insert by
            # waiting for it and reading the committed row.
            HeadlineForecastState.objects.get_or_create(project_id=pid, defaults={"kind": ""})
            state = HeadlineForecastState.objects.select_for_update().get(project_id=pid)
            kind, reason = project_headline_forecast(pid)
            previous = state.kind
            finish_now = current_finish(pid)
            finish_before = state.finish
            if previous == kind:
                if finish_now != finish_before:
                    state.finish = finish_now
                    state.save(update_fields=["finish", "updated_at"])
                return False
            state.kind = kind
            state.finish = finish_now
            state.save(update_fields=["kind", "finish", "updated_at"])
            if not previous or not velocity_shared_externally(project):
                return False
            payload = {
                "finish_delta_working_days": _finish_delta_working_days(
                    pid, finish_before, finish_now
                ),
                "project": pid,
                "velocity_suppressed": False,
                "headline_forecast_kind": kind,
                "headline_forecast_reason": reason,
                "previous_headline_forecast_kind": previous,
            }
            transaction.on_commit(
                lambda: _dispatch_webhooks(pid, "schedule.finish_changed", payload)
            )
        return True
    except SoftTimeLimitExceeded:
        raise
    except Exception:
        logger.warning(
            "headline forecast kind check failed for project %s", project_id, exc_info=True
        )
        return False
