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
from datetime import date, datetime, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

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
from trueppm_api.apps.projects.seed.reldates import (
    WorkingCalendar,
    resolve_anchor,
    resolve_date,
)
from trueppm_api.apps.projects.seed.replay import ReplayContext, replay_timeline
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
        # v2 (ADR-0114): relative dates resolve against an anchor (import day),
        # and an events timeline is replayed with backdated history. v1 docs set
        # the major to "1", so replay is off and dates are plain ISO literals.
        self.replay = str(payload.get("schema_version", "")).split(".")[0] == "2"
        self.anchor: date = resolve_anchor(payload, date.today())
        self.working_calendars: dict[str, WorkingCalendar] = {}
        self.risks_by_slug: dict[str, Risk] = {}
        # Desired END states for replay — tasks/sprints are created at a base
        # state and walked forward to these by the timeline + synthesizer.
        self.final_status: dict[tuple[str, str], str] = {}
        self.final_sprint: dict[tuple[str, str], dict[str, Any]] = {}

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

        # Pass C (v2 only): replay the events timeline + synthesized fill so the
        # demo reads as a program that has run for months — backdated history,
        # real burndown/velocity, scope-injection audit. Runs inside this same
        # transaction under the seed_replay flag (side effects suppressed).
        if self.replay:
            replay_timeline(self.payload, self._replay_context())

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

    # --- v2 date resolution + replay --------------------------------------

    def _build_working_calendar(self, cal: Calendar | None) -> WorkingCalendar:
        """Calendar facts for weekend-snapping: bitmask + materialized exceptions."""
        if cal is None:
            return WorkingCalendar()
        exc: set[date] = set()
        for e in cal.exceptions.all()[:500]:
            d = e.exc_start
            while d <= e.exc_end and len(exc) < 5000:
                exc.add(d)
                d += timedelta(days=1)
        try:
            tz = ZoneInfo(cal.timezone) if cal.timezone else ZoneInfo("UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        return WorkingCalendar(working_days=cal.working_days, exception_dates=frozenset(exc), tz=tz)

    def _wc(self, project_slug: str | None) -> WorkingCalendar:
        if project_slug is None:
            return WorkingCalendar()
        return self.working_calendars.get(project_slug) or WorkingCalendar()

    def _date(self, value: str, project_slug: str | None) -> date:
        """Resolve a required seed date. v1 ISO literals pass straight through."""
        return resolve_date(value, anchor=self.anchor, calendar=self._wc(project_slug))

    def _date_opt(self, value: str | None, project_slug: str | None) -> date | None:
        return self._date(value, project_slug) if value else None

    def _creation_dt(self, when: date) -> datetime:
        """A backdated creation timestamp (UTC 09:00) for replay history rows."""
        return datetime(when.year, when.month, when.day, 9, 0, tzinfo=ZoneInfo("UTC"))

    def _save_new(self, instance: Any, created_on: date) -> Any:
        """Insert ``instance``, backdating its creation history row under replay.

        Under v2 replay the creation row is dated to when the entity came into
        being (its window/sprint start), not import time, so the History tab and
        activity timeline read chronologically. v1 import saves normally.
        """
        if self.replay:
            instance._history_date = self._creation_dt(created_on)
            instance._history_user = self.owner
        instance.save()
        return instance

    def _replay_context(self) -> ReplayContext:
        lead_project = next(iter(self.projects.values()), None)
        try:
            tz = ZoneInfo(getattr(lead_project, "timezone", "") or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        return ReplayContext(
            anchor=self.anchor,
            program_code=self.payload["program"]["slug"],
            default_actor=self.owner,
            users=self.users,
            tasks=self.tasks,
            sprints=self.sprints,
            projects=self.projects,
            project_calendars=self.working_calendars,
            risks=self.risks_by_slug,
            final_status=self.final_status,
            final_sprint=self.final_sprint,
            tz=tz,
        )

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
            # #1057: on the generic import path (create_users=False, the REST
            # default) a seed's accounts[].username is attacker-controlled and may
            # collide with a *pre-existing* real user. Binding that user here would
            # let a crafted seed pull a known victim into the importer's program —
            # as a ProgramMembership (_grant_program_memberships), the program lead,
            # a task assignee, or a resource's user FK. Resolve such accounts to
            # None so the generic path never associates a real account it did not
            # create. The owner is exempt (their own account), and the server-
            # curated sample/demo path (is_sample) binds personas freely.
            if (
                user is not None
                and not self.create_users
                and not self.is_sample
                and user != self.owner
            ):
                user = None
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
            # account_user is already None on the generic path for any account that
            # resolved to a pre-existing real user — _resolve_accounts drops those
            # (#1057), so the resource's user FK cannot bind a victim here.
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
        slug = data["slug"]
        calendar = self.calendars.get(data["calendar"]) if data.get("calendar") else None
        # Build the working-calendar facts first so relative dates snap against
        # this project's calendar (weekends + exceptions).
        self.working_calendars[slug] = self._build_working_calendar(calendar)
        project = Project.objects.create(
            program=program,
            name=data["name"],
            description=data.get("description", ""),
            start_date=self._date(data["start_date"], slug),
            calendar=calendar,
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
        self.projects[slug] = project
        ProjectMembership.objects.update_or_create(
            project=project, user=self.owner, defaults={"role": Role.OWNER}
        )

        for sprint_data in data.get("sprints", []):
            start = self._date(sprint_data["start_date"], slug)
            finish = self._date(sprint_data["finish_date"], slug)
            # Under replay the sprint is born PLANNED and walked to its end state
            # by activate/close beats (authored or synthesized); points are
            # snapshotted at those beats. v1 import sets the end state directly.
            sprint = Sprint(
                project=project,
                name=sprint_data["name"],
                goal=sprint_data.get("goal", ""),
                notes=sprint_data.get("notes", ""),
                start_date=start,
                finish_date=finish,
                state="PLANNED" if self.replay else sprint_data["state"],
                committed_points=None if self.replay else sprint_data.get("committed_points"),
                completed_points=None if self.replay else sprint_data.get("completed_points"),
                capacity_points=sprint_data.get("capacity_points"),
            )
            self._save_new(sprint, start)
            self.sprints[(slug, sprint_data["slug"])] = sprint
            if self.replay:
                self.final_sprint[(slug, sprint_data["slug"])] = {
                    "state": sprint_data["state"],
                    "committed_points": sprint_data.get("committed_points"),
                    "completed_points": sprint_data.get("completed_points"),
                }

        for task_data in data.get("tasks", []):
            self._create_task(project, slug, task_data)

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

        final_status = data.get("status", "NOT_STARTED")
        planned_start = self._date_opt(data.get("planned_start"), project_slug)
        story_points = data.get("story_points")

        # Under replay a task that ends in-flight/done is born NOT_STARTED and
        # walked forward by the timeline + synthesizer; its creation row is
        # backdated to when work could have begun (sprint/planned/project start).
        progresses = self.replay and final_status in ("IN_PROGRESS", "REVIEW", "COMPLETE")
        base_status = "NOT_STARTED" if progresses else final_status
        base_percent = 0.0 if progresses else data.get("percent_complete", 0.0)
        base_remaining = story_points if progresses else data.get("remaining_points")

        task = Task(
            project=project,
            name=data["name"],
            wbs_path=data["wbs_path"],
            type=data.get("type", "task"),
            status=base_status,
            is_milestone=is_milestone,
            duration=0 if is_milestone else data.get("duration", 1),
            planned_start=planned_start,
            percent_complete=base_percent,
            notes=data.get("notes", ""),
            story_points=story_points,
            remaining_points=base_remaining,
            assignee=assignee,
            sprint=sprint,
            sprint_rank=data.get("sprint_rank"),
            governance_class=data.get("governance_class", "flow"),
            delivery_mode=data.get("delivery_mode", "waterfall"),
            color=data.get("color"),
            **estimate_fields,
        )
        created_on = (
            sprint.start_date if sprint is not None else (planned_start or project.start_date)
        )
        self._save_new(task, created_on)

        self.tasks[(project_slug, data["wbs_path"])] = task
        if self.replay:
            self.final_status[(project_slug, data["wbs_path"])] = final_status

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
                start = self._date_opt(bt.get("start"), slug)
                finish = self._date_opt(bt.get("finish"), slug)
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
            risk = Risk(
                project=project,
                title=data["title"],
                description=data.get("description", ""),
                status=data["status"],
                probability=data["probability"],
                impact=data["impact"],
                category=data.get("category"),
                response=data.get("response"),
                mitigation_due_date=self._date_opt(
                    data.get("mitigation_due_date"), enclosing_project
                ),
                trigger=data.get("trigger", ""),
                contingency=data.get("contingency", ""),
                notes=data.get("notes", ""),
                owner=self.users.get(data["owner"]) if data.get("owner") else None,
            )
            # Backdate the creation history row to the project start under replay
            # (risks are identified at kickoff), so a risk that the events timeline
            # walks through a status lifecycle reads chronologically — the "opened"
            # row precedes its dated transitions rather than landing at import time.
            self._save_new(risk, project.start_date)
            # Slug map lets risk.status replay beats resolve their target.
            if data.get("slug"):
                self.risks_by_slug[data["slug"]] = risk
            for ref in data.get("tasks", []):
                # Program-scoped risks (enclosing_project is None) always carry
                # qualified refs, so the enclosing fallback is never consulted.
                RiskTask.objects.create(
                    risk=risk,
                    task=self._resolve_task_ref(ref, enclosing_project or ""),
                )
