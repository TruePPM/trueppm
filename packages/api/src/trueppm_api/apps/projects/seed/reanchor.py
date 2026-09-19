"""Re-anchor a bundled sample's dates to today (ADR-1175, #3481).

ADR-0114 authors every seed date as an offset from an ``anchor`` resolved at
**import day**, so a freshly loaded demo is always current. It then ages, and
nothing moves it: seven weeks after loading, the Atlas sample renders an "Active"
sprint that completed six weeks ago, nine overdue tasks per project, and a
burndown ending six weeks before today — while the banner still promises "60 days
of history … render out of the box".

This module is the fix. :func:`shift_sample_dates` moves every dated row the
loader wrote forward by the drift, then asks the scheduler to recompute what it
deliberately did not move.

Three properties make it safe to expose as a one-click action:

**The shift quantum is a whole week.** Not ``today - anchor``, but that rounded to
the nearest multiple of seven. The seed resolver snaps plan dates forward onto
working days (``reldates.WorkingCalendar``), so a sprint that starts on a Monday
starts on a Monday because the fixture *means* it to. Offsetting by an arbitrary
47 days would restart that sprint on a Wednesday and drop task bars onto
Saturdays — a differently broken demo. A whole-week offset preserves every
weekday alignment the importer established, exactly.

**It is idempotent.** ``sample_anchor_date`` advances by the same whole-week
offset that was applied, so a second call computes a residual of at most three
days, rounds it to zero weeks, and writes nothing. The caller needs no guard.

**It cannot reach real work.** ``_replace_existing`` refuses any program holding a
non-sample project (#2476), so a sample program holds only sample projects —
and :func:`shift_sample_dates` re-checks that invariant itself rather than
trusting the view that called it.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import F, QuerySet
from django.utils import timezone

from trueppm_api.apps.projects.models import Program, Project

# The shift quantum. Plan dates are snapped onto working days by the seed
# resolver, so only a whole-week offset preserves the weekday each date was
# deliberately placed on.
_WEEK = 7


class NotASampleProgram(ValueError):
    """The program holds no sample projects, so its dates are real work."""


class NoAnchorRecorded(ValueError):
    """The program is a sample but predates #3481 and carries no anchor date."""


@dataclass(frozen=True)
class DateShift:
    """One model's contribution to a sample date shift.

    ``scope`` narrows the model to rows belonging to one sample program. It is a
    callable rather than a dict of filter kwargs because several of these reach
    the program through a subquery rather than a join path.
    """

    label: str
    fields: tuple[str, ...]
    scope: Callable[[Program], QuerySet[Any]]


def _tasks(program: Program) -> QuerySet[Any]:
    from trueppm_api.apps.projects.models import Task

    return Task.objects.filter(project__program=program)


# ---------------------------------------------------------------------------
# Tier 1 — offset by the delta (ADR-1175)
# ---------------------------------------------------------------------------
#
# The authored plan and the synthesized history ADR-0114 backdated to support it.
# Ordering is cosmetic; every entry is applied in one transaction.


def _shift_specs() -> tuple[DateShift, ...]:
    """Build the spec table.

    Deferred into a function so importing this module does not import a dozen
    model modules at Django-setup time.
    """
    from trueppm_api.apps.projects.models import (
        AcceptanceCriterion,
        BacklogItem,
        Baseline,
        BaselineTask,
        CommentAcknowledgement,
        CommentReaction,
        Dependency,
        Label,
        Risk,
        RiskComment,
        Sprint,
        SprintRetro,
        SprintScopeChange,
        Task,
        TaskAttachment,
        TaskComment,
        TaskLabel,
        TaskNote,
        TaskRecurrenceRule,
        TaskRelation,
    )
    from trueppm_api.apps.scheduling.models import MonteCarloRun, ProjectForecastSnapshot
    from trueppm_api.apps.timetracking.models import TimeEntry

    return (
        DateShift(
            "projects.Project",
            # NOT archived_at (a lifecycle fact, not plan), NOT deleted_at (it
            # participates in partial unique indexes), NOT recalculated_at (nulled
            # separately — the recalc is redone, not moved).
            ("start_date", "status_date", "status_date_floor_armed_at", "draft_started_at"),
            lambda p: Project.objects.filter(program=p),
        ),
        DateShift(
            "projects.Task",
            # CPM output (early_*, late_*, scheduled_start) is deliberately absent —
            # see _CPM_OUTPUT_RECOMPUTED below.
            (
                "planned_start",
                "actual_start",
                "actual_finish",
                "blocked_since",
                "status_changed_at",
                "recurrence_occurrence_date",
                "seeded_at",
                "edited_at",
            ),
            _tasks,
        ),
        DateShift(
            "projects.Sprint",
            (
                "start_date",
                "finish_date",
                "milestone_bound_at",
                "activated_at",
                "closed_at",
                "created_at",
                "updated_at",
            ),
            lambda p: Sprint.objects.filter(project__program=p),
        ),
        DateShift(
            "projects.Baseline",
            ("created_at",),
            lambda p: Baseline.objects.filter(project__program=p),
        ),
        DateShift(
            # A baseline is a frozen PLAN, and baseline-vs-actual variance is a
            # RELATIVE quantity. Moving both sides by one delta preserves every
            # variance exactly. Leaving baselines pinned while the plan moves would
            # manufacture a fabricated multi-week slip on every task — the very
            # "demo shows an overdue program" defect this exists to remove.
            "projects.BaselineTask",
            ("start", "finish", "actual_start", "actual_finish"),
            lambda p: BaselineTask.objects.filter(baseline__project__program=p),
        ),
        DateShift(
            "projects.AcceptanceCriterion",
            ("met_at",),
            lambda p: AcceptanceCriterion.objects.filter(task__project__program=p),
        ),
        DateShift(
            # Program-scoped, not project-scoped (there is no per-project backlog).
            "projects.BacklogItem",
            ("pulled_at", "created_at", "updated_at"),
            lambda p: BacklogItem.objects.filter(program=p),
        ),
        DateShift(
            "projects.Risk",
            ("mitigation_due_date", "created_at", "updated_at"),
            lambda p: Risk.objects.filter(project__program=p),
        ),
        DateShift(
            "projects.RiskComment",
            ("created_at",),
            lambda p: RiskComment.objects.filter(risk__project__program=p),
        ),
        DateShift(
            # Reached from the predecessor side; a cross-project edge inside one
            # sample program is covered either way, and an edge reaching OUT of the
            # program cannot exist (a sample program holds only sample projects).
            # deleted_at excluded — a tombstone is not plan.
            "projects.Dependency",
            ("accepted_at",),
            lambda p: Dependency.objects.filter(predecessor__project__program=p),
        ),
        DateShift(
            "projects.TaskComment",
            ("created_at", "edited_at"),
            lambda p: TaskComment.objects.filter(task__project__program=p),
        ),
        DateShift(
            "projects.TaskNote",
            ("created_at", "edited_at"),
            lambda p: TaskNote.objects.filter(task__project__program=p),
        ),
        DateShift(
            "projects.TaskLabel",
            ("created_at",),
            lambda p: TaskLabel.objects.filter(task__project__program=p),
        ),
        DateShift(
            "projects.TaskAttachment",
            ("created_at",),
            lambda p: TaskAttachment.objects.filter(task__project__program=p),
        ),
        DateShift(
            "projects.TaskRelation",
            ("created_at",),
            lambda p: TaskRelation.objects.filter(source__project__program=p),
        ),
        DateShift(
            "projects.CommentReaction",
            ("created_at",),
            lambda p: CommentReaction.objects.filter(comment__task__project__program=p),
        ),
        DateShift(
            "projects.CommentAcknowledgement",
            ("created_at",),
            lambda p: CommentAcknowledgement.objects.filter(comment__task__project__program=p),
        ),
        DateShift(
            "projects.SprintRetro",
            ("created_at", "updated_at"),
            lambda p: SprintRetro.objects.filter(sprint__project__program=p),
        ),
        DateShift(
            "projects.SprintScopeChange",
            ("added_at",),
            lambda p: SprintScopeChange.objects.filter(sprint__project__program=p),
        ),
        DateShift(
            "projects.Label",
            ("created_at", "updated_at"),
            lambda p: Label.objects.filter(project__program=p),
        ),
        DateShift(
            # No FK of its own — reached through the tasks that use it.
            "projects.TaskRecurrenceRule",
            ("end_date", "generated_through"),
            lambda p: TaskRecurrenceRule.objects.filter(
                pk__in=Task.objects.filter(project__program=p)
                .exclude(recurrence_rule=None)
                .values("recurrence_rule")
            ),
        ),
        DateShift(
            "timetracking.TimeEntry",
            ("entry_date", "created_at"),
            lambda p: TimeEntry.objects.filter(task__project__program=p),
        ),
        DateShift(
            # Synthesized by seed/forecast_backfill.py, never produced by a real
            # engine run. Offsetting the capture timestamp and the percentile dates
            # by one delta preserves the trend's SHAPE exactly, which is what the
            # forecast chart renders and what the banner promises.
            "scheduling.MonteCarloRun",
            ("taken_at", "status_date", "cpm_finish", "p50", "p80", "p95"),
            lambda p: MonteCarloRun.objects.filter(project__program=p),
        ),
        DateShift(
            "scheduling.ProjectForecastSnapshot",
            ("captured_at", "cpm_finish", "mc_p50_finish", "mc_p80_finish", "mc_p95_finish"),
            lambda p: ProjectForecastSnapshot.objects.filter(project__program=p),
        ),
        DateShift(
            "projects.Program",
            ("target_date",),
            lambda p: Program.objects.filter(pk=p.pk),
        ),
    )


def _history_specs() -> tuple[DateShift, ...]:
    """``history_date`` on the simple-history rows the replayer backdated.

    ADR-0114's whole contribution was **backdated** synthesized history. Leaving
    ``history_date`` pinned while the plan moves would place a task's "went
    IN_PROGRESS" event weeks before its own planned start — the activity timeline
    would contradict the schedule it describes.

    These rows are synthesized demo content, labeled as such per ADR-0114 §5.
    Offsetting them falsifies no record of a real act.
    """
    from trueppm_api.apps.projects.models import Program as _Program
    from trueppm_api.apps.projects.models import Project as _Project
    from trueppm_api.apps.projects.models import Sprint, Task

    return (
        DateShift(
            "projects.HistoricalTask",
            ("history_date",),
            lambda p: Task.history.filter(project__program=p),
        ),
        DateShift(
            "projects.HistoricalProject",
            ("history_date",),
            lambda p: _Project.history.filter(program=p),
        ),
        DateShift(
            "projects.HistoricalSprint",
            ("history_date",),
            lambda p: Sprint.history.filter(project__program=p),
        ),
        DateShift(
            "projects.HistoricalProgram",
            ("history_date",),
            lambda p: _Program.history.filter(id=p.pk),
        ),
    )


# ---------------------------------------------------------------------------
# Tier 2 — recomputed, never offset
# ---------------------------------------------------------------------------

#: CPM engine output on ``Task``. Derived, not authored — which is why
#: ``_HISTORY_EXCLUDED_TASK`` already excludes every one of them, and why
#: ADR-1152 clears rather than migrates them. ``early_start``/``early_finish``
#: are the REMAINING-work window (ADR-0752), not the planned span, and
#: utilization reads them: offsetting these would silently change computed load
#: and forecast. The shift moves the INPUTS and re-runs the engine.
_CPM_OUTPUT_RECOMPUTED: frozenset[str] = frozenset(
    {
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "scheduled_start",
    }
)


# ---------------------------------------------------------------------------
# Tier 3 — deliberately untouched
# ---------------------------------------------------------------------------

_CPM_OUTPUT_REASON = "CPM output — recomputed (Tier 2)."
_TOMBSTONE_REASON = "Soft-delete tombstone."

#: Dated columns the loader writes that this shift does **not** move, each with
#: the reason. Every entry here is a decision, not an oversight — the test suite
#: asserts that every dated field on every loader-written model appears in
#: exactly one of the three tiers, so a new column cannot be added silently.
_DELIBERATELY_UNSHIFTED: dict[str, str] = {
    "projects.Project.archived_at": "Lifecycle fact, not plan.",
    "projects.Project.deleted_at": (
        "Soft-delete tombstone. Participates in the partial unique index "
        "unique_task_wbs_path_per_project_live (migration 0148) and its siblings; "
        "rewriting it risks a constraint violation for no demo benefit."
    ),
    "projects.Project.recalculated_at": (
        "Nulled rather than moved — the CPM pass is re-run, not relocated."
    ),
    "projects.Task.deleted_at": "Soft-delete tombstone; see Project.deleted_at.",
    "projects.Task.early_start": _CPM_OUTPUT_REASON,
    "projects.Task.early_finish": _CPM_OUTPUT_REASON,
    "projects.Task.late_start": _CPM_OUTPUT_REASON,
    "projects.Task.late_finish": _CPM_OUTPUT_REASON,
    "projects.Task.scheduled_start": _CPM_OUTPUT_REASON,
    "projects.Dependency.deleted_at": _TOMBSTONE_REASON,
    "projects.TaskComment.deleted_at": _TOMBSTONE_REASON,
    "projects.TaskNote.deleted_at": _TOMBSTONE_REASON,
    "projects.TaskAttachment.deleted_at": _TOMBSTONE_REASON,
    "projects.TaskRelation.deleted_at": _TOMBSTONE_REASON,
    "timetracking.TimeEntry.deleted_at": _TOMBSTONE_REASON,
    "projects.Program.closed_at": "Lifecycle fact, not plan.",
    "projects.Program.created_at": (
        "When the program row was minted. Moving it would claim the demo was "
        "loaded on a day it was not, and nothing renders it."
    ),
    "projects.Program.updated_at": "auto_now bookkeeping, not plan.",
    "projects.Program.sample_anchor_date": (
        "Advanced by the shift itself, not offset with the rest — it IS the "
        "bookkeeping that makes the shift idempotent."
    ),
    "projects.CalendarException.exc_start": (
        "A Calendar is shared: Project.calendar is nullable and unset projects "
        "inherit the workspace calendar, so the exceptions reachable from a sample "
        "project are frequently the WORKSPACE's holidays. Shifting them would move "
        "real projects' non-working days. A demo's holidays drifting is cosmetic; "
        "corrupting the shared calendar is not."
    ),
    "projects.CalendarException.exc_end": "See exc_start.",
    "timetracking.TimesheetSubmission.week_start": (
        "TimesheetSubmission has no project or program FK — only `user`. It cannot "
        "be scoped to one sample program, and shifting by user would reach a real "
        "person's real submissions if a persona account is ever taken over."
    ),
    "timetracking.TimesheetSubmission.submitted_at": "See week_start.",
    "projects.CeremonyTemplate.created_at": "auto_now_add bookkeeping; not rendered as plan.",
    "projects.CeremonyTemplate.updated_at": "auto_now bookkeeping.",
    "agents.AgentAction.occurred_at": (
        "HASH-CHAINED audit evidence (ADR-0112 RC1/RC2). Every row carries "
        "prev_hash/record_hash and the chain is INSTANCE-wide, not program-scoped, so "
        "a sample's rows are interleaved with real agent actions. Rewriting "
        "occurred_at would either invalidate every downstream record_hash or require "
        "re-chaining rows this program does not own. A demo's agent-action timestamps "
        "drifting is cosmetic; corrupting the audit chain is not. The seeded rows are "
        "already marked as sample data in their hashed fields "
        "(actor_token_prefix='sample', '[Sample data]' summary prefix, ADR-0114 §5), "
        "so they cannot be mistaken for production evidence either way."
    ),
    "agents.AgentActionChainHead.updated_at": (
        "Singleton chain head for the whole instance — not program-scoped and not the "
        "loader's to move. See AgentAction.occurred_at."
    ),
    "projects.RetroActionItem.created_at": (
        "Reached only through SprintRetro, whose own timestamps move; the action "
        "item's creation stamp is not rendered on any dated surface."
    ),
}


@dataclass(frozen=True)
class ShiftReport:
    """What one call to :func:`shift_sample_dates` actually did.

    ``rows_shifted`` counts **rows** touched, not date columns: every column of a
    model moves in one statement, and a row with an unset date is still a row the
    sweep rewrote. Reporting columns would mean either a second pass to count
    non-NULLs or a number inflated by every NULL — and the figure exists to tell
    an evaluator the scope of what just happened, which rows answer honestly.
    """

    shifted: bool
    days: int
    anchor_date: dt.date
    rows_shifted: int
    projects: int


def whole_week_delta(anchor: dt.date, today: dt.date) -> int:
    """Drift between ``anchor`` and ``today``, rounded to whole weeks.

    Rounds to the NEAREST multiple of seven, so the residual is at most three
    days and a sample is never shifted past today by more than that. Negative
    drift (an anchor in the future — only reachable from a hand-edited fixture)
    returns 0: shifting a demo backwards is never what anyone asked for.
    """
    raw = (today - anchor).days
    if raw <= 0:
        return 0
    return round(raw / _WEEK) * _WEEK


def shift_sample_dates(program: Program, *, actor: Any = None) -> ShiftReport:
    """Move every dated row of a sample program forward to today (ADR-1175).

    Raises:
        NotASampleProgram: the program holds no ``is_sample`` project. Checked
            HERE and not only at the view — a view can gate what its service does
            not, and any non-view caller would reopen the hole.
        NoAnchorRecorded: the program is a sample loaded before #3481 and carries
            no anchor, so no drift is computable. The caller reloads instead.
    """
    from trueppm_api.apps.scheduling.models import ScheduleRequestReason
    from trueppm_api.apps.scheduling.services import enqueue_recalculate

    if not Project.objects.filter(program=program, is_sample=True, is_deleted=False).exists():
        raise NotASampleProgram("This program is not sample data.")
    if program.sample_anchor_date is None:
        raise NoAnchorRecorded(
            "This demo was loaded before date shifting was available, so its "
            "original dates are not recorded. Remove and reload it to get "
            "current dates."
        )

    project_ids: list[str] = []
    rows = 0
    days = 0

    with transaction.atomic():
        # Re-read the anchor under a row lock: two owners pressing the button at
        # once must not both compute the same delta and apply it twice.
        locked = Program.objects.select_for_update().get(pk=program.pk)
        anchor = locked.sample_anchor_date
        if anchor is None:  # pragma: no cover — re-checked under the lock
            raise NoAnchorRecorded("No anchor recorded.")
        days = whole_week_delta(anchor, timezone.localdate())
        project_ids = [
            str(pk)
            for pk in Project.objects.filter(program=locked, is_deleted=False).values_list(
                "id", flat=True
            )
        ]
        if days == 0:
            # Already current (or within the sub-week residual). Nothing to write,
            # and deliberately NOT an error — a second press is a no-op, which is
            # what makes the action safe to offer without a guard.
            return ShiftReport(
                shifted=False,
                days=0,
                anchor_date=anchor,
                rows_shifted=0,
                projects=len(project_ids),
            )

        offset = dt.timedelta(days=days)
        for spec in (*_shift_specs(), *_history_specs()):
            # ALL of a model's columns move in ONE statement. Updating them one at
            # a time walks the row through states its own CHECK constraints forbid:
            # shifting Sprint.start_date before Sprint.finish_date puts start after
            # finish and trips `sprint_finish_after_start` mid-sweep. A single
            # UPDATE is checked once, against the final row.
            #
            # A NULL column stays NULL (NULL + interval is NULL), so unset dates
            # need no filtering — which is also why the report counts ROWS rather
            # than columns.
            rows += spec.scope(locked).update(**{field: F(field) + offset for field in spec.fields})

        # Tier 2: the engine output was left alone on purpose. Null the completion
        # marker so the Schedule view shows its existing "recalculating" badge
        # (#1053) instead of rendering stale CPM columns as though they were fresh.
        Project.objects.filter(program=locked).update(recalculated_at=None)

        locked.sample_anchor_date = anchor + offset
        locked.save(update_fields=["sample_anchor_date"])
        program.sample_anchor_date = locked.sample_anchor_date

        new_anchor = locked.sample_anchor_date

    # Outside the atomic block: enqueue_recalculate opens its own transaction and
    # attempts an immediate dispatch, falling back to the 30 s drain if the broker
    # is down (ADR-1175 Durable Execution §1/§2).
    for project_id in project_ids:
        enqueue_recalculate(project_id, reason=ScheduleRequestReason.MANUAL)

    return ShiftReport(
        shifted=True,
        days=days,
        anchor_date=new_anchor,
        rows_shifted=rows,
        projects=len(project_ids),
    )
