"""Baseline capture and the two exits from a changeset (ADR-1477, #3150).

There is **one** capture. Commit (ADR-0845, ``commit_moment.py``), the manual
"save a baseline" create, and taking v(n+1) all snapshot the plan through
:func:`snapshot_tasks`, so the three can never disagree about what a baseline
holds (the SPAN start, the CPM finish and the edge of its day, the ADR-0845
calendar snapshot).

:func:`decide` is the only way a committed plan's active baseline moves.
``BaselineActivateView`` refuses on an ACTIVE project with
``use_baseline_decision`` — otherwise the old path would re-baseline with no
reasons and no trail row, which the threat model ranks as its top risk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from django.db import transaction
from django.db.models import DateField
from django.db.models.functions import Coalesce
from django.utils import timezone

from trueppm_api.apps.scheduling.finish_reading import values_finish_at_day_start

from .models import (
    Baseline,
    BaselineDecision,
    BaselineDecisionKind,
    BaselineTask,
    ChangesetEntry,
    Project,
    Task,
)


class DecisionRefused(Exception):
    """A decision the server will not take. ``status`` and ``body`` are the response."""

    def __init__(self, status: int, body: dict[str, Any]) -> None:
        super().__init__(body.get("code", "refused"))
        self.status = status
        self.body = body


def calendar_snapshot(project: Project) -> dict[str, object]:
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


def live_task_rows(project_id: Any) -> list[dict[str, Any]]:
    # The SPAN start (ADR-0752 scheduled_start), not early_start: since ADR-0132
    # early_start on an in-progress task is the remaining-work window, so a
    # mid-progress capture would snapshot an already-narrowed start (#2623).
    rows: list[dict[str, Any]] = [
        dict(r)
        for r in Task.objects.filter(project_id=project_id, is_deleted=False)
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
            # FINISH_READING_FIELDS: what values_finish_at_day_start reads (#4197).
            "is_milestone",
            "milestone_at_day_end",
        )
    ]
    return rows


def has_cpm_dates_for(rows: list[dict[str, Any]]) -> bool:
    return bool(rows) and all(t["early_start"] is not None for t in rows)


def snapshot_tasks(baseline: Baseline, rows: list[dict[str, Any]]) -> int:
    """Write the frozen ``BaselineTask`` rows for ``baseline``. Returns the count."""
    BaselineTask.objects.bulk_create(
        [
            BaselineTask(
                baseline=baseline,
                task_id=t["id"],
                task_name=t["name"],
                start=t["_span_start"],
                finish=t["early_finish"],
                # Which edge of that day the finish sits on (#4197), so drift is
                # compared in working time rather than by the shown day.
                finish_at_day_start=values_finish_at_day_start(t),
                duration=t["duration"],
                actual_start=t["actual_start"],
                actual_finish=t["actual_finish"],
                story_points=t["story_points"],
            )
            for t in rows
        ]
    )
    return len(rows)


def capture(
    project: Project,
    user: Any,
    name: str,
    *,
    active: bool = True,
    source: str = "decision",
    **fields: Any,
) -> tuple[Baseline, int]:
    """Capture a baseline of the plan as it stands. Caller holds the transaction.

    The one capture (ADR-1477 Implementation Notes §4): a taken decision and the
    REST create both go through it, so both freeze the same rows and the same
    calendar, and both announce the capture the same way.

    ``active=True`` stands down any incumbent active baseline first: ``Baseline``
    has a partial unique constraint on (project) WHERE is_active. Deactivated,
    never deleted — baseline history is kept forever. A non-active capture is a
    named comparison snapshot, never a re-baseline.
    """
    rows = live_task_rows(project.pk)
    if active:
        Baseline.objects.filter(project_id=project.pk, is_active=True).update(is_active=False)
    baseline = Baseline.objects.create(
        project=project,
        name=name,
        created_by=user if user is not None and getattr(user, "is_authenticated", False) else None,
        is_active=active,
        has_cpm_dates=has_cpm_dates_for(rows),
        **calendar_snapshot(project),
        **fields,
    )
    count = snapshot_tasks(baseline, rows)
    _announce_capture(baseline, count, source)
    return baseline, count


def _announce_capture(baseline: Baseline, task_count: int, source: str) -> None:
    """``baseline_created`` to the board and the ``baseline.captured`` webhook, after commit.

    Other clients refetch their baselines on the board event; integrators hear
    a v(n+1) the same way they hear any other capture (ADR-0206). The payload is
    built now, inside the transaction, and captured by value.
    """
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    from .views import _baseline_webhook_payload, _dispatch_webhooks

    project_id = str(baseline.project_id)
    baseline_id = str(baseline.pk)
    payload = _baseline_webhook_payload(baseline, task_count=task_count, source=source)
    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "baseline_created", {"id": baseline_id})
    )
    transaction.on_commit(lambda: _dispatch_webhooks(project_id, "baseline.captured", payload))


# ── The changeset read ───────────────────────────────────────────────────────


def open_entries(project_id: Any) -> Any:
    """Open entries, unreasoned first (D11), then oldest first."""
    from django.db.models import BooleanField, Case, Value, When

    return (
        ChangesetEntry.objects.filter(project_id=project_id, resolved_by__isnull=True)
        .select_related("author", "reason_by")
        .annotate(
            _reasoned=Case(
                When(reason__isnull=True, then=Value(False)),
                default=Value(True),
                output_field=BooleanField(),
            )
        )
        .order_by("_reasoned", "opened_at", "id")
    )


def baseline_finish(baseline: Baseline | None) -> Any:
    if baseline is None:
        return None
    from django.db.models import Max

    return BaselineTask.objects.filter(baseline=baseline).aggregate(f=Max("finish"))["f"]


@dataclass
class Preview:
    finish_from: Any
    finish_to: Any
    delta_days: int | None
    milestones_moved: list[dict[str, Any]] = field(default_factory=list)
    tasks_with_new_dates: dict[str, int] = field(default_factory=dict)
    commitment_moves: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "finish_from": self.finish_from.isoformat() if self.finish_from else None,
            "finish_to": self.finish_to.isoformat() if self.finish_to else None,
            "delta_days": self.delta_days,
            "milestones_moved": self.milestones_moved,
            "tasks_with_new_dates": self.tasks_with_new_dates,
            "commitment_moves": self.commitment_moves,
        }


def preview(project: Project, active: Baseline | None, *, commitment_moved: bool) -> Preview:
    """What taking v(n+1) would do, read against the active baseline.

    Reads persisted CPM output only — it never recomputes dates (ADR-0599; the
    API never reimplements engine math). ``delta_days`` is the plain shown-day
    difference of the two finishes, in calendar days.
    """
    from . import amend

    finish_from = baseline_finish(active)
    finish_to = amend.current_finish(project.pk)
    delta = (finish_to - finish_from).days if finish_from and finish_to else None
    snap = (
        {
            str(r["task_id"]): (r["start"], r["finish"])
            for r in BaselineTask.objects.filter(baseline=active).values(
                "task_id", "start", "finish"
            )
        }
        if active is not None
        else {}
    )
    live = list(
        Task.objects.filter(project_id=project.pk, is_deleted=False)
        .annotate(_span_start=Coalesce("scheduled_start", "early_start", output_field=DateField()))
        .values("id", "name", "is_milestone", "_span_start", "early_finish")
    )
    changed = 0
    milestones: list[dict[str, Any]] = []
    for t in live:
        before = snap.get(str(t["id"]))
        now = (t["_span_start"], t["early_finish"])
        if before is None or before != now:
            changed += 1
            if t["is_milestone"] and before is not None and before[1] != now[1]:
                milestones.append(
                    {
                        "id": str(t["id"]),
                        "name": t["name"],
                        "from": before[1].isoformat() if before[1] else None,
                        "to": now[1].isoformat() if now[1] else None,
                    }
                )
    return Preview(
        finish_from=finish_from,
        finish_to=finish_to,
        delta_days=delta,
        milestones_moved=milestones,
        tasks_with_new_dates={"count": changed, "of": len(live)},
        commitment_moves=commitment_moved,
    )


# ── The two exits ────────────────────────────────────────────────────────────


@dataclass
class DecisionInput:
    kind: str
    expected_open_count: int | None = None
    reason_code: str | None = None
    reason: str = ""
    note: str = ""
    commitment_moved: bool = False
    decision_id: Any = None


def decide(
    project: Project, *, user: Any, data: DecisionInput, dry_run: bool = False
) -> BaselineDecision | Preview:
    """Take v(n+1) or keep v(n), in one transaction (ADR-1477 §5).

    Refusals, in order: the open set changed since the sheet loaded
    (``changeset_changed``); for ``taken`` only, any unreasoned open entry
    (``changeset_unreasoned``, naming the entries — the server owns the gate, not
    just the disabled button); a commitment move before #3901 adds the field
    (``commitment_not_available``); a linked decision from another program.

    ``kept`` is never refused for unreasoned entries: living with variance is not
    a claim about why. Its entries stay open; it closes their groups so a later
    act opens a new entry and re-promotes Review (Q3.1).
    """
    with transaction.atomic():
        locked = Project.objects.select_for_update().get(pk=project.pk)
        entries = list(open_entries(locked.pk).select_for_update(of=("self",)))
        active = Baseline.objects.filter(
            project_id=locked.pk, is_active=True, is_deleted=False
        ).first()
        if dry_run:
            # The sheet shows the net effect even while Take v2 is blocked, so the
            # preview is never refused for unreasoned entries.
            return preview(locked, active, commitment_moved=data.commitment_moved)

        if data.expected_open_count is not None and data.expected_open_count != len(entries):
            raise DecisionRefused(409, {"code": "changeset_changed", "open_count": len(entries)})
        if data.commitment_moved:
            # No commitment field exists on Project until #3901 (ADR-1477 §1).
            raise DecisionRefused(400, {"code": "commitment_not_available"})

        program_decision = None
        if data.decision_id is not None:
            from .models import ProgramDecision

            program_decision = ProgramDecision.objects.filter(pk=data.decision_id).first()
            if program_decision is None or program_decision.program_id != locked.program_id:
                raise DecisionRefused(400, {"code": "decision_not_in_program"})

        if data.kind == BaselineDecisionKind.TAKEN:
            unreasoned = [str(e.pk) for e in entries if e.reason is None]
            if unreasoned:
                raise DecisionRefused(409, {"code": "changeset_unreasoned", "entries": unreasoned})

        from . import amend

        now = timezone.now()
        entry_ids = [str(e.pk) for e in entries]
        to_baseline = None
        if data.kind == BaselineDecisionKind.TAKEN:
            taken_before = BaselineDecision.objects.filter(
                project_id=locked.pk, kind=BaselineDecisionKind.TAKEN
            ).count()
            # v1 is the commit's; each taken decision is the next number.
            to_baseline, _count = capture(locked, user, f"Baseline v{taken_before + 2}")

        row = BaselineDecision.objects.create(
            project=locked,
            kind=data.kind,
            from_baseline=active,
            to_baseline=to_baseline,
            reason_code=(data.reason_code or "") if data.kind == BaselineDecisionKind.TAKEN else "",
            reason=data.reason if data.kind == BaselineDecisionKind.TAKEN else "",
            note=data.note if data.kind == BaselineDecisionKind.KEPT else "",
            commitment_moved=False,
            decision=program_decision,
            entry_ids=entry_ids,
            finish_at_decision=amend.current_finish(locked.pk),
            actor=user if getattr(user, "is_authenticated", False) else None,
        )
        if data.kind == BaselineDecisionKind.TAKEN:
            ChangesetEntry.objects.filter(pk__in=entry_ids).update(resolved_by=row)
        ChangesetEntry.objects.filter(pk__in=entry_ids, closed_at__isnull=True).update(
            closed_at=now
        )
        amend.broadcast_changeset(locked.pk)
        return row
