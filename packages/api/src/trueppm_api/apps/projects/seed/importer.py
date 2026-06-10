"""Import a canonical JSON seed document into the database (ADR-0109, issue #615).

``import_seed`` validates a payload (#614) and then materializes one program,
its projects, tasks, dependencies, sprints, baselines, risks, resources, and
memberships inside a single transaction. File-local slugs and ltree wbs paths
are resolved to freshly-minted UUIDs through in-memory symbol tables; nothing in
the seed file carries a UUID.

Re-import is idempotent on the program slug (persisted in ``Program.code``): a
matching live program's subtree is hard-deleted and rebuilt. Sample data is
disposable (ADR-0109), so wipe-then-recreate — the ADR-0092 precedent — is the
right idempotency model here rather than a field-level merge.

The seeded tasks carry no CPM outputs (those are derived), so a schedule
recalculation is enqueued per project after commit; a board broadcast is
likewise deferred to ``transaction.on_commit``.
"""

from __future__ import annotations

import logging
from datetime import date
from functools import partial
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Dependency,
    EstimateStatus,
    Program,
    Project,
    Risk,
    RiskTask,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.seed.validation import validate_seed
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.services import ensure_project_resource
from trueppm_api.apps.scheduling.services import enqueue_recalculate
from trueppm_api.apps.sync.broadcast import broadcast_board_event

logger = logging.getLogger(__name__)

User = get_user_model()

# Program membership role names in the seed map to the Role integer ladder.
_ROLE_BY_NAME = {
    "VIEWER": Role.VIEWER,
    "MEMBER": Role.MEMBER,
    "SCHEDULER": Role.SCHEDULER,
    "ADMIN": Role.ADMIN,
    "OWNER": Role.OWNER,
}


def import_seed(
    payload: dict[str, Any],
    *,
    owner: Any,
    create_users: bool = False,
    is_sample: bool = False,
) -> Program:
    """Validate and import a seed document, returning the created ``Program``.

    Args:
        payload: a parsed seed document (already JSON-decoded).
        owner: the ``User`` who owns the imported program (gets OWNER membership).
        create_users: when ``True``, ``accounts[]`` that name no existing user
            are created (used by ``make seed`` / the management command). When
            ``False`` (the REST default), missing accounts resolve to ``None`` —
            importing a seed must not silently mint logins on a live instance.
        is_sample: when ``True`` this is the disposable demo/sample path
            (``load_sample``). It marks every created project ``is_sample`` and
            reuses the shared persona resource catalog. When ``False`` (the
            generic ``import_seed`` path) imported resources are created fresh so
            a seed can never bind a pre-existing global resource — and the real
            user it may carry — into the importer's program (#1004).

    Raises:
        SeedValidationError: if the payload fails validation; nothing is written.
    """
    validate_seed(payload)
    importer = _SeedImporter(payload, owner=owner, create_users=create_users, is_sample=is_sample)
    with transaction.atomic():
        program = importer.run()
    return program


def _parse_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _req_date(value: str) -> date:
    """Parse a schema-required date (validation guarantees it is present)."""
    return date.fromisoformat(value)


class _SeedImporter:
    """Holds the per-import symbol tables while materializing a seed document."""

    def __init__(
        self,
        payload: dict[str, Any],
        *,
        owner: Any,
        create_users: bool,
        is_sample: bool = False,
    ) -> None:
        self.payload = payload
        self.owner = owner
        self.create_users = create_users
        self.is_sample = is_sample
        self.users: dict[str, Any] = {}
        self.calendars: dict[str, Calendar] = {}
        self.resources: dict[str, Resource] = {}
        self.projects: dict[str, Project] = {}
        # global task / sprint indices keyed by (project_slug, local_id)
        self.tasks: dict[tuple[str, str], Task] = {}
        self.sprints: dict[tuple[str, str], Sprint] = {}

    def run(self) -> Program:
        self._replace_existing()
        self._resolve_accounts()
        self._resolve_calendars()
        self._resolve_resources()
        program = self._create_program()

        # Pass A: create each project's structure (sprints, tasks). This fills
        # the global task/sprint indices so Pass B can resolve cross-project
        # references and links that may point anywhere in the program.
        for project_data in self.payload["projects"]:
            self._create_project_structure(program, project_data)

        # Pass B: wire links that may reference tasks created in any project.
        for project_data in self.payload["projects"]:
            project = self.projects[project_data["slug"]]
            self._link_dependencies(project, project_data)
            self._link_parent_epics(project_data)
            self._link_sprint_milestones(project_data)
            self._assign_resources(project, project_data)
            self._capture_baselines(project, project_data)
            self._create_risks(project, project_data.get("risks", []), project_data["slug"])

        self._create_program_risks(program)

        project_ids = [str(p.pk) for p in self.projects.values()]
        # Seeded tasks have no CPM dates; recompute so the schedule renders.
        # Both effects are deferred to post-commit so they never fire on a
        # rolled-back import.
        for pid in project_ids:
            transaction.on_commit(partial(enqueue_recalculate, project_id=pid))
            transaction.on_commit(
                partial(broadcast_board_event, pid, "project_created", {"id": pid})
            )
        return program

    # --- idempotency -------------------------------------------------------

    def _replace_existing(self) -> None:
        """Hard-delete a prior import the caller owns that holds this seed's slug.

        Idempotent re-import rebuilds the *caller's own* program with this slug
        (keyed on ``Program.code``, which carries it). The replace is scoped to
        programs the importing ``owner`` holds an OWNER ``ProgramMembership`` on,
        so an import can never delete another user's program that merely shares a
        code — ``Program.code`` is user-assigned and non-unique, so collisions
        are realistic and enumerable (#994). Without this scope any authenticated
        user could hard-delete (no tombstone) a victim program plus every child
        project/task/sprint/risk/baseline by crafting a seed whose ``slug``
        matches the victim's code.

        On the demo/sample path (``is_sample``) the guard is tightened to match
        the ``remove_sample`` invariant: a program containing any real
        (non-sample) project is never replaced, so a sample reload can never
        purge real work even within the caller's own programs.
        """
        slug = self.payload["program"]["slug"]
        owned_program_ids = ProgramMembership.objects.filter(
            user=self.owner, role=Role.OWNER, is_deleted=False
        ).values_list("program_id", flat=True)
        # select_for_update locks each candidate row so a concurrent member-add /
        # project-assign can't resurrect a PROTECTed reference mid-teardown
        # (mirrors remove_sample's lock in program_views.py).
        candidates = Program.objects.select_for_update().filter(
            code=slug, is_deleted=False, pk__in=owned_program_ids
        )
        for prog in candidates:
            if self.is_sample:
                has_real_project = Project.objects.filter(
                    program=prog, is_sample=False, is_deleted=False
                ).exists()
                if has_real_project:
                    # Refuse a partial/destructive delete of a mixed program.
                    continue
            project_ids = list(Project.objects.filter(program=prog).values_list("pk", flat=True))
            # ProjectMembership.project is PROTECTed, so memberships must go
            # before the projects they guard; the project delete then cascades
            # tasks/deps/sprints/risks/baselines.
            ProjectMembership.objects.filter(project_id__in=project_ids).delete()
            Project.objects.filter(pk__in=project_ids).delete()
            ProgramMembership.objects.filter(program=prog).delete()
            Program.objects.filter(pk=prog.pk).delete()

    # --- top-level entities ------------------------------------------------

    def _resolve_accounts(self) -> None:
        for account in self.payload.get("accounts", []):
            username = account["username"]
            user = User.objects.filter(username=username).first()
            if user is None and self.create_users:
                user = User.objects.create_user(
                    username=username,
                    email=account.get("email", ""),
                    first_name=account.get("display_name", "").split(" ")[0],
                )
            self.users[account["slug"]] = user

    def _resolve_calendars(self) -> None:
        for cal in self.payload.get("calendars", []):
            obj, _ = Calendar.objects.get_or_create(
                name=cal["name"],
                defaults={
                    "working_days": cal.get("working_days", 31),
                    "hours_per_day": cal.get("hours_per_day", 8.0),
                    "timezone": cal.get("timezone", "UTC"),
                },
            )
            self.calendars[cal["slug"]] = obj

    def _resolve_resources(self) -> None:
        for res in self.payload.get("resources", []):
            calendar = self.calendars.get(res["calendar"]) if res.get("calendar") else None
            account_user = self.users.get(res["account"]) if res.get("account") else None
            defaults = {
                "name": res["name"],
                "email": res.get("email", ""),
                "job_role": res.get("job_role", ""),
                "max_units": res.get("max_units", 1.0),
                "calendar": calendar,
                "user": account_user,
            }
            if self.is_sample:
                # Demo path: resources are a global catalog and have no slug
                # column; reuse the shared persona rows by email (else name) so a
                # sample reload does not accumulate duplicate demo people.
                lookup = {"email": res["email"]} if res.get("email") else {"name": res["name"]}
                obj, _created = Resource.objects.get_or_create(**lookup, defaults=defaults)
            else:
                # Generic import (#1004): never match a live global resource by
                # email. Doing so would bind a pre-existing resource — and the
                # real ``user`` FK it may carry — into the importer's project via
                # ``_assign_resources``. Create a fresh row so an attacker-crafted
                # seed cannot pull a real user's resource into their program.
                obj = Resource.objects.create(**defaults)
            self.resources[res["slug"]] = obj

    def _create_program(self) -> Program:
        data = self.payload["program"]
        program = create_program(
            name=data["name"],
            description=data.get("description", ""),
            methodology=data["methodology"],
            created_by=self.owner,
        )
        # Persist the slug as the natural key + carry display fields.
        program.code = data["slug"]
        if data.get("color"):
            program.color = data["color"]
        lead = self.users.get(data["lead"]) if data.get("lead") else None
        if lead is not None:
            program.lead = lead
        program.save(update_fields=["code", "color", "lead"])
        self._grant_program_memberships(program)
        return program

    def _grant_program_memberships(self, program: Program) -> None:
        for account in self.payload.get("accounts", []):
            user = self.users.get(account["slug"])
            role = _ROLE_BY_NAME.get(account.get("role", ""))
            if user is None or role is None or user == self.owner:
                continue  # owner already has OWNER from create_program
            ProgramMembership.objects.update_or_create(
                program=program, user=user, defaults={"role": role}
            )

    # --- per-project structure (Pass A) ------------------------------------

    def _create_project_structure(self, program: Program, data: dict[str, Any]) -> None:
        project = Project.objects.create(
            program=program,
            name=data["name"],
            description=data.get("description", ""),
            start_date=_req_date(data["start_date"]),
            calendar=self.calendars.get(data["calendar"]) if data.get("calendar") else None,
            methodology=data["methodology"],
            code=data.get("code", ""),
            default_view=data.get("default_view", "SCHEDULE"),
            estimation_mode=data.get("estimation_mode", "open"),
            agile_features=data.get("agile_features", data["methodology"] != "WATERFALL"),
            # is_sample is owned by the importer so the idempotency guard in
            # _replace_existing can distinguish disposable demo data from real
            # work on a later reload (#994).
            is_sample=self.is_sample,
        )
        self.projects[data["slug"]] = project
        ProjectMembership.objects.update_or_create(
            project=project, user=self.owner, defaults={"role": Role.OWNER}
        )

        for sprint_data in data.get("sprints", []):
            sprint = Sprint.objects.create(
                project=project,
                name=sprint_data["name"],
                goal=sprint_data.get("goal", ""),
                notes=sprint_data.get("notes", ""),
                start_date=_req_date(sprint_data["start_date"]),
                finish_date=_req_date(sprint_data["finish_date"]),
                state=sprint_data["state"],
                committed_points=sprint_data.get("committed_points"),
                completed_points=sprint_data.get("completed_points"),
                capacity_points=sprint_data.get("capacity_points"),
            )
            self.sprints[(data["slug"], sprint_data["slug"])] = sprint

        for task_data in data.get("tasks", []):
            self._create_task(project, data["slug"], task_data)

    def _create_task(self, project: Project, project_slug: str, data: dict[str, Any]) -> None:
        sprint = self.sprints.get((project_slug, data["sprint"])) if data.get("sprint") else None
        assignee = self.users.get(data["assignee"]) if data.get("assignee") else None
        is_milestone = data.get("is_milestone", False)

        # Three-point estimate is all-or-none and never set on milestones
        # (ADR-0093). Seeded estimates are PM-authored, so they import ACCEPTED.
        # Folded into the create() so an estimated task is one INSERT, not two.
        estimate = data.get("estimate") if not is_milestone else None
        estimate_fields = (
            {
                "optimistic_duration": estimate["optimistic"],
                "most_likely_duration": estimate["most_likely"],
                "pessimistic_duration": estimate["pessimistic"],
                "estimate_status": EstimateStatus.ACCEPTED,
            }
            if estimate
            else {}
        )

        task = Task.objects.create(
            project=project,
            name=data["name"],
            wbs_path=data["wbs_path"],
            type=data.get("type", "task"),
            status=data.get("status", "NOT_STARTED"),
            is_milestone=is_milestone,
            duration=0 if is_milestone else data.get("duration", 1),
            planned_start=_parse_date(data.get("planned_start")),
            percent_complete=data.get("percent_complete", 0.0),
            notes=data.get("notes", ""),
            story_points=data.get("story_points"),
            remaining_points=data.get("remaining_points"),
            assignee=assignee,
            sprint=sprint,
            sprint_rank=data.get("sprint_rank"),
            governance_class=data.get("governance_class", "flow"),
            delivery_mode=data.get("delivery_mode", "waterfall"),
            color=data.get("color"),
            **estimate_fields,
        )

        self.tasks[(project_slug, data["wbs_path"])] = task

    # --- cross-cutting links (Pass B) --------------------------------------

    def _resolve_task_ref(self, ref: str, enclosing_project: str) -> Task:
        if ":" in ref:
            project_slug, _, wbs = ref.partition(":")
        else:
            project_slug, wbs = enclosing_project, ref
        return self.tasks[(project_slug, wbs)]

    def _link_dependencies(self, project: Project, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for dep in data.get("dependencies", []):
            Dependency.objects.create(
                predecessor=self._resolve_task_ref(dep["predecessor"], slug),
                successor=self._resolve_task_ref(dep["successor"], slug),
                dep_type=dep["dep_type"],
                lag=dep.get("lag", 0),
            )

    def _link_parent_epics(self, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for task_data in data.get("tasks", []):
            parent = task_data.get("parent_epic")
            if not parent:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            task.parent_epic = self.tasks[(slug, parent)]
            task.save(update_fields=["parent_epic"])

    def _link_sprint_milestones(self, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for sprint_data in data.get("sprints", []):
            target = sprint_data.get("target_milestone")
            if not target:
                continue
            sprint = self.sprints[(slug, sprint_data["slug"])]
            sprint.target_milestone = self.tasks[(slug, target)]
            sprint.save(update_fields=["target_milestone"])

    def _assign_resources(self, project: Project, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for task_data in data.get("tasks", []):
            assignments = task_data.get("assignments", [])
            if not assignments:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            for assignment in assignments:
                resource = self.resources[assignment["resource"]]
                TaskResource.objects.create(
                    task=task, resource=resource, units=assignment.get("units", 1.0)
                )
                ensure_project_resource(project, resource)

    def _capture_baselines(self, project: Project, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for bl_data in data.get("baselines", []):
            baseline = Baseline.objects.create(
                project=project,
                name=bl_data["name"],
                is_active=bl_data.get("is_active", False),
            )
            rows = []
            has_dates = True
            for bt in bl_data.get("tasks", []):
                task = self.tasks[(slug, bt["task"])]
                start = _parse_date(bt.get("start"))
                finish = _parse_date(bt.get("finish"))
                has_dates = has_dates and start is not None
                rows.append(
                    BaselineTask(
                        baseline=baseline,
                        task_id=task.pk,
                        task_name=task.name,
                        start=start,
                        finish=finish,
                        duration=bt.get("duration", task.duration),
                        story_points=bt.get("story_points", task.story_points),
                    )
                )
            BaselineTask.objects.bulk_create(rows)
            if rows and has_dates:
                Baseline.objects.filter(pk=baseline.pk).update(has_cpm_dates=True)

    def _create_program_risks(self, program: Program) -> None:
        """Program-scoped risks attach to the first project (Risk is project-FK).

        TruePPM has no program-level Risk model; a program-scoped seed risk is
        materialized on the lead project but may link tasks across projects.
        """
        risks = self.payload.get("risks", [])
        if not risks:
            return
        lead_project = next(iter(self.projects.values()))
        self._create_risks(lead_project, risks, enclosing_project=None)

    def _create_risks(
        self, project: Project, risks: list[dict[str, Any]], enclosing_project: str | None
    ) -> None:
        for data in risks:
            risk = Risk.objects.create(
                project=project,
                title=data["title"],
                description=data.get("description", ""),
                status=data["status"],
                probability=data["probability"],
                impact=data["impact"],
                category=data.get("category"),
                response=data.get("response"),
                mitigation_due_date=_parse_date(data.get("mitigation_due_date")),
                trigger=data.get("trigger", ""),
                contingency=data.get("contingency", ""),
                notes=data.get("notes", ""),
                owner=self.users.get(data["owner"]) if data.get("owner") else None,
            )
            for ref in data.get("tasks", []):
                # Program-scoped risks (enclosing_project is None) always carry
                # qualified refs, so the enclosing fallback is never consulted.
                RiskTask.objects.create(
                    risk=risk,
                    task=self._resolve_task_ref(ref, enclosing_project or ""),
                )
