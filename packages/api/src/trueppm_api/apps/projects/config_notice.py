"""Config-change notice: a change to the shared surface tells everyone on it (#2972).

Removing a board lane, hiding a column or a leaf surface, or switching the
methodology preset changes the surface **every assignee** works on. Before this,
only the person who clicked knew — the write broadcast ``board_config_updated``
to whoever happened to have the board open, and nothing reached anyone else.

Three properties, and the second is the one most likely to be eroded later:

1. **It fires on the consequence, not the write.** A rename, a color, a WIP limit,
   an added lane, a reorder — none of these notify. Only a change that moves or
   hides work does. A notice on every save is noise, and noise gets muted, which
   costs the signal this exists to carry.
2. **The body names what the change did to the recipient's own items.** "Board
   configuration updated" is precisely the notification this module exists to
   refuse. Each recipient's row is rendered for them, with their own count, via
   ``create_event_notifications_batch``.
3. **It reaches everyone the change re-shapes, not just the actor.** For the
   board notice that is everyone with work on the board: the union of
   ``Task.assignee`` and ``TaskResource`` over the project — see
   :func:`assigned_recipient_ids` for why it is the union and not either one
   alone — intersected with live membership. For the **surface** notice it is
   wider, because assignment is the wrong proxy for "this surface is yours":
   :func:`surface_recipient_ids` adds the ADR-0078 facet holders and everyone
   seated at ``role >= SCHEDULER`` (#3291).

Never dispatched from a refusal path. Under ``ATOMIC_REQUESTS`` DRF's exception
handler calls ``set_rollback()`` for every ``APIException``, which discards the
whole transaction *including* its ``on_commit`` callbacks — so a notice attached
to a rejected write would be silently dropped anyway. Every entry point here is
called after a successful ``save()``.
"""

from __future__ import annotations

import logging
from collections import Counter
from functools import partial
from typing import TYPE_CHECKING, Any, NamedTuple

from django.db import transaction

if TYPE_CHECKING:
    from .models import Project

logger = logging.getLogger(__name__)

#: Human labels for the four leaf surfaces (``surface_visibility.SURFACE_KEYS``).
#: Kept here rather than derived from the key so the notice reads as product copy
#: ("Monte Carlo") rather than as a column name ("monte_carlo").
SURFACE_LABELS: dict[str, str] = {
    "reporting": "Reporting",
    "time_tracking": "Time tracking",
    "baselines": "Baselines",
    "monte_carlo": "Monte Carlo",
}

#: Human labels for the methodology preset values.
METHODOLOGY_LABELS: dict[str, str] = {
    "WATERFALL": "Waterfall",
    "AGILE": "Agile",
    "HYBRID": "Hybrid",
}


# ---------------------------------------------------------------------------
# Recipients — "everyone assigned in the project"
# ---------------------------------------------------------------------------


def assigned_recipient_ids(
    project_id: Any,
    *,
    exclude_user_id: Any = None,
    live_member_ids: set[Any] | None = None,
) -> list[Any]:
    """User ids of everyone with work in ``project_id``, minus the actor.

    The board notice's cohort, and the assignment-shaped half of
    :func:`surface_recipient_ids`. A lane going away moves *cards*, so having a
    card is what makes someone a recipient — the wider surface cohort is not
    right here, because a Product Owner with no card on the board has had nothing
    moved out from under them.

    The **union** of ``Task.assignee`` and ``TaskResource.resource.user``,
    deliberately — and this is the one place in the codebase where the union is
    right rather than one or the other. ``notify_amend`` uses ``TaskResource``
    alone because it is talking about committed *load*, and a bare assignee
    carries none. This is about the board a person works on, and a bare assignee
    looks at exactly the same board as a resourced one; using ``TaskResource``
    alone would silently tell nobody in a project imported from Jira (which
    writes neither) or seeded from a template (assignees, no assignments).

    Intersected with live ``ProjectMembership`` (``is_deleted=False``): an inbox
    row about a project the recipient can no longer open is a dead link, and
    naming a project's internal structure to a removed member is a scope leak
    (ADR-0104's back-door close — a non-member sits below every tier).

    ``live_member_ids`` lets a caller that has already read the project's live
    membership pass it in rather than making this run the same filter a second
    time — :func:`surface_recipient_ids` needs the full ``(user_id, role)`` map
    for its own cohorts, and that map is a strict superset of the answer this
    liveness check would compute for itself. Defaulted to ``None`` so the board
    call site stays self-contained.
    """
    from trueppm_api.apps.access.models import ProjectMembership
    from trueppm_api.apps.resources.models import TaskResource

    from .models import Task

    # `.distinct()` matters here: without it Postgres streams one row per TASK to
    # build a set of maybe thirty user ids, so a 10k-task project pulls 10k UUIDs
    # over the wire twice. The de-dupe belongs in the database.
    tasks = Task.objects.filter(project_id=project_id, is_deleted=False)
    candidates: set[Any] = set(
        tasks.exclude(assignee_id=None).values_list("assignee_id", flat=True).distinct()
    )
    candidates |= set(
        TaskResource.objects.filter(task__project_id=project_id, task__is_deleted=False)
        .exclude(resource__user__isnull=True)
        .values_list("resource__user_id", flat=True)
        .distinct()
    )
    candidates.discard(None)
    if exclude_user_id is not None:
        candidates.discard(exclude_user_id)
    if not candidates:
        return []

    live_members = (
        live_member_ids
        if live_member_ids is not None
        else set(
            ProjectMembership.objects.filter(
                project_id=project_id, is_deleted=False, user_id__in=candidates
            ).values_list("user_id", flat=True)
        )
    )
    return sorted(candidates & live_members, key=str)


def surface_recipient_ids(project_id: Any, *, exclude_user_id: Any = None) -> list[Any]:
    """User ids of everyone a surface change re-shapes in ``project_id``, minus the actor.

    Three cohorts, unioned:

    1. everyone with work in the project — :func:`assigned_recipient_ids`;
    2. the ADR-0078 Scrum Master and Product Owner facet holders;
    3. ``ProjectMembership`` rows at ``role >= Role.SCHEDULER``.

    Assignment alone is the wrong proxy for "this surface is yours" (#3291). A
    Product Owner authors and prioritizes the backlog and is frequently assigned
    none of it; a Scrum Master facilitates and is neither an assignee nor a booked
    resource; a PM who owns the plan routinely assigns none of it to themselves.
    Those are the three people a preset flip re-shapes hardest, and the ones
    everyone else asks to explain it — and the assigned-only cohort excluded
    exactly them. Same class as #2897 at a new sink, which is why the facet half
    reads :func:`~trueppm_api.apps.teams.services.facet_holder_user_ids` — the
    scope gate's own source — rather than reimplementing the team lookup here.

    The two sinks are ``ProjectViewSet.perform_update`` (gated ``IsProjectScheduler``)
    and the program bulk matrix (gated ``IsProgramAdmin`` — a program-level gate with
    no project-role correspondence at all). ``role >= SCHEDULER`` therefore sits *at
    or below* the write gate on both paths rather than mirroring either, and the
    threshold is justified by **read** parity, not write parity: ``show_*`` and
    ``effective_surface_visibility`` are already readable by any project member
    (Viewer+), so telling a Scheduler discloses nothing they could not fetch
    themselves. Note the cohort is deliberately not role-monotone — the facet arm
    notifies Member- and Viewer-seated holders, per ADR-0078 and #2897.

    **Every cohort is intersected with live ``ProjectMembership``**, and the facet
    half genuinely needs it: the ADR-0078 §F mirror only ever *creates* team rows
    (:mod:`trueppm_api.apps.teams.signals` has no ``post_delete`` receiver and
    ``TeamMembership`` has no FK a cascade could travel), so soft-deleting a
    ``ProjectMembership`` leaves the mirrored ``TeamMembership`` live with its
    facet flags intact. Without the intersection, widening the cohort would widen
    who keeps being told a project's internal structure after losing access — a
    dead link and a scope leak (ADR-0104's back-door close: a non-member sits
    below every tier).

    The sibling facet cohorts do **not** yet apply this intersection and leak on
    exactly that path — :func:`~trueppm_api.apps.projects.services._sprint_lead_recipient_ids`
    and :func:`~trueppm_api.apps.projects.blocker_services.resolve_impediment_recipients`,
    tracked in #3334. Copy this function, not those two.

    One membership read serves all three cohorts: the ``(user_id, role)`` map is
    the Scheduler+ set, the facet arm's liveness floor, **and** the liveness floor
    :func:`assigned_recipient_ids` would otherwise query for itself — which is why
    it is threaded in rather than letting that call repeat the same filter.

    The actor is discarded **after** the union, not before it, and that order is
    load-bearing: the actor of a surface change is Scheduler+ on the
    ``perform_update`` path essentially by definition, so the Scheduler arm re-adds
    them on every flip. This final ``discard`` is the only thing standing between a
    PM and a notice about their own click.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.teams.services import facet_holder_user_ids

    live_roles: dict[Any, int] = dict(
        ProjectMembership.objects.filter(project_id=project_id, is_deleted=False).values_list(
            "user_id", "role"
        )
    )
    live_ids = set(live_roles)

    recipients = set(
        assigned_recipient_ids(
            project_id, exclude_user_id=exclude_user_id, live_member_ids=live_ids
        )
    )
    recipients |= {uid for uid, role in live_roles.items() if role >= Role.SCHEDULER}
    recipients |= facet_holder_user_ids(project_id) & live_ids

    recipients.discard(None)
    if exclude_user_id is not None:
        recipients.discard(exclude_user_id)
    return sorted(recipients, key=str)


def _counts_by_user(project_id: Any, task_filter: Any) -> Counter[Any]:
    """Per-user count of the affected tasks in ``project_id``.

    Two **grouped** queries, and no per-task rows materialized in Python. The
    surface path passes a bare ``Q()`` — every task in the project — so pulling
    ``(user, task)`` pairs back to de-duplicate them would build a set
    proportional to the whole task table on a project that could have tens of
    thousands of rows, to produce a handful of integers.

    A task the same user both owns and is booked on must count **once**, which is
    what the ``F("task__assignee_id")`` exclusion does: the assignee side counts
    every owned task, and the resource side counts only the ones the counter does
    not already own. ``distinct=True`` belongs on the **resource** arm only, where
    a user booked twice on one task through two resource rows would otherwise
    count twice; the assignee arm groups by ``assignee_id`` over a join-free
    queryset, so its ``id`` is already unique per group.
    """
    from django.db.models import Count, F

    from trueppm_api.apps.resources.models import TaskResource

    from .models import Task

    affected = Task.objects.filter(project_id=project_id, is_deleted=False).filter(task_filter)
    counts: Counter[Any] = Counter()
    for uid, n in (
        affected.exclude(assignee_id=None)
        .values("assignee_id")
        .annotate(n=Count("id"))
        .values_list("assignee_id", "n")
    ):
        counts[uid] += n
    for uid, n in (
        TaskResource.objects.filter(task__in=affected)
        .exclude(resource__user__isnull=True)
        .exclude(resource__user_id=F("task__assignee_id"))
        .values("resource__user_id")
        .annotate(n=Count("task_id", distinct=True))
        .values_list("resource__user_id", "n")
    ):
        counts[uid] += n
    return counts


def _actor_name(actor: Any) -> str:
    """Display name for the person who made the change, or a neutral stand-in."""
    if actor is None or not getattr(actor, "is_authenticated", False):
        return "Someone"
    return (
        getattr(actor, "get_full_name", lambda: "")() or getattr(actor, "username", "") or "Someone"
    )


def _actor_id(actor: Any) -> Any:
    return actor.pk if actor is not None and getattr(actor, "is_authenticated", False) else None


def _plural(count: int, singular: str = "item", plural: str = "items") -> str:
    return f"{count} {singular if count == 1 else plural}"


# ---------------------------------------------------------------------------
# Board configuration — lanes removed, columns hidden
# ---------------------------------------------------------------------------


class _RemovedLane(NamedTuple):
    key: str
    label: str
    column_label: str
    destination: str


class _HiddenColumn(NamedTuple):
    status: str
    label: str


def _column_label(column: dict[str, Any]) -> str:
    return str(column.get("label") or column.get("status") or "this column")


def _first_lane_label(column: dict[str, Any] | None) -> str:
    """Where an orphaned lane key lands, said in words.

    ``Task.board_lane`` is never rewritten when a lane is deleted (a bulk UPDATE
    would bypass the ``server_version`` bump every synced write depends on), so
    the board resolves a dangling key to the column's **first** lane on read. The
    notice must name the same destination the board will actually show, or it
    describes a move that did not happen.
    """
    if column is None:
        return "its column"
    lanes = column.get("lanes") or []
    if lanes:
        first = lanes[0]
        return str(first.get("label") or first.get("key") or "the first lane")
    # No lanes left at all: the column renders as one implicit lane, i.e. itself.
    return _column_label(column)


def _removed_lanes(
    old_by_status: dict[str, dict[str, Any]],
    new_by_status: dict[str, dict[str, Any]],
) -> list[_RemovedLane]:
    """Lanes that existed before the write and do not survive it.

    Each one carries the destination its orphaned cards will resolve to, read
    from the *new* column — see :func:`_first_lane_label`.
    """
    removed: list[_RemovedLane] = []
    for status, old_col in old_by_status.items():
        new_col = new_by_status.get(status)
        surviving = {str(lane.get("key")) for lane in (new_col or {}).get("lanes") or []}
        for lane in old_col.get("lanes") or []:
            key = str(lane.get("key"))
            if key in surviving:
                continue
            removed.append(
                _RemovedLane(
                    key=key,
                    label=str(lane.get("label") or key),
                    column_label=_column_label(new_col or old_col),
                    destination=_first_lane_label(new_col),
                )
            )
    return removed


def _hidden_columns(
    old_by_status: dict[str, dict[str, Any]],
    new_by_status: dict[str, dict[str, Any]],
) -> list[_HiddenColumn]:
    """Columns that were visible before the write and are not after it."""
    hidden: list[_HiddenColumn] = []
    for status, old_col in old_by_status.items():
        new_col = new_by_status.get(status)
        was_visible = old_col.get("visible", True)
        # A column dropped from the payload entirely cannot happen (the serializer
        # requires all five canonical statuses), but treat absence as hidden
        # rather than as "unchanged" so the notice can never under-report.
        now_visible = new_col.get("visible", True) if new_col is not None else False
        if was_visible and not now_visible:
            hidden.append(_HiddenColumn(status=status, label=_column_label(new_col or old_col)))
    return hidden


def diff_board_config(
    old_columns: list[dict[str, Any]], new_columns: list[dict[str, Any]]
) -> tuple[list[_RemovedLane], list[_HiddenColumn]]:
    """The two board changes that move or hide work.

    Everything else a board-config PUT can carry — rename, reorder, recolor, a
    WIP-limit change, an *added* lane, a column being *un*-hidden — leaves every
    card exactly where the person who owns it last saw it, and produces no
    notice. Returning the pair (rather than a bool) is what lets the body name
    the specific lane and column instead of the fact that a PUT happened.
    """
    new_by_status = {str(c.get("status")): c for c in new_columns}
    old_by_status = {str(c.get("status")): c for c in old_columns}
    return (
        _removed_lanes(old_by_status, new_by_status),
        _hidden_columns(old_by_status, new_by_status),
    )


def _removed_clause(actor_name: str, removed: list[_RemovedLane], lane_count: int) -> str:
    """The removed-lane sentence pair, or ``""`` when no lane was removed.

    Every destination is named against the lane it belongs to. Removing two lanes
    from two different columns sends their cards to two *different* first lanes,
    so a single destination borrowed from ``removed[0]`` would send most of the
    recipient to the wrong place — which is worse than saying nothing, because
    they will look there, not find their work, and stop trusting the next notice.
    """
    if not removed:
        return ""
    if len(removed) == 1:
        lane = removed[0]
        lead = f"{actor_name} removed the “{lane.label}” lane from {lane.column_label}."
        tail = (
            f"Your {_plural(lane_count)} in there now "
            f"{'shows' if lane_count == 1 else 'show'} in “{lane.destination}” — "
            f"the first lane of that column."
            if lane_count
            else "None of your items were in it."
        )
    else:
        moves = _join_phrases(
            [
                f"“{lane.label}” from {lane.column_label} (cards move to “{lane.destination}”)"
                for lane in removed
            ]
        )
        lead = f"{actor_name} removed {len(removed)} lanes: {moves}."
        tail = (
            f"{lane_count} of those items {'is' if lane_count == 1 else 'are'} yours."
            if lane_count
            else "None of your items were in them."
        )
    return f"{lead} {tail}"


def _hidden_clause(actor_name: str, hidden: list[_HiddenColumn], column_count: int) -> str:
    """The hidden-column sentence pair, or ``""`` when no column was hidden."""
    if not hidden:
        return ""
    names = _join_phrases([f"“{col.label}”" for col in hidden])
    noun = "column" if len(hidden) == 1 else "columns"
    lead = f"{actor_name} hid the {names} {noun}."
    if column_count:
        # NOT "reach them from My Work": `/me/work/` filters on `assignee` alone
        # and excludes BACKLOG, so that instruction is false for anyone counted
        # through a TaskResource booking, and false for everyone when the hidden
        # column is Backlog. A notice that sends the reader somewhere their work
        # is not is the failure this whole module is written to avoid — so it
        # names the two surfaces that show every status and both assignment kinds.
        it_them = "it" if column_count == 1 else "them"
        return (
            f"{lead} Your {_plural(column_count)} with that status "
            f"{'keeps its' if column_count == 1 else 'keep their'} status and dates, "
            f"but the board no longer shows {it_them} — find {it_them} in the "
            f"task list or search."
        )
    return f"{lead} None of your items have that status."


def _board_body(
    actor_name: str,
    removed: list[_RemovedLane],
    hidden: list[_HiddenColumn],
    lane_count: int,
    column_count: int,
) -> str:
    """One recipient's copy of the board notice."""
    parts = [
        _removed_clause(actor_name, removed, lane_count),
        _hidden_clause(actor_name, hidden, column_count),
    ]
    return " ".join(part for part in parts if part)


def _join_phrases(phrases: list[str]) -> str:
    """``a``, ``a and b``, ``a, b and c`` — an Oxford-comma-free serial list."""
    if len(phrases) == 1:
        return phrases[0]
    return f"{', '.join(phrases[:-1])} and {phrases[-1]}"


def _board_subject(removed: list[_RemovedLane], hidden: list[_HiddenColumn], affected: int) -> str:
    """A subject that already carries the consequence.

    The inbox row previews the body, but the subject is what a recipient scanning
    a full bell sees first — so it states what happened to *them*, not that a
    configuration changed.
    """
    if removed and hidden:
        return (
            f"Your board was reconfigured — {_plural(affected)} affected"
            if affected
            else "Your board was reconfigured"
        )
    if removed:
        what = (
            "A board lane was removed"
            if len(removed) == 1
            else f"{len(removed)} board lanes were removed"
        )
        return f"{what} — {_plural(affected)} moved" if affected else what
    what = (
        "A board column was hidden"
        if len(hidden) == 1
        else f"{len(hidden)} board columns were hidden"
    )
    return f"{what} — {_plural(affected)} no longer on the board" if affected else what


def notify_board_config_change(
    project: Project,
    *,
    old_columns: list[dict[str, Any]],
    new_columns: list[dict[str, Any]],
    actor: Any,
) -> None:
    """Tell everyone with work in ``project`` that a lane or column went away.

    Deferred to ``transaction.on_commit`` and best-effort: a notification failure
    must never revert a board configuration the caller has already accepted.

    **Every read the notice depends on happens inside the deferred callback** —
    the recipient set as well as the counts. Resolving recipients here instead
    would run three queries while the caller still holds its write locks, and
    would pair a pre-commit recipient list with post-commit counts, so a person
    whose assignment changed in the window could get a row whose count describes
    a different moment than the list that selected them.
    """
    removed, hidden = diff_board_config(old_columns, new_columns)
    if not removed and not hidden:
        return

    transaction.on_commit(
        partial(
            _emit_board_notifications,
            str(project.pk),
            _actor_id(actor),
            removed,
            hidden,
            _actor_name(actor),
        )
    )


def _emit_board_notifications(
    project_id: str,
    actor_id: Any,
    removed: list[_RemovedLane],
    hidden: list[_HiddenColumn],
    actor_name: str,
) -> None:
    from django.db.models import Q

    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch

    try:
        recipient_ids = assigned_recipient_ids(project_id, exclude_user_id=actor_id)
        if not recipient_ids:
            return

        lane_counts: Counter[Any] = Counter()
        if removed:
            lane_counts = _counts_by_user(
                project_id, Q(board_lane__in=[lane.key for lane in removed])
            )
        column_counts: Counter[Any] = Counter()
        if hidden:
            column_counts = _counts_by_user(
                project_id, Q(status__in=[col.status for col in hidden])
            )

        rows = []
        for rid in recipient_ids:
            lane_n = lane_counts.get(rid, 0)
            column_n = column_counts.get(rid, 0)
            rows.append(
                (
                    rid,
                    _board_subject(removed, hidden, lane_n + column_n),
                    _board_body(actor_name, removed, hidden, lane_n, column_n),
                    None,
                )
            )
        create_event_notifications_batch(
            event_type=NotificationEventType.PROJECT_CONFIG_CHANGED,
            project_id=project_id,
            rows=rows,
        )
    except Exception:
        logger.exception("notify_board_config_change: emit failed for project %s", project_id)


# ---------------------------------------------------------------------------
# Project preset and leaf-surface visibility
# ---------------------------------------------------------------------------


class ProjectSurfaceSnapshot(NamedTuple):
    """The project's surface as it stood before a write.

    Captured rather than re-read because ``serializer.save()`` mutates the
    instance in place — after it, the previous preset is unrecoverable.
    """

    methodology: str
    visibility: dict[str, bool]


def capture_project_surface(project: Project, *, workspace: Any = None) -> ProjectSurfaceSnapshot:
    """Snapshot ``project``'s preset and effective leaf-surface visibility."""
    from .surface_visibility import resolve_effective_visibility

    return ProjectSurfaceSnapshot(
        methodology=str(project.methodology or ""),
        visibility=resolve_effective_visibility(project, workspace=workspace),
    )


def _is_are(count: int) -> str:
    return "is" if count == 1 else "are"


def _attribution_clauses(
    actor_name: str,
    before: ProjectSurfaceSnapshot,
    after: ProjectSurfaceSnapshot,
) -> list[str]:
    """The preset clause and the surface clauses, in that order.

    The actor is named exactly once, and which clause names them is load-bearing
    — which is why both sides of the preset-vs-override split live in this one
    function rather than in two. A preset switch is the deliberate act and the
    surface changes fall out of it, so the preset clause is attributed and the
    surfaces are stated as consequence: writing "Dana hid Baselines" for a flip
    Dana never made surface-by-surface would attribute a decision to them that
    they did not take. When there is no preset change the override IS the
    deliberate act, so it takes the attribution.
    """
    parts: list[str] = []
    hidden = [k for k, v in after.visibility.items() if before.visibility.get(k) and not v]
    shown = [k for k, v in after.visibility.items() if v and not before.visibility.get(k, False)]

    if before.methodology != after.methodology:
        old_label = METHODOLOGY_LABELS.get(before.methodology, before.methodology or "none")
        new_label = METHODOLOGY_LABELS.get(after.methodology, after.methodology)
        parts.append(
            f"{actor_name} switched this project's planning preset from {old_label} to {new_label}."
        )
        if hidden:
            parts.append(f"{_join_labels(hidden)} {_is_are(len(hidden))} no longer shown here.")
        if shown:
            parts.append(f"{_join_labels(shown)} {_is_are(len(shown))} now shown.")
    else:
        if hidden:
            parts.append(f"{actor_name} hid {_join_labels(hidden)} in this project.")
        if shown:
            parts.append(f"{actor_name} turned {_join_labels(shown)} back on in this project.")
    return parts


def _ownership_clause(item_count: int) -> str:
    """The closing clause, which always speaks to the recipient's own items.

    The zero branch is load-bearing rather than an edge case: once the cohort
    includes facet holders and Scheduler+ members (:func:`surface_recipient_ids`),
    a recipient owning nothing is the *normal* case for a PO or Scrum Master, not
    a rarity. It stays a sentence rather than an omission because a dropped clause
    reads as an unstated many.
    """
    if item_count:
        keeps = "keeps its" if item_count == 1 else "keep their"
        return (
            f"Your {_plural(item_count)} {keeps} status, dates and assignments — "
            f"what changed is where you find "
            f"{'it' if item_count == 1 else 'them'}."
        )
    return "Nothing you own moved."


def _surface_body(
    actor_name: str,
    before: ProjectSurfaceSnapshot,
    after: ProjectSurfaceSnapshot,
    item_count: int,
) -> str:
    """One recipient's copy of the preset / views notice.

    Every clause is grounded in a value the server computed: the two preset
    labels, and the surfaces whose *effective* visibility actually flipped. It
    does not claim anything about which chrome the web client chooses to render
    for a preset — a notice that over-claims is worse than a terse one, because
    the recipient checks it once and stops believing the next one.
    """
    parts = _attribution_clauses(actor_name, before, after)
    parts.append(_ownership_clause(item_count))
    return " ".join(parts)


def _join_labels(keys: list[str]) -> str:
    return _join_phrases([SURFACE_LABELS.get(k, k) for k in keys])


def _surface_subject(before: ProjectSurfaceSnapshot, after: ProjectSurfaceSnapshot) -> str:
    if before.methodology != after.methodology:
        new_label = METHODOLOGY_LABELS.get(after.methodology, after.methodology)
        return f"This project now runs as {new_label}"
    return "The views in this project changed"


class SurfaceChange(NamedTuple):
    """One project's before/after, ready to render once the transaction commits."""

    project_id: str
    before: ProjectSurfaceSnapshot
    after: ProjectSurfaceSnapshot


def collect_project_surface_change(
    project: Project,
    *,
    before: ProjectSurfaceSnapshot,
    workspace: Any = None,
) -> SurfaceChange | None:
    """``SurfaceChange`` if this project's surface actually moved, else ``None``.

    Split out from :func:`notify_project_surface_change` so the bulk settings
    matrix — which applies one field map to as many as ``MAX_BULK_TARGETS``
    projects — can register **one** ``on_commit`` callback for the whole batch
    rather than one per project. Two hundred separate callbacks would each run
    their own recipient and count queries inline in the request/response cycle.

    Returns ``None`` when the preset is unchanged and every leaf surface's
    **effective** visibility is unchanged — so writing an explicit override equal
    to the value the project already resolved to notifies nobody, which is right:
    nothing on screen moved.
    """
    after = capture_project_surface(project, workspace=workspace)
    if before.methodology == after.methodology and before.visibility == after.visibility:
        return None
    return SurfaceChange(project_id=str(project.pk), before=before, after=after)


def notify_project_surface_change(
    project: Project,
    *,
    before: ProjectSurfaceSnapshot,
    actor: Any,
    workspace: Any = None,
) -> None:
    """Tell everyone this project's surface belongs to that its preset or views moved.

    The cohort is :func:`surface_recipient_ids` — wider than the board notice's,
    because a preset flip re-shapes the working surface of people who hold no
    assigned task.
    """
    change = collect_project_surface_change(project, before=before, workspace=workspace)
    if change is None:
        return
    notify_surface_changes([change], actor=actor)


def notify_surface_changes(changes: list[SurfaceChange], *, actor: Any) -> None:
    """Defer one emit for every project whose surface moved in this transaction."""
    if not changes:
        return
    transaction.on_commit(
        partial(_emit_surface_notifications, changes, _actor_id(actor), _actor_name(actor))
    )


def _emit_surface_notifications(
    changes: list[SurfaceChange],
    actor_id: Any,
    actor_name: str,
) -> None:
    from django.db.models import Q

    from trueppm_api.apps.notifications.models import NotificationEventType
    from trueppm_api.apps.notifications.services import create_event_notifications_batch

    for change in changes:
        # Per project, not per batch: one project's failure must not swallow the
        # notices for the others in a bulk apply.
        try:
            recipient_ids = surface_recipient_ids(change.project_id, exclude_user_id=actor_id)
            if not recipient_ids:
                continue
            counts = _counts_by_user(change.project_id, Q())
            subject = _surface_subject(change.before, change.after)
            rows = [
                (
                    rid,
                    subject,
                    _surface_body(actor_name, change.before, change.after, counts.get(rid, 0)),
                    None,
                )
                for rid in recipient_ids
            ]
            create_event_notifications_batch(
                event_type=NotificationEventType.PROJECT_CONFIG_CHANGED,
                project_id=change.project_id,
                rows=rows,
            )
        except Exception:
            logger.exception(
                "notify_project_surface_change: emit failed for project %s", change.project_id
            )
