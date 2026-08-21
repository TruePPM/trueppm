"""The commit moment: draft → active, and baseline v1 (#2963).

Nothing in the product marked *"this is the plan we agreed to."* A steering
committee could be shown today's plan but never *committed vs. actual*, because
there was no anchor to subtract from.

Committing is one transaction that does four things, and the design is explicit
that it is **not a lock**:

1. flips ``lifecycle`` draft → active, so the project joins the aggregates it was
   excluded from (#2962);
2. captures **baseline v1 automatically**, freezing the working calendar it was
   computed against (ADR-0845);
3. commits the sprints in range;
4. tells the people who have work in it.

Authoring continues afterwards. What changes is that the plan starts having a
past — a structural edit to committed work carries a reason from here on (#2964).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from django.db import transaction
from django.db.models import DateField
from django.db.models.functions import Coalesce

if TYPE_CHECKING:
    # Unquoted in the signature below on purpose: `from __future__ import
    # annotations` makes every annotation lazy, so this stays type-only — and a
    # QUOTED annotation makes ruff think the import is unused and delete it,
    # which it did once already.
    from django.contrib.auth.models import User

from .models import (
    Baseline,
    BaselineTask,
    Project,
    ProjectLifecycle,
    Task,
)


class AlreadyCommitted(Exception):
    """The project is already active.

    Raised rather than silently re-committing: a second commit would capture a
    *second* v1 and quietly move the anchor every variance number is measured
    from, which is the one thing a baseline must never do.
    """


@dataclass
class CommitResult:
    baseline: Baseline
    task_count: int
    notified_resource_ids: list[str]


def _calendar_snapshot(project: Project) -> dict[str, object]:
    """The working-calendar fields that affect date arithmetic (ADR-0845).

    Snapshotted by value, never by reference. Calendars are editable, so storing
    an id would let a later edit reshape a baseline that is supposed to be the
    fixed side of every variance subtraction.
    """
    calendar = project.calendar
    if calendar is None:
        return {}
    return {
        "calendar_id_at_capture": calendar.id,
        "calendar_working_days": calendar.working_days,
        "calendar_hours_per_day": calendar.hours_per_day,
    }


@transaction.atomic
def commit_project(project: Project, *, user: User | None) -> CommitResult:
    """Take the project from draft to active, capturing baseline v1.

    Atomic on purpose. A commit that flipped the lifecycle but failed to capture
    the baseline would leave a project claiming to be committed with nothing to
    measure against — worse than not committing at all, because the claim is
    visible and the gap is not.
    """
    # Re-read under the row lock: two clients pressing Commit at once must not
    # both pass the check and capture two "v1"s.
    locked = Project.objects.select_for_update().get(pk=project.pk)
    if locked.lifecycle != ProjectLifecycle.DRAFT:
        raise AlreadyCommitted(str(locked.pk))

    live_tasks = list(
        Task.objects.filter(project_id=locked.pk, is_deleted=False)
        .annotate(_span_start=Coalesce("scheduled_start", "early_start", output_field=DateField()))
        .values(
            "id",
            "name",
            "early_start",
            "early_finish",
            "duration",
            "actual_start",
            "actual_finish",
            "story_points",
            "_span_start",
        )
    )
    has_cpm_dates = bool(live_tasks) and all(t["early_start"] is not None for t in live_tasks)

    baseline = Baseline.objects.create(
        project=locked,
        name="Baseline v1",
        created_by=user if user is not None and user.is_authenticated else None,
        is_active=True,
        has_cpm_dates=has_cpm_dates,
        **_calendar_snapshot(locked),
    )
    BaselineTask.objects.bulk_create(
        [
            BaselineTask(
                baseline=baseline,
                task_id=t["id"],
                task_name=t["name"],
                start=t["_span_start"],
                finish=t["early_finish"],
                duration=t["duration"],
                actual_start=t["actual_start"],
                actual_finish=t["actual_finish"],
                story_points=t["story_points"],
            )
            for t in live_tasks
        ]
    )

    locked.lifecycle = ProjectLifecycle.ACTIVE
    locked.save(update_fields=["lifecycle", "server_version"])

    return CommitResult(
        baseline=baseline,
        task_count=len(live_tasks),
        notified_resource_ids=_assigned_resource_ids(locked),
    )


def _assigned_resource_ids(project: Project) -> list[str]:
    """Everyone with a resource assignment in the plan.

    Deliberately ``TaskResource``, not ``Task.assignee``: capacity, utilization
    and every sprint-capacity number sums ``TaskResource.units``, and a bare
    assignee is zero load that may never reach the person at all. Notifying off
    ``assignee`` would tell the wrong set of people about their own commitment.
    """
    from trueppm_api.apps.resources.models import TaskResource

    return [
        str(rid)
        for rid in TaskResource.objects.filter(task__project_id=project.pk, task__is_deleted=False)
        .values_list("resource_id", flat=True)
        .distinct()
    ]
