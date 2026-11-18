"""Project status updates: post, freeze the snapshot, diff it live, project it for share (#4803).

A status update is the PM's call (RAG plus narrative) beside a snapshot of the plan
the server takes at ``posted_at``. The snapshot is built here and nowhere else, and
every figure in it is read from the figure's existing owner (ADR-1314): the Monte
Carlo forecast through :func:`latest_forecast_result`, the commitment through
:func:`forecast_commitment_facts`, finish comparisons through ``finish_reading``.
Nothing in this module samples, schedules or measures time on its own.

Every scalar figure carries the #4760 provenance shape ``{value, as_of, definition}``;
a figure that cannot be computed is ``value: null`` with a ``reason``, never omitted.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from django.db import transaction
from django.db.models import Count, ExpressionWrapper, F, IntegerField, Max, Q
from django.utils import timezone

from trueppm_api.apps.projects.metric_provenance import METRIC_DEFINITIONS
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Health,
    ProgramDecision,
    ProgramDecisionStatus,
    Project,
    Risk,
    RiskStatus,
    ShareLink,
    StatusUpdate,
    Task,
    TaskStatus,
)
from trueppm_api.apps.workspace.serializers import display_name_for

logger = logging.getLogger(__name__)

SNAPSHOT_SCHEMA_VERSION = 1
#: Milestone rows frozen per update. Bounded so one post cannot write an unbounded
#: document; ``milestones_truncated`` says when the cap bit.
SNAPSHOT_MAX_MILESTONES = 50
SNAPSHOT_TOP_RISKS = 3
SNAPSHOT_MAX_DECISIONS = 10

#: Forecast keys the live diff compares, in payload order.
_FORECAST_KEYS = ("p50", "p80", "cpm_finish", "baseline_finish_variance_days")


def _metric(value: Any, as_of: str | None, key: str, reason: str | None = None) -> dict[str, Any]:
    """The #4760 provenance shape for one figure."""
    out: dict[str, Any] = {
        "value": value,
        "as_of": as_of,
        "definition": METRIC_DEFINITIONS[key],
    }
    if value is None:
        out["reason"] = reason
    return out


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def canonical_sha256(snapshot: dict[str, Any]) -> str:
    """SHA-256 of the snapshot's canonical JSON (sorted keys, no whitespace)."""
    body = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode()).hexdigest()


def record_sha256(
    *,
    project_id: Any,
    seq: int,
    rag: str,
    narrative: str,
    posted_at: datetime,
    computed_health: str,
    snapshot: dict[str, Any],
) -> str:
    """SHA-256 over every field a reader or a share link is served, canonically encoded.

    Stored in ``StatusUpdate.snapshot_sha256``. Covering the snapshot alone would let
    a row rewritten outside the ORM (``UPDATE ... SET narrative = ...``) keep a valid
    digest while the share served the rewritten narrative, so the PM's call, the
    number, the time and the stored health band are inside the digest too.
    ``posted_at`` is normalized to UTC so a session time zone cannot change it.
    ``author`` is deliberately outside: it is ``SET_NULL`` when the account is
    deleted, which is a legitimate change, and it is never served on its own.
    """
    return canonical_sha256(
        {
            "project": str(project_id),
            "seq": seq,
            "rag": rag,
            "narrative": narrative,
            "posted_at": posted_at.astimezone(UTC).isoformat(),
            "computed_health": computed_health,
            "snapshot": snapshot,
        }
    )


def snapshot_verified(update: StatusUpdate) -> bool:
    """Whether the stored row still hashes to the digest recorded at post time."""
    return (
        record_sha256(
            project_id=update.project_id,
            seq=update.seq,
            rag=update.rag,
            narrative=update.narrative,
            posted_at=update.posted_at,
            computed_health=update.computed_health,
            snapshot=update.snapshot,
        )
        == update.snapshot_sha256
    )


def derived_health(project: Project) -> str:
    """The derived health band now: counts only, the ``Project.health`` override ignored.

    Same counts and rule as status-summary's band: the filters come from
    ``health_count_filters`` and the band from ``compute_health_band``, both shared
    with that view. Passing ``Health.AUTO`` is what makes it the derived branch.
    """
    from trueppm_api.apps.projects.program_rollup import task_is_phase_expr
    from trueppm_api.apps.projects.views import compute_health_band, health_count_filters

    at_risk_filter, critical_filter = health_count_filters()
    counts = (
        project.tasks.filter(is_deleted=False)
        .annotate(_is_phase=task_is_phase_expr())
        .aggregate(
            at_risk=Count("id", filter=at_risk_filter),
            critical=Count("id", filter=critical_filter),
        )
    )
    band, _source = compute_health_band(
        Health.AUTO.value, counts["at_risk"] or 0, counts["critical"] or 0
    )
    return band


def _calendar_for(project: Project) -> Callable[[], Any]:
    """A memoized project-calendar composer for ``lazy_finish_shift_days``."""
    from trueppm_api.apps.scheduling.calendars import compose_project_calendar

    holder: dict[str, Any] = {}

    def compose() -> Any:
        if "cal" not in holder:
            holder["cal"] = compose_project_calendar(project, skip_malformed=True)
        return holder["cal"]

    return compose


def _forecast(project: Project, calendar_for: Callable[[], Any]) -> dict[str, Any]:
    """P50, P80, CPM finish and the CPM finish's variance against the active baseline."""
    from trueppm_api.apps.projects.metric_provenance import (
        _active_baseline_commitment,
        latest_forecast_result,
    )
    from trueppm_api.apps.scheduling.finish_reading import (
        latest_finish,
        lazy_finish_shift_days,
        task_finish_at_day_start,
    )

    cached, run = latest_forecast_result(project.pk)
    if cached is not None:
        p50, p80, run_at = cached.get("p50"), cached.get("p80"), cached.get("last_run_at")
    elif run is not None:
        p50, p80, run_at = _iso(run.p50), _iso(run.p80), _iso(run.taken_at)
    else:
        p50 = p80 = run_at = None
    no_run = "no_forecast" if run_at is None else "no_percentile"

    tasks = Task.committed.filter(project=project).only(
        "early_finish", "is_milestone", "milestone_at_day_end", "wbs_path"
    )
    cpm = latest_finish((t.early_finish, task_finish_at_day_start(t), t.wbs_path) for t in tasks)
    recalculated = _iso(project.recalculated_at)

    commitment = _active_baseline_commitment(project.pk)
    variance: int | None = None
    variance_reason: str | None = None
    if commitment is None:
        variance_reason = "no_baseline"
    elif cpm is None:
        variance_reason = "no_cpm_finish"
    else:
        variance = lazy_finish_shift_days(commitment, cpm, calendar_for)

    return {
        "p50": _metric(p50, run_at, "p50", no_run),
        "p80": _metric(p80, run_at, "p80", no_run),
        "cpm_finish": _metric(
            _iso(cpm[0]) if cpm else None, recalculated, "status_update.cpm_finish", "no_cpm_finish"
        ),
        "cpm_finish_at_day_start": cpm[1] if cpm else None,
        "baseline_finish": _iso(commitment[0]) if commitment else None,
        "baseline_finish_variance_days": _metric(
            variance, recalculated, "status_update.baseline_finish_variance_days", variance_reason
        ),
    }


def _milestones(project: Project, calendar_for: Callable[[], Any]) -> tuple[list[Any], bool]:
    """Milestone rows: CPM finish, active-baseline finish and the working-time variance."""
    from trueppm_api.apps.scheduling.finish_reading import (
        lazy_finish_shift_days,
        task_finish_at_day_start,
    )

    qs = (
        Task.committed.filter(project=project, is_milestone=True)
        .only("id", "name", "short_id", "early_finish", "is_milestone", "milestone_at_day_end")
        .order_by("early_finish", "name", "id")
    )
    rows = list(qs[: SNAPSHOT_MAX_MILESTONES + 1])
    truncated = len(rows) > SNAPSHOT_MAX_MILESTONES
    rows = rows[:SNAPSHOT_MAX_MILESTONES]

    baseline_id = (
        Baseline.objects.filter(
            project=project, is_active=True, is_deleted=False, has_cpm_dates=True
        )
        .values_list("id", flat=True)
        .first()
    )
    base: dict[str, tuple[Any, bool | None]] = {}
    if baseline_id is not None and rows:
        for task_id, finish, at_start in BaselineTask.objects.filter(
            baseline_id=baseline_id, task_id__in=[r.id for r in rows], finish__isnull=False
        ).values_list("task_id", "finish", "finish_at_day_start"):
            base[str(task_id)] = (finish, at_start)

    out = []
    for task in rows:
        cur_start = task_finish_at_day_start(task)
        baseline = base.get(str(task.id))
        variance = (
            lazy_finish_shift_days(baseline, (task.early_finish, cur_start), calendar_for)
            if baseline is not None and task.early_finish is not None
            else None
        )
        out.append(
            {
                "task_id": str(task.id),
                "short_id": task.short_id,
                "name": task.name,
                "cpm_finish": _iso(task.early_finish),
                "cpm_finish_at_day_start": cur_start,
                "baseline_finish": _iso(baseline[0]) if baseline else None,
                "baseline_finish_at_day_start": baseline[1] if baseline else None,
                "variance_days": variance,
            }
        )
    return out, truncated


def _counts(
    project: Project,
    previous: StatusUpdate | None,
    milestones: list[dict[str, Any]],
    calendar_for: Callable[[], Any],
    as_of: str,
) -> dict[str, Any]:
    """Completed and slipped since the previous update; null with a reason on the first."""
    from trueppm_api.apps.projects.program_rollup import task_is_phase_expr
    from trueppm_api.apps.scheduling.finish_reading import lazy_finish_shift_days

    if previous is None:
        return {
            "completed_since_previous": _metric(
                None, as_of, "status_update.completed_since_previous", "no_previous_update"
            ),
            "slipped_since_previous": _metric(
                None, as_of, "status_update.slipped_since_previous", "no_previous_update"
            ),
        }
    since = timezone.localdate(previous.posted_at)
    completed = (
        Task.committed.filter(project=project, status=TaskStatus.COMPLETE, actual_finish__gte=since)
        .annotate(_is_phase=task_is_phase_expr())
        .filter(_is_phase=False)
        .count()
    )
    before = {
        m["task_id"]: m
        for m in (previous.snapshot.get("milestones") or [])
        if m.get("cpm_finish") is not None
    }
    slipped = 0
    for row in milestones:
        prior = before.get(row["task_id"])
        if prior is None or row["cpm_finish"] is None:
            continue
        shift = lazy_finish_shift_days(
            (
                datetime.fromisoformat(prior["cpm_finish"]).date(),
                prior.get("cpm_finish_at_day_start"),
            ),
            (datetime.fromisoformat(row["cpm_finish"]).date(), row["cpm_finish_at_day_start"]),
            calendar_for,
        )
        if shift > 0:
            slipped += 1
    return {
        "completed_since_previous": _metric(
            completed, as_of, "status_update.completed_since_previous"
        ),
        "slipped_since_previous": _metric(slipped, as_of, "status_update.slipped_since_previous"),
    }


def _risks(project: Project) -> list[dict[str, Any]]:
    """Top open or mitigating risks by probability x impact (ties: newest first)."""
    qs = (
        Risk.objects.filter(
            project=project,
            is_deleted=False,
            status__in=[RiskStatus.OPEN, RiskStatus.MITIGATING],
        )
        .annotate(
            severity=ExpressionWrapper(F("probability") * F("impact"), output_field=IntegerField())
        )
        .select_related("owner")
        .order_by("-severity", "-created_at", "id")[:SNAPSHOT_TOP_RISKS]
    )
    return [
        {
            "risk_id": str(r.id),
            "short_id": r.short_id,
            "title": r.title,
            "probability": r.probability,
            "impact": r.impact,
            "severity": r.severity,
            "status": r.status,
            "owner": (
                display_name_for(r.owner.first_name, r.owner.last_name, r.owner.username)
                if r.owner is not None
                else None
            ),
        }
        for r in qs
    ]


def _decisions(project: Project) -> list[dict[str, Any]]:
    """Awaiting program decisions linked to a task or risk of this project (ADR-1310)."""
    if project.program_id is None:
        return []
    qs = (
        ProgramDecision.objects.filter(
            program_id=project.program_id,
            is_deleted=False,
            status=ProgramDecisionStatus.AWAITING,
        )
        .filter(Q(linked_task__project=project) | Q(linked_risk__project=project))
        .select_related("owner")
        .order_by(F("due_date").asc(nulls_last=True), "-created_at", "id")
        .distinct()[:SNAPSHOT_MAX_DECISIONS]
    )
    return [
        {
            "decision_id": str(d.id),
            "title": d.title,
            "due_date": _iso(d.due_date),
            "owner": (
                display_name_for(d.owner.first_name, d.owner.last_name, d.owner.username)
                if d.owner is not None
                else None
            ),
        }
        for d in qs
    ]


def build_snapshot(
    project: Project, *, posted_at: datetime, previous: StatusUpdate | None
) -> dict[str, Any]:
    """The frozen snapshot document for an update posted at ``posted_at``."""
    calendar_for = _calendar_for(project)
    as_of = posted_at.isoformat()
    milestones, truncated = _milestones(project, calendar_for)
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "as_of": as_of,
        "previous_seq": previous.seq if previous is not None else None,
        "forecast": _forecast(project, calendar_for),
        "milestones": milestones,
        "milestones_truncated": truncated,
        "counts": _counts(project, previous, milestones, calendar_for, as_of),
        "risks": _risks(project),
        "decisions": _decisions(project),
    }


def post_status_update(project: Project, user: Any, *, rag: str, narrative: str) -> StatusUpdate:
    """Allocate the next ``seq``, freeze the snapshot and insert the row, atomically.

    The project row is locked (``SELECT ... FOR UPDATE``) for the whole post, so two
    concurrent posts serialize and take consecutive numbers; the
    ``(project, seq)`` unique constraint is the backstop. Snapshot and row are built
    inside one transaction, so a snapshot that raises leaves nothing behind.
    """
    with transaction.atomic():
        Project.objects.select_for_update().filter(pk=project.pk).values_list("pk").first()
        previous = StatusUpdate.objects.filter(project=project).order_by("-seq").first()
        next_seq = (
            StatusUpdate.objects.filter(project=project).aggregate(m=Max("seq"))["m"] or 0
        ) + 1
        posted_at = timezone.now()
        snapshot = build_snapshot(project, posted_at=posted_at, previous=previous)
        computed_health = derived_health(project)
        update = StatusUpdate.objects.create(
            project=project,
            seq=next_seq,
            rag=rag,
            narrative=narrative,
            author=user if getattr(user, "is_authenticated", False) else None,
            posted_at=posted_at,
            computed_health=computed_health,
            snapshot=snapshot,
            snapshot_sha256=record_sha256(
                project_id=project.pk,
                seq=next_seq,
                rag=rag,
                narrative=narrative,
                posted_at=posted_at,
                computed_health=computed_health,
                snapshot=snapshot,
            ),
        )
    logger.info(
        "status_update.posted id=%s project=%s seq=%s rag=%s by=%s sha256=%s",
        update.id,
        project.id,
        update.seq,
        update.rag,
        getattr(user, "id", None),
        update.snapshot_sha256,
    )
    return update


def current_values(project: Project) -> dict[str, Any]:
    """The values the live diff compares against, built once per request."""
    calendar_for = _calendar_for(project)
    milestones, _truncated = _milestones(project, calendar_for)
    return {
        "forecast": _forecast(project, calendar_for),
        "milestones": {m["task_id"]: m for m in milestones},
        "computed_health": derived_health(project),
    }


def live_diff(update: StatusUpdate, current: dict[str, Any]) -> dict[str, Any]:
    """Per snapshot key, the current value only where it differs from the frozen one.

    Keys are dotted paths into the snapshot (``forecast.p80``,
    ``milestones.<task_id>.cpm_finish``, ``computed_health``). A milestone that is gone
    from the plan reports ``{"value": null, "reason": "removed"}``. Never on a share.
    """
    diff: dict[str, Any] = {}
    frozen_forecast = update.snapshot.get("forecast") or {}
    now_forecast = current["forecast"]
    for key in _FORECAST_KEYS:
        then = (frozen_forecast.get(key) or {}).get("value")
        now = now_forecast[key]
        if now["value"] != then:
            diff[f"forecast.{key}"] = {"value": now["value"], "as_of": now["as_of"]}
    for row in update.snapshot.get("milestones") or []:
        now_row = current["milestones"].get(row["task_id"])
        if now_row is None:
            diff[f"milestones.{row['task_id']}"] = {"value": None, "reason": "removed"}
            continue
        for field in ("cpm_finish", "variance_days"):
            if now_row[field] != row.get(field):
                diff[f"milestones.{row['task_id']}.{field}"] = {"value": now_row[field]}
    if current["computed_health"] != update.computed_health:
        diff["computed_health"] = {"value": current["computed_health"]}
    return diff


def serialize_public_status_update(link: ShareLink) -> dict[str, Any]:
    """The share projection of ONE update's frozen snapshot (#4803).

    Reads only the stored snapshot, never the live plan, so a link for update N can
    never carry data newer than N. Whitelisted and enforced here, not in the UI: no
    ids of any kind (no workspace links), no live diff, risks and decisions only when
    the link opts in, people's names only with ``show_assignees``, milestone rows only
    with ``show_milestone_dates``. The snapshot holds no cost figures, so cost is not
    disclosed on any link.
    """
    update = link.status_update
    if update is None:
        # The serve path 404s a status-update link with no bound update before here.
        raise ValueError("status-update share link is not bound to an update")
    snap = update.snapshot
    people = link.show_assignees
    forecast = {
        k: v
        for k, v in (snap.get("forecast") or {}).items()
        if k not in ("cpm_finish_at_day_start",)
    }
    payload: dict[str, Any] = {
        "content_kind": link.content_kind,
        "project": {"name": link.project.name, "short_id": link.project.code or ""},
        "seq": update.seq,
        "rag": update.rag,
        "narrative": update.narrative,
        "posted_at": update.posted_at.isoformat(),
        "author": None,
        "computed_health": update.computed_health,
        "as_of": snap.get("as_of"),
        "forecast": forecast,
        "counts": snap.get("counts") or {},
        "milestones": None,
        "risks": None,
        "decisions": None,
        "show_assignees": people,
        "show_milestone_dates": link.show_milestone_dates,
        "show_risks": link.show_risks,
        "show_decisions": link.show_decisions,
    }
    if people and update.author is not None:
        a = update.author
        payload["author"] = display_name_for(a.first_name, a.last_name, a.username)
    if link.show_milestone_dates:
        payload["milestones"] = [
            {
                "name": m["name"],
                "cpm_finish": m["cpm_finish"],
                "baseline_finish": m["baseline_finish"],
                "variance_days": m["variance_days"],
            }
            for m in snap.get("milestones") or []
        ]
    if link.show_risks:
        payload["risks"] = [
            {
                "title": r["title"],
                "probability": r["probability"],
                "impact": r["impact"],
                "severity": r["severity"],
                "owner": r["owner"] if people else None,
            }
            for r in snap.get("risks") or []
        ]
    if link.show_decisions:
        payload["decisions"] = [
            {
                "title": d["title"],
                "due_date": d["due_date"],
                "owner": d["owner"] if people else None,
            }
            for d in snap.get("decisions") or []
        ]
    return payload
