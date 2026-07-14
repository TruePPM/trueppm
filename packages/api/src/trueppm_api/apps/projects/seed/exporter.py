"""Export a live program to the canonical JSON seed format (ADR-0109, issue #616).

``export_program`` is the inverse of the importer: it walks a program and emits
a seed document that re-validates and re-imports. The exporter is deterministic
— arrays are emitted in a stable order and UUIDs are replaced with derived
slugs — so the round-trip ``export(import(export(p)))`` is identical to
``export(import(p))`` (the #616 guarantee). It strips every derived field
(server_version, CPM outputs, short_id) by simply never emitting them.

By default it emits **v1** (``schema_version: "1.0"``, final-state) so the #616
byte-identical round-trip is preserved unchanged. Passing ``with_events=True``
emits **v2** (ADR-0114 §7 / #1109): dates are rewritten as ``anchor``-relative
offsets and an ordered ``events`` timeline is reconstructed from the history
tables so a shared program re-imports as the *life* it lived, not a snapshot.
The v2 path is a self-consistent fixpoint — ``export→import→export`` is
byte-identical — because every reconstructed event replays to a state that
reconstructs to the same event, and the importer's synthesizer is naturally
suppressed (every task with history already carries authored status events).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Dependency,
    Label,
    Program,
    Project,
    RetroActionItem,
    Risk,
    ScopeChangeStatus,
    Sprint,
    SprintRetro,
    SprintScopeChange,
    Task,
    TaskComment,
    TaskLabel,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

_UTC = ZoneInfo("UTC")


@dataclass(order=True)
class _RawEvent:
    """A reconstructed event before serialization, sortable into replay order.

    Sort key is ``(when, target, action, seq)``: chronological, with a fully
    deterministic tiebreak so re-export is byte-identical. ``data`` (actor +
    action-specific keys) is excluded from the ordering.
    """

    when: datetime
    target: str
    action: str
    seq: int
    data: dict[str, Any] = field(compare=False, default_factory=dict)


# Signature of the ``emit`` callback the reconstruction helpers are handed.
_Emit = Callable[[datetime, str, str, dict[str, Any]], None]

# seedDate / seedTimestamp cap a relative offset at 4 digits (~27 years); a date
# further from the anchor than this falls back to an ISO literal (still a valid
# seedDate/seedTimestamp) so a very long-lived program still exports cleanly.
_MAX_REL_OFFSET_DAYS = 9999

_ROLE_NAME: dict[int, str] = {
    Role.VIEWER: "VIEWER",
    Role.MEMBER: "MEMBER",
    Role.SCHEDULER: "SCHEDULER",
    Role.ADMIN: "ADMIN",
    Role.OWNER: "OWNER",
}


def dump_seed(payload: dict[str, Any]) -> str:
    """Canonical serialization: sorted keys, 2-space indent, trailing newline.

    Centralised so the management command, the REST endpoint, and the round-trip
    test all emit byte-identical output.
    """
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "x"


class _SlugAllocator:
    """Assigns unique kebab slugs deterministically (suffix on collision)."""

    def __init__(self) -> None:
        self._used: set[str] = set()

    def take(self, text: str) -> str:
        base = _slugify(text)
        candidate = base
        i = 2
        while candidate in self._used:
            candidate = f"{base}-{i}"
            i += 1
        self._used.add(candidate)
        return candidate


def _put(target: dict[str, Any], key: str, value: Any) -> None:
    """Emit a key only when meaningful — skips None and empty strings."""
    if value is None or value == "":
        return
    target[key] = value


def export_program(program: Program, *, with_events: bool = False) -> dict[str, Any]:
    """Serialize ``program`` to a canonical seed document (a ``dict``).

    Args:
        program: the program to export.
        with_events: when ``False`` (default) emit a v1 final-state document,
            preserving the #616 byte-identical round-trip. When ``True`` emit a
            v2 document (ADR-0114 §7 / #1109) with ``anchor``-relative dates and
            a reconstructed ``events`` timeline, so the export re-imports through
            the replay engine as the program's dated life rather than a snapshot.
    """
    projects = list(
        Project.objects.filter(program=program, is_deleted=False).order_by("code", "name", "pk")
    )
    return _Exporter(program=program, projects=projects, with_events=with_events).build()


def export_project(project: Project) -> dict[str, Any]:
    """Serialize a single ``project`` to a canonical seed document (#967).

    The canonical schema requires a top-level ``program`` block (ADR-0109) but
    ``Project.program`` is nullable (ADR-0070 — standalone projects are
    first-class), so the project is emitted inside a minimal program *synthesized
    from the project itself* (slug/name/methodology). This is uniform whether or
    not the live project belongs to a program, and because the synthesized slug
    is project-derived rather than the parent program's ``code``, re-importing a
    project export creates a fresh program instead of clobbering the live parent
    program's subtree. The #616 round-trip guarantee still holds. See the #967
    addendum in ADR-0109.
    """
    return _Exporter(program=None, projects=[project], synthetic_program=project).build()


class _Exporter:
    def __init__(
        self,
        *,
        program: Program | None,
        projects: list[Project],
        synthetic_program: Project | None = None,
        with_events: bool = False,
    ) -> None:
        # ``program`` is the live parent program for a program export, or None
        # for a single-project export (#967), in which case ``synthetic_program``
        # (the project) sources the synthesized program-wrapper block.
        self.program = program
        self.synthetic_program = synthetic_program
        self.projects = projects
        # v2 event-timeline export (#1109). When on, dates become anchor-relative
        # and an ``events`` array is reconstructed from the history tables.
        self.with_events = with_events
        # The reference date for relative offsets (v2 only). The earliest project
        # start is a deterministic, always-present choice (projects require a
        # start_date), and it round-trips: re-import resolves the same absolute
        # dates, so re-export recomputes the same anchor.
        self.anchor: date = min(
            (p.start_date for p in projects if p.start_date is not None), default=date.today()
        )
        # Account identity, captured once accounts are built, so an event actor
        # always resolves to a real account slug (never a dangling ref).
        self._account_user_pks: set[Any] = set()
        self._fallback_actor_slug: str = ""
        self.project_slug = _SlugAllocator()
        self.account_slug = _SlugAllocator()
        self.calendar_slug = _SlugAllocator()
        self.resource_slug = _SlugAllocator()

        # pk -> slug maps, built once so cross-references resolve consistently.
        self.user_slugs: dict[Any, str] = {}
        self.calendar_slugs: dict[Any, str] = {}
        self.resource_slugs: dict[Any, str] = {}
        self.project_slugs: dict[Any, str] = {}
        # task pk -> (project_slug, wbs_path) for global task refs.
        self.task_ref: dict[Any, tuple[str, str]] = {}
        # sprint pk -> slug, scoped per project.
        self.sprint_slugs: dict[Any, str] = {}
        # task pk -> [label slug, …], populated per project in ``_project_block``
        # (ADR-0400 labels folded into the seed, #1958). Label slugs are
        # project-scoped, matching the slug-based (no-UUID) seed contract.
        self.task_label_slugs: dict[Any, list[str]] = {}
        # memoized — _all_resources is consulted by three blocks.
        self._resources_cache: list[Resource] | None = None

    # --- public ------------------------------------------------------------

    def build(self) -> dict[str, Any]:
        for project in self.projects:
            self.project_slugs[project.pk] = self.project_slug.take(project.code or project.name)

        # Pre-pass: index every task and sprint across ALL projects before
        # emitting any block, so cross-project dependency and risk refs resolve
        # regardless of project ordering.
        self._project_tasks: dict[Any, list[Task]] = {}
        self._project_sprints: dict[Any, list[Sprint]] = {}
        for project in self.projects:
            self._index_project(project)

        doc: dict[str, Any] = {"schema_version": "2.0" if self.with_events else "1.0"}
        if self.with_events:
            # An explicit anchor pins the offsets so re-import resolves the exact
            # same absolute dates (round-trip determinism), rather than drifting
            # to the next import day.
            doc["anchor"] = self.anchor.isoformat()
        doc["program"] = self._program_block()
        accounts = self._accounts_block()
        # Capture account identity before events so an event actor resolves to a
        # real account slug and the deterministic fallback (OWNER) is known.
        self._capture_account_identity(accounts)
        calendars = self._calendars_block()
        resources = self._resources_block()
        if accounts:
            doc["accounts"] = accounts
        if calendars:
            doc["calendars"] = calendars
        if resources:
            doc["resources"] = resources
        doc["projects"] = [self._project_block(p) for p in self.projects]
        if self.with_events:
            events = self._events_block()
            if events:
                doc["events"] = events
        return doc

    # --- top-level blocks --------------------------------------------------

    def _program_block(self) -> dict[str, Any]:
        if self.program is None:
            # Single-project export (#967): synthesize a minimal program wrapper
            # from the project so the seed satisfies the schema's required
            # ``program`` block while staying decoupled from any live parent
            # program (re-import won't clobber it). The slug is slugified to keep
            # it schema-valid (kebab-case) since Project.code is free-form.
            proj = self.synthetic_program
            assert proj is not None  # always set when self.program is None
            block: dict[str, Any] = {
                "slug": _slugify(proj.code or proj.name),
                "name": proj.name,
                "methodology": proj.methodology,
            }
            _put(block, "description", proj.description)
            return block
        block = {
            "slug": self.program.code or self.project_slug.take(self.program.name),
            "name": self.program.name,
            "methodology": self.program.methodology,
        }
        _put(block, "description", self.program.description)
        _put(block, "color", self.program.color)
        if self.program.lead_id is not None:
            block["lead"] = self._user_slug(self.program.lead)
        return block

    def _accounts_block(self) -> list[dict[str, Any]]:
        # Every user referenced anywhere in the export needs an account so it
        # re-imports. Membership roles come from ProgramMembership. A single-
        # project export (#967) has no parent program, so the roster is empty and
        # only the users the project actually references (task assignees, resource
        # accounts, risk owners) are emitted — without program-level roles.
        roles: dict[Any, int] = {}
        users: dict[Any, Any] = {}
        if self.program is not None:
            roles = {
                m.user_id: m.role for m in ProgramMembership.objects.filter(program=self.program)
            }
            if self.program.lead_id is not None:
                users[self.program.lead_id] = self.program.lead
            for m in ProgramMembership.objects.filter(program=self.program).select_related("user"):
                users[m.user_id] = m.user
        for task in self._all_tasks():
            if task.assignee_id is not None:
                users[task.assignee_id] = task.assignee
        for risk in Risk.objects.filter(project__in=self.projects).select_related("owner"):
            if risk.owner_id is not None:
                users[risk.owner_id] = risk.owner
        for res in self._all_resources():
            if res.user_id is not None:
                users[res.user_id] = res.user

        accounts = []
        for uid, user in users.items():
            slug = self._user_slug(user)
            block: dict[str, Any] = {"slug": slug, "username": user.get_username()}
            _put(block, "email", getattr(user, "email", ""))
            display = f"{user.first_name} {user.last_name}".strip()
            _put(block, "display_name", display)
            if uid in roles:
                block["role"] = _ROLE_NAME[roles[uid]]
            accounts.append(block)
        return sorted(accounts, key=lambda a: a["slug"])

    def _calendars_block(self) -> list[dict[str, Any]]:
        calendars: dict[Any, Any] = {}
        for project in self.projects:
            if project.calendar is not None:
                calendars[project.calendar.pk] = project.calendar
        for res in self._all_resources():
            if res.calendar is not None:
                calendars[res.calendar.pk] = res.calendar
        blocks = []
        for cal in calendars.values():
            slug = self._calendar_slug(cal)
            block: dict[str, Any] = {"slug": slug, "name": cal.name}
            _put(block, "working_days", cal.working_days)
            _put(block, "hours_per_day", cal.hours_per_day)
            _put(block, "timezone", cal.timezone)
            # Non-working ranges (holidays / PTO, #376). Exported as ISO literals so
            # the export→import→export fixpoint is byte-stable; ordered for
            # determinism. Forecast-snapshot history is deliberately NOT exported —
            # like SprintBurnSnapshot it is derived observational history, not
            # authored structure, so a round-trip drops it (its parameters are not
            # recoverable from the materialized rows).
            exceptions = [
                {
                    "exc_start": exc.exc_start.isoformat(),
                    "exc_end": exc.exc_end.isoformat(),
                    **({"description": exc.description} if exc.description else {}),
                }
                for exc in cal.exceptions.all().order_by("exc_start", "exc_end")
            ]
            if exceptions:
                block["exceptions"] = exceptions
            blocks.append(block)
        return sorted(blocks, key=lambda c: c["slug"])

    def _resources_block(self) -> list[dict[str, Any]]:
        blocks = []
        for res in self._all_resources():
            slug = self._resource_slug(res)
            block: dict[str, Any] = {"slug": slug, "name": res.name}
            _put(block, "email", res.email)
            _put(block, "job_role", res.job_role)
            _put(block, "max_units", float(res.max_units))
            if res.calendar_id is not None:
                block["calendar"] = self._calendar_slug(res.calendar)
            if res.user_id is not None:
                block["account"] = self._user_slug(res.user)
            blocks.append(block)
        return sorted(blocks, key=lambda r: r["slug"])

    # --- per-project -------------------------------------------------------

    def _index_project(self, project: Project) -> None:
        """Populate global task/sprint slug maps for one project (pre-pass)."""
        pslug = self.project_slugs[project.pk]
        # A task with no wbs_path (e.g. a promoted retro-action backlog item) has
        # no WBS identity and cannot be represented in a seed — the schema requires
        # a wbs_path. Exclude it from both tasks[] and the ref map so refs to it are
        # dropped rather than emitting an invalid "None" path.
        tasks = list(
            Task.objects.filter(project=project, is_deleted=False, wbs_path__isnull=False).order_by(
                "wbs_path", "pk"
            )
        )
        self._project_tasks[project.pk] = tasks
        for task in tasks:
            self.task_ref[task.pk] = (pslug, str(task.wbs_path))

        sprints = list(
            Sprint.objects.filter(project=project, is_deleted=False).order_by("start_date", "pk")
        )
        self._project_sprints[project.pk] = sprints
        sprint_alloc = _SlugAllocator()
        for sprint in sprints:
            self.sprint_slugs[sprint.pk] = sprint_alloc.take(sprint.name)

    def _project_block(self, project: Project) -> dict[str, Any]:
        pslug = self.project_slugs[project.pk]
        tasks = self._project_tasks[project.pk]
        sprints = self._project_sprints[project.pk]

        block: dict[str, Any] = {
            "slug": pslug,
            "name": project.name,
            "methodology": project.methodology,
            "start_date": self._date_str(project.start_date) if project.start_date else None,
        }
        _put(block, "description", project.description)
        _put(block, "code", project.code)
        if project.calendar_id is not None:
            block["calendar"] = self._calendar_slug(project.calendar)
        if project.default_view and project.default_view != "SCHEDULE":
            block["default_view"] = project.default_view
        if project.estimation_mode and project.estimation_mode != "open":
            block["estimation_mode"] = project.estimation_mode
        if project.agile_features:
            block["agile_features"] = True

        # Project-scoped labels (ADR-0400, #1089) folded into the seed (#1958) so a
        # re-seed round-trips board-card labels. Slugs are allocated per project
        # (deterministic, kebab-cased) and referenced by ``labels`` on each task
        # block; label identity in the seed is slug-based (no UUID), matching the
        # existing seed contract (UUID-preserving round-trip is 0.5, #1959).
        label_blocks = self._label_blocks(project)

        sprint_blocks = [self._sprint_block(s) for s in sprints]
        task_blocks = [self._task_block(t) for t in tasks]
        dep_blocks = self._dependency_blocks(project, pslug)
        baseline_blocks = self._baseline_blocks(project, pslug)
        risk_blocks = self._risk_blocks(project, pslug)
        if label_blocks:
            block["labels"] = label_blocks
        if task_blocks:
            block["tasks"] = task_blocks
        if dep_blocks:
            block["dependencies"] = dep_blocks
        if sprint_blocks:
            block["sprints"] = sprint_blocks
        if baseline_blocks:
            block["baselines"] = baseline_blocks
        if risk_blocks:
            block["risks"] = risk_blocks
        return block

    def _label_blocks(self, project: Project) -> list[dict[str, Any]]:
        """Emit the project's labels and index each task's label slugs (#1958).

        Labels are ordered by ``(position, name)`` — their stable display order —
        so the slug allocation is deterministic and the round-trip is byte-stable.
        The per-task slug list is stashed in ``self.task_label_slugs`` for
        ``_task_block`` to read; a label with no attached tasks still round-trips
        (it is a curated catalog entry, so the block is emitted regardless).
        """
        labels = list(Label.objects.filter(project=project).order_by("position", "name", "pk"))
        if not labels:
            return []
        allocator = _SlugAllocator()
        slug_by_label: dict[Any, str] = {}
        blocks: list[dict[str, Any]] = []
        for label in labels:
            slug = allocator.take(label.name)
            slug_by_label[label.pk] = slug
            block: dict[str, Any] = {"slug": slug, "name": label.name, "color": label.color}
            if label.position:
                block["position"] = label.position
            blocks.append(block)
        # Index each task's labels in (position, name) order — the pill-row order —
        # so a task's ``labels`` slug list is deterministic too.
        for tl in (
            TaskLabel.objects.filter(label__project=project)
            .select_related("label")
            .order_by("label__position", "label__name", "label__pk")
        ):
            label_slug = slug_by_label.get(tl.label_id)
            if label_slug is not None:
                self.task_label_slugs.setdefault(tl.task_id, []).append(label_slug)
        return blocks

    def _task_block(self, task: Task) -> dict[str, Any]:
        block: dict[str, Any] = {"wbs_path": str(task.wbs_path), "name": task.name}
        if task.type and task.type != "task":
            block["type"] = task.type
        if task.status and task.status != "NOT_STARTED":
            block["status"] = task.status
        if task.is_milestone:
            block["is_milestone"] = True
        if task.duration:
            block["duration"] = task.duration
        if task.planned_start is not None:
            block["planned_start"] = self._date_str(task.planned_start)
        if task.percent_complete:
            block["percent_complete"] = task.percent_complete
        _put(block, "notes", task.notes)
        _put(block, "story_points", task.story_points)
        _put(block, "remaining_points", task.remaining_points)
        if task.assignee_id is not None:
            block["assignee"] = self._user_slug(task.assignee)
        if task.sprint_id is not None:
            block["sprint"] = self.sprint_slugs[task.sprint_id]
        if task.parent_epic_id is not None and task.parent_epic_id in self.task_ref:
            block["parent_epic"] = self.task_ref[task.parent_epic_id][1]
        _put(block, "sprint_rank", task.sprint_rank)
        if task.governance_class and task.governance_class != "flow":
            block["governance_class"] = task.governance_class
        if task.delivery_mode and task.delivery_mode != "waterfall":
            block["delivery_mode"] = task.delivery_mode
        _put(block, "color", task.color)
        if task.optimistic_duration is not None:
            block["estimate"] = {
                "optimistic": task.optimistic_duration,
                "most_likely": task.most_likely_duration,
                "pessimistic": task.pessimistic_duration,
            }
        assignments = [
            {"resource": self._resource_slug(tr.resource), "units": float(tr.units)}
            for tr in TaskResource.objects.filter(task=task)
            .select_related("resource")
            .order_by("resource__name")
        ]
        if assignments:
            block["assignments"] = assignments
        label_slugs = self.task_label_slugs.get(task.pk)
        if label_slugs:
            block["labels"] = label_slugs
        return block

    def _sprint_block(self, sprint: Sprint) -> dict[str, Any]:
        block: dict[str, Any] = {
            "slug": self.sprint_slugs[sprint.pk],
            "name": sprint.name,
            "state": sprint.state,
            "start_date": self._date_str(sprint.start_date) if sprint.start_date else None,
            "finish_date": self._date_str(sprint.finish_date) if sprint.finish_date else None,
        }
        _put(block, "goal", sprint.goal)
        _put(block, "notes", sprint.notes)
        _put(block, "committed_points", sprint.committed_points)
        _put(block, "completed_points", sprint.completed_points)
        _put(block, "capacity_points", sprint.capacity_points)
        if sprint.target_milestone_id is not None and sprint.target_milestone_id in self.task_ref:
            block["target_milestone"] = self.task_ref[sprint.target_milestone_id][1]
        return block

    def _dependency_blocks(self, project: Project, pslug: str) -> list[dict[str, Any]]:
        deps = (
            Dependency.objects.filter(successor__project=project, is_deleted=False)
            .select_related("predecessor", "successor")
            .order_by("predecessor__wbs_path", "successor__wbs_path")
        )
        blocks = []
        for dep in deps:
            pred = self.task_ref.get(dep.predecessor_id)
            succ = self.task_ref.get(dep.successor_id)
            if pred is None or succ is None:
                continue
            pred_ref = pred[1] if pred[0] == pslug else f"{pred[0]}:{pred[1]}"
            block: dict[str, Any] = {
                "predecessor": pred_ref,
                "successor": succ[1],
                "dep_type": dep.dep_type,
            }
            if dep.lag:
                block["lag"] = dep.lag
            blocks.append(block)
        return blocks

    def _baseline_blocks(self, project: Project, pslug: str) -> list[dict[str, Any]]:
        blocks = []
        for baseline in Baseline.objects.filter(project=project).order_by("created_at", "pk"):
            task_rows = []
            for bt in BaselineTask.objects.filter(baseline=baseline).order_by("task_name", "pk"):
                ref = self.task_ref.get(bt.task_id)
                if ref is None:
                    continue
                row: dict[str, Any] = {"task": ref[1]}
                if bt.start is not None:
                    row["start"] = self._date_str(bt.start)
                if bt.finish is not None:
                    row["finish"] = self._date_str(bt.finish)
                _put(row, "duration", bt.duration)
                _put(row, "story_points", bt.story_points)
                task_rows.append(row)
            block: dict[str, Any] = {"name": baseline.name, "tasks": task_rows}
            if baseline.is_active:
                block["is_active"] = True
            blocks.append(block)
        return blocks

    def _risk_blocks(self, project: Project, pslug: str) -> list[dict[str, Any]]:
        blocks = []
        risks = Risk.objects.filter(project=project, is_deleted=False).order_by("title", "pk")
        slug_alloc = _SlugAllocator()
        for risk in risks:
            block: dict[str, Any] = {
                "slug": slug_alloc.take(risk.title),
                "title": risk.title,
                "status": risk.status,
                "probability": risk.probability,
                "impact": risk.impact,
            }
            _put(block, "description", risk.description)
            _put(block, "category", risk.category)
            _put(block, "response", risk.response)
            if risk.mitigation_due_date is not None:
                block["mitigation_due_date"] = self._date_str(risk.mitigation_due_date)
            _put(block, "trigger", risk.trigger)
            _put(block, "contingency", risk.contingency)
            _put(block, "notes", risk.notes)
            if risk.owner_id is not None:
                block["owner"] = self._user_slug(risk.owner)
            refs = []
            for rt in risk.tasks.through.objects.filter(risk=risk).select_related("task"):
                ref = self.task_ref.get(rt.task_id)
                if ref is None:
                    continue
                refs.append(ref[1] if ref[0] == pslug else f"{ref[0]}:{ref[1]}")
            if refs:
                block["tasks"] = sorted(refs)
            blocks.append(block)
        return blocks

    # --- v2 date + event reconstruction ------------------------------------

    def _date_str(self, d: date) -> str:
        """Emit a date: ISO literal (v1) or an ``anchor``-relative offset (v2)."""
        return self._rel_date(d) if self.with_events else d.isoformat()

    def _rel_date(self, d: date) -> str:
        """A ``seedDate`` anchor offset that lands exactly (``!`` = no snap).

        The ``!`` suffix opts out of weekend-snapping so the resolved date is
        exactly ``anchor + offset`` — essential for round-trip determinism, since
        a snapped date would drift on re-import.
        """
        offset = (d - self.anchor).days
        if abs(offset) > _MAX_REL_OFFSET_DAYS:
            return d.isoformat()
        return f"A{offset:+d}!"

    def _rel_ts(self, dt: datetime) -> str:
        """A ``seedTimestamp`` anchor offset (event time; never weekend-snapped).

        Replay builds authored event datetimes in UTC (``resolve_timestamp``
        defaults to UTC), so we normalize to UTC and emit UTC components; a
        re-import rebuilds the identical instant, closing the round-trip.
        """
        u = dt.astimezone(_UTC)
        offset = (u.date() - self.anchor).days
        if abs(offset) > _MAX_REL_OFFSET_DAYS:
            return u.replace(second=0, microsecond=0, tzinfo=None).isoformat()
        return f"A{offset:+d}T{u.hour:02d}:{u.minute:02d}"

    def _capture_account_identity(self, accounts: list[dict[str, Any]]) -> None:
        """Record which users are accounts + the deterministic fallback actor.

        Every user emitted into ``accounts[]`` has a slug in ``self.user_slugs``
        by the time this runs. The fallback actor — used when a history row is
        attributed to a user who is not (or is no longer) an account — is the
        lexically-first OWNER account, else the first account. Resolving every
        event actor to a real account keeps the emitted ``actor`` from dangling
        and makes it round-trip (replay re-attributes it, re-export reads it).
        """
        self._account_user_pks = set(self.user_slugs.keys())
        if not accounts:
            return
        owners = sorted(a["slug"] for a in accounts if a.get("role") == "OWNER")
        self._fallback_actor_slug = owners[0] if owners else accounts[0]["slug"]

    def _actor_slug(self, user: Any) -> str:
        """Resolve a history/audit user to an account slug (fallback if not one)."""
        if user is not None and user.pk in self._account_user_pks:
            return self._user_slug(user)
        return self._fallback_actor_slug

    def _events_block(self) -> list[dict[str, Any]]:
        """Reconstruct the ordered ``events`` timeline from the history tables.

        Emitted event kinds (each a clean export→import→export fixpoint):
        ``task.status`` (Task history transitions), ``task.points`` (mid-sprint
        remaining-point changes — the importer births a progressing task's
        ``remaining_points`` at ``story_points``, so a burned-down value only
        survives as an event), ``task.comment`` (``TaskComment`` rows),
        ``sprint.activate`` / ``sprint.close`` (sprint lifecycle timestamps),
        ``sprint.scope_inject`` (still-PENDING scope rows), and ``retro.action``
        (retro action items).

        Deliberately *not* reconstructed (documented fidelity gaps, not
        determinism breaks): ``task.assign`` / ``task.estimate`` / ``task.ac_met``
        (their end value is already carried by the task's final-state fields set
        at creation, so re-emitting them as events would double-apply and break
        the fixpoint); ``risk.status`` (the importer births risks at their final
        status, so a status event would be a no-op that does not survive a
        round-trip); ``sprint.scope_resolve`` and ``retro.promote`` (their target
        row's final state — task dropped from the sprint, or a wbs-less promoted
        task — cannot replay from the exported snapshot). The task's/sprint's
        *final* state is always preserved via its fields; only the intermediate
        audit rows for those specific transitions are not round-tripped.
        """
        collected: list[_RawEvent] = []
        seq = 0

        def emit(when: datetime, action: str, target: str, data: dict[str, Any]) -> None:
            nonlocal seq
            collected.append(_RawEvent(when=when, target=target, action=action, seq=seq, data=data))
            seq += 1

        for project in self.projects:
            pslug = self.project_slugs[project.pk]
            for task in self._project_tasks[project.pk]:
                self._emit_task_history(task, pslug, emit)
                self._emit_task_comments(task, pslug, emit)
            for sprint in self._project_sprints[project.pk]:
                self._emit_sprint_lifecycle(sprint, pslug, emit)
                self._emit_retro_actions(sprint, pslug, emit)
            self._emit_scope_injections(project, emit)

        # Chronological order; ties broken deterministically so re-export is
        # byte-identical. The array index is the replay tiebreak for same-instant
        # events (matching the importer's `_resolve_authored` order semantics).
        collected.sort(key=lambda e: (e.when, e.target, e.action, e.seq))
        out: list[dict[str, Any]] = []
        for e in collected:
            event: dict[str, Any] = {"at": self._rel_ts(e.when), "action": e.action}
            event.update(e.data)
            event["target"] = e.target
            out.append(event)
        return out

    def _emit_task_history(self, task: Task, pslug: str, emit: _Emit) -> None:
        """Emit ``task.status`` + ``task.points`` events from Task history.

        The earliest (creation) row establishes the base status/remaining; each
        later row is inspected for two independent changes:

        - **status** changed → ``task.status`` (from/to). Replay re-creates the
          task at NOT_STARTED and walks it forward, reproducing the same rows.
        - **remaining_points** changed *without* a status change → ``task.points``.
          A remaining change that coincides with a status change is the COMPLETE
          handler zeroing remaining_points (``_apply_task_status``), which replay
          re-applies on its own, so emitting a ``task.points`` for it would be a
          redundant, non-round-tripping write — hence the ``not status_changed``
          guard.
        """
        target = f"task:{pslug}:{task.wbs_path}"
        prev_status: str | None = None
        prev_remaining: int | None = None
        rows = task.history.select_related("history_user").order_by("history_date", "history_id")
        for row in rows:
            if prev_status is None:
                prev_status = row.status
                prev_remaining = row.remaining_points
                continue
            status_changed = row.status != prev_status
            if status_changed:
                emit(
                    row.history_date,
                    "task.status",
                    target,
                    {
                        "actor": self._actor_slug(row.history_user),
                        "from": prev_status,
                        "to": row.status,
                    },
                )
                prev_status = row.status
            if (
                not status_changed
                and row.remaining_points is not None
                and row.remaining_points != prev_remaining
            ):
                emit(
                    row.history_date,
                    "task.points",
                    target,
                    {
                        "actor": self._actor_slug(row.history_user),
                        "remaining_points": row.remaining_points,
                    },
                )
            prev_remaining = row.remaining_points

    def _emit_task_comments(self, task: Task, pslug: str, emit: _Emit) -> None:
        target = f"task:{pslug}:{task.wbs_path}"
        for c in (
            TaskComment.objects.filter(task=task)
            .select_related("author")
            .order_by("created_at", "pk")
        ):
            emit(
                c.created_at,
                "task.comment",
                target,
                {"actor": self._actor_slug(c.author), "body": c.body},
            )

    def _emit_sprint_lifecycle(self, sprint: Sprint, pslug: str, emit: _Emit) -> None:
        """Emit activate/close from the sprint's lifecycle timestamps.

        ``activated_at`` / ``closed_at`` carry the beat time; the actor is not
        persisted on the sprint, so the deterministic fallback (OWNER) is used —
        the sprint's committed/completed points ride their fields (snapshotted at
        activate/close on replay), and ``goal_outcome`` rides the close event.
        """
        target = f"sprint:{pslug}:{self.sprint_slugs[sprint.pk]}"
        if sprint.activated_at is not None:
            emit(
                sprint.activated_at,
                "sprint.activate",
                target,
                {"actor": self._fallback_actor_slug},
            )
        if sprint.closed_at is not None:
            data: dict[str, Any] = {"actor": self._fallback_actor_slug}
            if sprint.goal_outcome:
                data["goal_outcome"] = sprint.goal_outcome
            emit(sprint.closed_at, "sprint.close", target, data)

    def _emit_scope_injections(self, project: Project, emit: _Emit) -> None:
        """Emit ``sprint.scope_inject`` for still-PENDING scope-change rows.

        Only PENDING rows round-trip cleanly: the injected task is still in its
        sprint (so replay's ``_apply_scope_inject`` re-creates the audit row), and
        ``added_at`` is backdated by replay so the timestamp is stable. ACCEPTED /
        REJECTED rows are skipped — the resolve timestamp is not persisted and a
        rejected injection removed the task from its sprint.
        """
        rows = (
            SprintScopeChange.objects.filter(
                sprint__project=project, status=ScopeChangeStatus.PENDING
            )
            .select_related("task", "added_by")
            .order_by("added_at", "pk")
        )
        for sc in rows:
            ref = self.task_ref.get(sc.task_id)
            if ref is None:
                continue  # task excluded from export (e.g. no wbs_path)
            data: dict[str, Any] = {"actor": self._actor_slug(sc.added_by)}
            if sc.goal_impact:
                data["goal_impact"] = True
            emit(sc.added_at, "sprint.scope_inject", f"task:{ref[0]}:{ref[1]}", data)

    def _emit_retro_actions(self, sprint: Sprint, pslug: str, emit: _Emit) -> None:
        """Emit a ``retro.action`` per retro action item on the sprint's retro."""
        retro = SprintRetro.objects.filter(sprint=sprint).first()
        if retro is None:
            return
        target = f"sprint:{pslug}:{self.sprint_slugs[sprint.pk]}"
        actor = self._actor_slug(retro.created_by)
        for item in (
            RetroActionItem.objects.filter(retro=retro)
            .select_related("assignee")
            .order_by("created_at", "pk")
        ):
            data: dict[str, Any] = {"actor": actor, "body": item.text}
            if item.assignee_id is not None and item.assignee_id in self._account_user_pks:
                data["assignee"] = self._user_slug(item.assignee)
            if item.story_points is not None:
                data["points"] = item.story_points
            emit(item.created_at, "retro.action", target, data)

    # --- slug helpers ------------------------------------------------------

    def _user_slug(self, user: Any) -> str:
        if user.pk not in self.user_slugs:
            self.user_slugs[user.pk] = self.account_slug.take(user.get_username())
        return self.user_slugs[user.pk]

    def _calendar_slug(self, calendar: Any) -> str:
        if calendar.pk not in self.calendar_slugs:
            self.calendar_slugs[calendar.pk] = self.calendar_slug.take(calendar.name)
        return self.calendar_slugs[calendar.pk]

    def _resource_slug(self, resource: Resource) -> str:
        if resource.pk not in self.resource_slugs:
            self.resource_slugs[resource.pk] = self.resource_slug.take(resource.name)
        return self.resource_slugs[resource.pk]

    # --- collection helpers ------------------------------------------------

    def _all_tasks(self) -> list[Task]:
        return list(
            Task.objects.filter(project__in=self.projects, is_deleted=False).select_related(
                "assignee"
            )
        )

    def _all_resources(self) -> list[Resource]:
        # Resources referenced by either a task assignment or the project roster.
        if self._resources_cache is not None:
            return self._resources_cache
        ids = set(
            TaskResource.objects.filter(task__project__in=self.projects).values_list(
                "resource_id", flat=True
            )
        )
        ids |= set(
            ProjectResource.objects.filter(project__in=self.projects, is_deleted=False).values_list(
                "resource_id", flat=True
            )
        )
        self._resources_cache = list(
            Resource.objects.filter(pk__in=ids)
            .select_related("calendar", "user")
            .order_by("name", "pk")
        )
        return self._resources_cache
