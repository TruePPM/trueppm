"""Export a live program to the canonical JSON seed format (ADR-0109, issue #616).

``export_program`` is the inverse of the importer: it walks a program and emits
a seed document that re-validates and re-imports. The exporter is deterministic
— arrays are emitted in a stable order and UUIDs are replaced with derived
slugs — so the round-trip ``export(import(export(p)))`` is identical to
``export(import(p))`` (the #616 guarantee). It strips every derived field
(server_version, CPM outputs, short_id) by simply never emitting them.
"""

from __future__ import annotations

import json
import re
from typing import Any

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Dependency,
    Program,
    Project,
    Risk,
    Sprint,
    Task,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

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


def export_program(program: Program) -> dict[str, Any]:
    """Serialize ``program`` to a canonical seed document (a ``dict``)."""
    return _Exporter(program).build()


class _Exporter:
    def __init__(self, program: Program) -> None:
        self.program = program
        self.projects = list(
            Project.objects.filter(program=program, is_deleted=False).order_by("code", "name", "pk")
        )
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

        doc: dict[str, Any] = {"schema_version": "1.0"}
        doc["program"] = self._program_block()
        accounts = self._accounts_block()
        calendars = self._calendars_block()
        resources = self._resources_block()
        if accounts:
            doc["accounts"] = accounts
        if calendars:
            doc["calendars"] = calendars
        if resources:
            doc["resources"] = resources
        doc["projects"] = [self._project_block(p) for p in self.projects]
        return doc

    # --- top-level blocks --------------------------------------------------

    def _program_block(self) -> dict[str, Any]:
        block: dict[str, Any] = {
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
        # Every user referenced anywhere in the program needs an account so the
        # export re-imports. Membership roles come from ProgramMembership.
        roles = {m.user_id: m.role for m in ProgramMembership.objects.filter(program=self.program)}
        users: dict[Any, Any] = {}
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
        tasks = list(
            Task.objects.filter(project=project, is_deleted=False).order_by("wbs_path", "pk")
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
            "start_date": project.start_date.isoformat() if project.start_date else None,
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

        sprint_blocks = [self._sprint_block(s) for s in sprints]
        task_blocks = [self._task_block(t) for t in tasks]
        dep_blocks = self._dependency_blocks(project, pslug)
        baseline_blocks = self._baseline_blocks(project, pslug)
        risk_blocks = self._risk_blocks(project, pslug)
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
            block["planned_start"] = task.planned_start.isoformat()
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
        return block

    def _sprint_block(self, sprint: Sprint) -> dict[str, Any]:
        block: dict[str, Any] = {
            "slug": self.sprint_slugs[sprint.pk],
            "name": sprint.name,
            "state": sprint.state,
            "start_date": sprint.start_date.isoformat() if sprint.start_date else None,
            "finish_date": sprint.finish_date.isoformat() if sprint.finish_date else None,
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
                    row["start"] = bt.start.isoformat()
                if bt.finish is not None:
                    row["finish"] = bt.finish.isoformat()
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
                block["mitigation_due_date"] = risk.mitigation_due_date.isoformat()
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
        return list(
            Resource.objects.filter(pk__in=ids)
            .select_related("calendar", "user")
            .order_by("name", "pk")
        )
