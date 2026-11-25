"""Amend: a structural edit to a committed plan carries a reason (#2964).

Once a plan is committed (ADR-0845), the same keystrokes that built a greenfield
draft are now editing something other people planned around. Before this, they
were indistinguishable: no different prompt, no record, no signal to anyone.

Three properties, and the third is the one most likely to be eroded later:

1. **The reason lands in plan history.** Free text, no category picker — a
   dropdown of six blessed reasons collects the nearest wrong one, which is worse
   than nothing because it looks like data.
2. **It reaches the people whose work moved**, not only the person who clicked.
3. **It is never a block.** Amend records and tells. It does not gate, refuse, or
   require approval. A planner who cannot change a committed plan will keep the
   real plan somewhere else, and then the tool is describing fiction.

Not every edit is an amend. A draft is still a draft — authoring a plan nobody
has agreed to yet must stay frictionless, or the commit moment becomes something
people avoid rather than something they reach for.
"""

from __future__ import annotations

import logging
from functools import partial
from typing import TYPE_CHECKING, Any

from django.db import transaction

if TYPE_CHECKING:
    from .models import Project, Task

logger = logging.getLogger(__name__)

#: What a reason is attached to in `HistoricalTask.history_change_reason`.
AMEND_PREFIX = "amend"


def is_amendable(project: Project) -> bool:
    """True when edits to this project are amendments rather than authoring.

    Keyed on lifecycle, not on the presence of a baseline: a project can be
    committed and its baseline capture could conceivably fail, and in that state
    edits are still edits to something people agreed to.
    """
    from .models import ProjectLifecycle

    return project.lifecycle == ProjectLifecycle.ACTIVE


def record_amend_reason(task: Task, reason: str | None) -> None:
    """Attach the reason to the row's next history entry.

    ``_change_reason`` is simple_history's hook and is already how this codebase
    annotates history (`services.py`, scope acceptance). Setting it here means the
    reason rides the *existing* history write rather than needing a parallel audit
    table that could disagree with it.

    A blank reason is stored as the bare marker rather than being dropped: "someone
    amended this and did not say why" is itself worth knowing, and is different
    from "this was never amended".
    """
    text = (reason or "").strip()
    task._change_reason = f"{AMEND_PREFIX}: {text}" if text else AMEND_PREFIX  # type: ignore[attr-defined]


def notify_amend(task: Task, *, actor: Any, reason: str | None) -> None:
    """Tell the people whose work this changed.

    Recipients are everyone with a **resource assignment** on the task, minus the
    actor. Deliberately ``TaskResource`` rather than ``Task.assignee``: capacity,
    utilization and sprint capacity all sum ``TaskResource.units``, and a bare
    assignee carries no load and may never reach the person — so notifying off it
    would tell the wrong set of people that their own committed work moved.

    Best-effort and deferred to ``transaction.on_commit``: a notification failure
    must never revert an edit that has already been accepted. Amend is not a gate,
    and a failure here must not accidentally turn it into one (the ADR-0232
    carryover pattern, as used by ``notify_sprint_membership_change``).
    """
    from trueppm_api.apps.resources.models import TaskResource

    actor_id = actor.pk if actor is not None and getattr(actor, "is_authenticated", False) else None

    assigned = TaskResource.objects.filter(task_id=task.pk)
    if actor_id is not None:
        # Only exclude when there IS an actor. `.exclude(field=None)` would drop
        # every resource with no linked user, which is the opposite of intent.
        assigned = assigned.exclude(resource__user_id=actor_id)
    recipient_ids = list(assigned.values_list("resource__user_id", flat=True).distinct())
    recipient_ids = [rid for rid in recipient_ids if rid is not None]
    if not recipient_ids:
        return

    body = _amend_body(
        getattr(actor, "username", "") or "Someone",
        task.name,
        reason,
    )
    rows: list[tuple[Any, str, str, str | None]] = [
        (rid, "A committed plan changed", body, str(task.pk)) for rid in recipient_ids
    ]
    _defer_amend_notifications(str(task.project_id), rows, task.pk)


def _amend_body(actor_name: str, task_name: str, reason: str | None) -> str:
    """The notice text.

    States the reason when there is one and says so plainly when there is not —
    "no reason given" is information, and quietly omitting the clause would make
    an unexplained change look like an explained one.
    """
    text = (reason or "").strip()
    label = task_name or "Untitled"
    if text:
        return f"{actor_name} changed “{label}” on a committed plan — {text}"
    return f"{actor_name} changed “{label}” on a committed plan. No reason was given."


def _defer_amend_notifications(
    project_id: str,
    rows: list[tuple[Any, str, str, str | None]],
    key: Any,
) -> None:
    """The one ``on_commit`` site for every plan-amended notice.

    Both the per-task field-edit path (:func:`notify_amend`) and the changeset
    path (:func:`_notify_entry`) defer through here, so the best-effort emit has
    a single callsite to audit rather than one per caller.
    """
    transaction.on_commit(partial(_emit_amend_notifications, project_id, rows, key))


def _emit_amend_notifications(
    project_id: str,
    rows: list[tuple[Any, str, str, str | None]],
    task_pk: Any,
) -> None:
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch

    try:
        create_event_notifications_batch(
            event_type=NotificationEventType.PLAN_AMENDED,
            project_id=project_id,
            rows=rows,
        )
    except Exception:
        logger.exception("notify_amend: emit failed for task %s", task_pk)


# ── The changeset (ADR-1477, #3150) ─────────────────────────────────────────────

#: D10's batching window. A session-wide window would let one reason cover
#: unrelated moves, so it stays at two minutes (decided 2026-11-24, Q3.8).
GROUP_WINDOW_SECONDS = 120

#: Surfaces a client may name. Anything else is recorded as ``api``.
_CLIENT_SURFACES = {"grid", "gantt", "board", "outline", "api"}


def amend_context(request: Any) -> dict[str, Any]:
    """Read the optional changeset hints a structural write may carry.

    ``surface`` (part of the grouping key), ``amend_group: "new"`` (the client
    closes a group on events the server cannot see: a mode or surface change,
    Review opened, page unload) and ``amend_reason`` (answers the new entry in
    the same write). All optional; a body that is not a dict carries none.
    """
    data = getattr(request, "data", None)
    if not isinstance(data, dict):
        return {"surface": "api", "new_group": False, "reason": None}
    surface = data.get("surface")
    reason = data.get("amend_reason")
    return {
        "surface": surface if isinstance(surface, str) and surface in _CLIENT_SURFACES else "api",
        "new_group": data.get("amend_group") == "new",
        "reason": reason.strip()[:500] if isinstance(reason, str) and reason.strip() else None,
    }


def current_finish(project_id: Any) -> Any:
    """The project's CPM finish: max live ``early_finish``, or None before any run."""
    from django.db.models import Max

    from .models import Task

    return Task.objects.filter(project_id=project_id, is_deleted=False).aggregate(
        f=Max("early_finish")
    )["f"]


def record_structural_change(
    project: Project,
    *,
    kind: str,
    surface: str,
    actor: Any,
    tasks: list[Any],
    reason: str | None = None,
    new_group: bool = False,
) -> Any:
    """Record one structural act on a committed plan (ADR-1477 §2–3).

    A no-op on a draft: authoring a plan nobody has agreed to stays frictionless.
    Never refuses and never raises for lack of a reason — the edit has already
    applied (D9); this only records that it happened.

    Grouping is server-side so it survives a reload: the newest open entry for
    ``(project, kind, surface, author)`` absorbs the act when it has no reason,
    is not closed, and its last act was within :data:`GROUP_WINDOW_SECONDS`. A
    multi-select act (one call, several rows) is one act. Returns the entry, or
    None on a draft or an empty act.
    """
    from datetime import timedelta

    from django.utils import timezone

    from .models import Baseline, ChangesetEntry

    if not is_amendable(project) or not tasks:
        return None

    now = timezone.now()
    author = actor if actor is not None and getattr(actor, "is_authenticated", False) else None
    ids = [str(getattr(t, "pk", t)) for t in tasks]
    names = [getattr(t, "name", "") or "" for t in tasks]

    entry = None
    if not new_group and reason is None:
        entry = (
            ChangesetEntry.objects.select_for_update()
            .filter(
                project_id=project.pk,
                kind=kind,
                surface=surface,
                author=author,
                reason__isnull=True,
                closed_at__isnull=True,
                resolved_by__isnull=True,
                last_act_at__gte=now - timedelta(seconds=GROUP_WINDOW_SECONDS),
            )
            .order_by("-last_act_at")
            .first()
        )

    new_ids: list[str]
    if entry is not None:
        known = set(entry.task_ids)
        new_ids = [i for i in ids if i not in known]
        for i, n in zip(ids, names, strict=True):
            if i not in known:
                entry.task_ids.append(i)
                entry.task_names.append(n)
                known.add(i)
        entry.last_act_at = now
        # The effect changed again; the next recalculation re-stamps it.
        entry.finish_after = None
        entry.save(update_fields=["task_ids", "task_names", "last_act_at", "finish_after"])
    else:
        new_ids = ids
        entry = ChangesetEntry.objects.create(
            project_id=project.pk,
            baseline=Baseline.objects.filter(
                project_id=project.pk, is_active=True, is_deleted=False
            ).first(),
            kind=kind,
            surface=surface,
            author=author,
            task_ids=ids,
            task_names=names,
            reason=reason,
            reason_by=author if reason else None,
            reason_at=now if reason else None,
            closed_at=now if reason else None,
            finish_before=current_finish(project.pk),
            opened_at=now,
            last_act_at=now,
        )

    _notify_entry(entry, new_ids, actor=actor)
    broadcast_changeset(project.pk)
    return entry


def _assignee_pairs(task_ids: list[Any]) -> list[tuple[Any, str]]:
    """``(user_id, task_id)`` for every user-linked resource assignment, one query.

    ``TaskResource`` rather than ``Task.assignee``, for the reason
    :func:`notify_amend` gives.
    """
    from trueppm_api.apps.resources.models import TaskResource

    if not task_ids:
        return []
    return [
        (uid, str(tid))
        for uid, tid in TaskResource.objects.filter(
            task_id__in=task_ids, resource__user_id__isnull=False
        ).values_list("resource__user_id", "task_id")
    ]


def _many_body(actor_name: str, names: list[str], reason: str | None, *, downstream: bool) -> str:
    """The notice text for one recipient of one entry, however many tasks it covers."""
    text = (reason or "").strip()
    if downstream:
        what = (
            f"“{names[0] or 'Untitled'}” moved"
            if len(names) == 1
            else f"{len(names)} of your tasks moved"
        )
        head = f"{what} after {actor_name} changed a committed plan"
        return f"{head} — {text}" if text else f"{head}. No reason has been given yet."
    if len(names) == 1:
        return _amend_body(actor_name, names[0], reason)
    head = f"{actor_name} changed {len(names)} of your tasks on a committed plan"
    return f"{head} — {text}" if text else f"{head}. No reason was given."


def _rows_for_entry(
    entry: Any,
    pairs: list[tuple[Any, str]],
    *,
    exclude_user_id: Any,
    actor_name: str,
    names_by_id: dict[str, str],
    downstream: bool,
) -> list[tuple[Any, str, str, str | None]]:
    """One row per new recipient of ``entry``; records them on the entry.

    ``entry.notified_user_ids`` is the ``(entry_id, recipient)`` idempotency key
    (ADR-1477 §6): a recipient already told about this entry, directly or
    downstream, is never told again — not by an absorbed act, not by a re-stamp,
    not by a recalc re-run. The caller saves the entry.
    """
    already = {str(u) for u in entry.notified_user_ids}
    by_user: dict[Any, list[str]] = {}
    for uid, tid in pairs:
        if exclude_user_id is not None and uid == exclude_user_id:
            continue
        if str(uid) in already:
            continue
        by_user.setdefault(uid, [])
        if tid not in by_user[uid]:
            by_user[uid].append(tid)
    rows: list[tuple[Any, str, str, str | None]] = []
    for uid, tids in by_user.items():
        names = [names_by_id.get(t, "") for t in tids]
        body = _many_body(actor_name, names, entry.reason, downstream=downstream)
        rows.append((uid, "A committed plan changed", body, tids[0] if len(tids) == 1 else None))
        entry.notified_user_ids.append(uid)
    return rows


def _notify_entry(entry: Any, task_ids: list[str], *, actor: Any) -> None:
    """Tell the assignees of the newly touched tasks, once per entry (ADR-1477 §6).

    One ``TaskResource`` query and one deferred batch emit however many tasks the
    act touched, so a paste of N rows is constant in queries, and one person on
    five tasks of one bulk act gets one notice. Absorbed acts dedupe through
    ``notified_user_ids``. Answering the reason later sends nothing (D11).
    Best-effort after commit, like :func:`notify_amend`: a notification failure
    never reverts an accepted edit.
    """
    actor_id = actor.pk if actor is not None and getattr(actor, "is_authenticated", False) else None
    rows = _rows_for_entry(
        entry,
        _assignee_pairs(task_ids),
        exclude_user_id=actor_id,
        actor_name=getattr(actor, "username", "") or "Someone",
        names_by_id=dict(zip(entry.task_ids, entry.task_names, strict=False)),
        downstream=False,
    )
    if not rows:
        return
    entry.save(update_fields=["notified_user_ids"])
    _defer_amend_notifications(str(entry.project_id), rows, entry.pk)


def notify_downstream(entries: list[Any], moved: dict[Any, dict[str, str]]) -> int:
    """Tell the assignees of tasks a stamped entry re-dated (ADR-1477 §6).

    ``moved`` maps a project id to ``{task_id: name}`` for the tasks the run
    actually re-dated. The entry's own tasks are not downstream — their assignees
    were told by :func:`_notify_entry`. Runs synchronously inside the recalc's
    write transaction, so the rows commit or roll back with the stamp, but in a
    savepoint: a notification fault must never roll back a schedule. Returns the
    number of rows written.
    """
    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch

    all_ids = [tid for names in moved.values() for tid in names]
    if not entries or not all_ids:
        return 0
    pairs = _assignee_pairs(all_ids)
    written = 0
    for entry in entries:
        names_by_id = moved.get(entry.project_id) or moved.get(str(entry.project_id)) or {}
        own = set(entry.task_ids)
        down = [(u, t) for u, t in pairs if t in names_by_id and t not in own]
        rows = _rows_for_entry(
            entry,
            down,
            exclude_user_id=entry.author_id,
            actor_name=getattr(entry.author, "username", "") or "Someone",
            names_by_id=names_by_id,
            downstream=True,
        )
        if not rows:
            continue
        try:
            with transaction.atomic():
                written += create_event_notifications_batch(
                    event_type=NotificationEventType.PLAN_AMENDED,
                    project_id=str(entry.project_id),
                    rows=rows,
                )
                entry.save(update_fields=["notified_user_ids"])
        except Exception:
            logger.exception("notify_downstream: emit failed for entry %s", entry.pk)
    return written


def broadcast_changeset(project_id: Any) -> None:
    """Counts-only ``changeset_updated`` board event, after commit (ADR-1477 §5).

    Never carries reason text: the board channel reaches every subscriber, and
    reasons may name people or vendors (threat model, Information disclosure).
    """
    from trueppm_api.apps.sync.broadcast import broadcast_board_event

    from .models import ChangesetEntry

    pid = str(project_id)
    # Counted inside the writing transaction, so the numbers are what it commits.
    open_qs = ChangesetEntry.objects.filter(project_id=pid, resolved_by__isnull=True)
    open_count = open_qs.count()
    unreasoned_count = open_qs.filter(reason__isnull=True).count()
    # A literal dict at the call site, so the payload-shape scan can read it.
    # The subject is the project's changeset, so `id` is the project id.
    transaction.on_commit(
        lambda: broadcast_board_event(
            pid,
            "changeset_updated",
            {
                "id": pid,
                "project_id": pid,
                "open_count": open_count,
                "unreasoned_count": unreasoned_count,
            },
        )
    )


def retract(project_id: Any, task_ids: list[Any]) -> None:
    """Undo removes the acts from their open entries (ADR-1477 §3, D10).

    An entry emptied by the undo is deleted, reason and all. Otherwise its
    ``finish_after`` is cleared so the next recalculation re-stamps the reduced
    effect. Resolved entries are history and are never touched.
    """
    from .models import ChangesetEntry

    targets = {str(t) for t in task_ids}
    if not targets:
        return
    changed = False
    for entry in ChangesetEntry.objects.select_for_update().filter(
        project_id=project_id, resolved_by__isnull=True
    ):
        if not targets.intersection(entry.task_ids):
            continue
        changed = True
        pairs = [
            (i, n)
            for i, n in zip(entry.task_ids, entry.task_names, strict=False)
            if i not in targets
        ]
        if not pairs:
            entry.delete()
            continue
        entry.task_ids = [i for i, _ in pairs]
        entry.task_names = [n for _, n in pairs]
        entry.finish_after = None
        entry.save(update_fields=["task_ids", "task_names", "finish_after"])
    if changed:
        broadcast_changeset(project_id)


def stamp_finish_after(
    project_ids: set[Any] | list[Any],
    *,
    snapshot_at: Any = None,
    moved_tasks: list[Any] | None = None,
    float_only_ids: set[str] | None = None,
) -> list[Any]:
    """Stamp ``finish_after`` from the recalculation that follows an act (ADR-1477 §4).

    Called inside the recalc's own write transaction, after the new dates are
    persisted, for every project the run covered — including a run that re-dated
    nothing, or an act that moved no date would read "not computed" forever.
    Conditional on ``finish_after IS NULL`` so a re-run is a no-op, and on
    ``last_act_at <= snapshot_at`` (the run's input snapshot): an act that landed
    after the run read its inputs is not in this run's dates, and the recalc that
    act enqueued stamps it instead. Then tells downstream assignees (§6). Returns
    the stamped entries.
    """
    from .models import ChangesetEntry

    stamped: list[Any] = []
    for pid in project_ids:
        qs = ChangesetEntry.objects.filter(
            project_id=pid, resolved_by__isnull=True, finish_after__isnull=True
        )
        if snapshot_at is not None:
            qs = qs.filter(last_act_at__lte=snapshot_at)
        pending = list(qs.select_related("author"))
        if not pending:
            continue
        finish = current_finish(pid)
        if finish is None:
            continue
        ChangesetEntry.objects.filter(pk__in=[e.pk for e in pending]).update(finish_after=finish)
        for e in pending:
            e.finish_after = finish
        stamped.extend(pending)
    if stamped and moved_tasks:
        skip = float_only_ids or set()
        moved: dict[Any, dict[str, str]] = {}
        for t in moved_tasks:
            if str(t.pk) in skip:
                continue
            moved.setdefault(t.project_id, {})[str(t.pk)] = getattr(t, "name", "") or ""
        notify_downstream(stamped, moved)
    return stamped


def record_ids(
    project: Project,
    kind: str,
    task_ids: list[Any],
    *,
    surface: str,
    actor: Any,
    reason: str | None = None,
    new_group: bool = False,
) -> Any:
    """Record one structural act over ``task_ids`` from any write path.

    The non-request form of :func:`record_from_request`, for the paths that are
    not a DRF view with changeset hints: sync upload (``surface="sync"``) and MS
    Project import (``surface="import"``). Subtasks are dropped (#2950), and
    ``Task.objects`` includes tombstones, which a ``delete`` act needs.
    """
    from .models import Task

    if not is_amendable(project):
        return None
    ids = [t for t in task_ids if t]
    if not ids:
        return None
    rows = list(
        Task.objects.filter(pk__in=ids, project_id=project.pk, is_subtask=False).only("id", "name")
    )
    return record_structural_change(
        project,
        kind=kind,
        surface=surface,
        actor=actor,
        tasks=rows,
        reason=reason,
        new_group=new_group,
    )


def record_import(project_id: Any, task_ids: list[Any], user_id: int | None) -> Any:
    """One ``add`` entry, ``surface="import"``, for an import into an existing project.

    One import is one decision however many rows it carries, so it always opens
    its own entry. A no-op on a draft, which every freshly created project is.
    Called inside the import's transaction (MS Project, CSV, Jira).
    """
    from django.contrib.auth import get_user_model

    from .models import Project

    project = Project.objects.filter(pk=project_id).first()
    if project is None or not is_amendable(project) or not task_ids:
        return None
    actor = get_user_model().objects.filter(pk=user_id).first() if user_id else None
    return record_ids(project, "add", task_ids, surface="import", actor=actor, new_group=True)


def record_from_request(request: Any, project: Project, kind: str, task_ids: list[Any]) -> Any:
    """Record a structural act from a view, reading the request's changeset hints.

    Subtasks are dropped: a checklist item is never structural (#2950), so
    adding or deleting one is not an amendment of the plan's shape. Every
    structural route calls this, which is what ADR-1477 §7's route enumeration
    test pins.
    """
    if not is_amendable(project):
        return None
    ctx = amend_context(request)
    return record_ids(
        project,
        kind,
        task_ids,
        surface=ctx["surface"],
        actor=getattr(request, "user", None),
        reason=ctx["reason"],
        new_group=ctx["new_group"],
    )
