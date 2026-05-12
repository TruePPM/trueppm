"""Seed the "Platform Migration" demo project (issue #296).

Builds a coherent universe so a reviewer can walk through all eight steps
of the hybrid PM flow narrative end-to-end without manual data entry:

1. Charter & decompose (WBS with phases + work packages)
2. Schedule the skeleton (CPM dates + critical path + baseline)
3. Capacity preflight (resource assignments with one over-allocation)
4. Decompose to stories (story_points on leaf tasks under work packages)
5. Sprint planning (planned + active sprints)
6. Execute (mid-sprint burndown snapshots, board with WIP overload)
7. Forecast (closed sprint history → velocity ± stdev → forecast range)
8. Close (retro on the most recent closed sprint with a promoted action item)

The command is idempotent — re-running clears any prior demo project (by
name match) and re-seeds. With ``--with-personas`` it also creates the six
persona logins from the narrative document and binds them to the project
with appropriate roles, so a single seed produces a full demo deployment.

Usage::

    python manage.py seed_demo_project              # project only
    python manage.py seed_demo_project --with-personas
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

logger = logging.getLogger(__name__)


# Project name used as the idempotency key — re-runs clear and re-seed any
# project with this exact name. Sales demos and CI fixtures should treat
# this as a reserved name.
PROJECT_NAME = "Platform Migration"
SECONDARY_PROJECT_NAME = "Pilot Deployment"

PERSONAS = [
    {
        "username": "maya",
        "first": "Maya",
        "last": "Singh",
        "role": "MEMBER",
        "title": "Scrum Master",
    },
    {
        "username": "raj",
        "first": "Raj",
        "last": "Patel",
        "role": "SCHEDULER",
        "title": "Project Manager",
    },
    {
        "username": "diana",
        "first": "Diana",
        "last": "Khan",
        "role": "ADMIN",
        "title": "PMO Director",
    },
    {
        "username": "sarah",
        "first": "Sarah",
        "last": "Lee",
        "role": "SCHEDULER",
        "title": "Resource Manager",
    },
    {
        "username": "carlos",
        "first": "Carlos",
        "last": "Mendes",
        "role": "VIEWER",
        "title": "Executive Sponsor",
    },
    {
        "username": "tom",
        "first": "Tom",
        "last": "Nguyen",
        "role": "MEMBER",
        "title": "Senior Engineer",
    },
]

DEMO_PASSWORD = "demo"

DEMO_ROSTER = [
    ("Tom Nguyen", "Senior Engineer", 1.0),
    ("Aisha Khan", "Backend Engineer", 1.0),
    ("Ben Lee", "Frontend Engineer", 1.0),
    ("Cleo Ng", "DevOps", 0.8),
    ("Dan Ortiz", "Data Engineer", 1.0),
    ("Sarah Lee", "Resource Manager", 0.5),
]


class Command(BaseCommand):
    """Seed the Platform Migration demo project (#296)."""

    help = "Seed the Platform Migration demo project (idempotent)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--with-personas",
            action="store_true",
            help="Also create the six persona logins (Maya, Raj, Diana, Sarah, Carlos, Tom).",
        )

    @transaction.atomic
    def handle(self, *args: object, **options: object) -> None:
        from trueppm_api.apps.access.models import ProjectMembership
        from trueppm_api.apps.projects.models import Project
        from trueppm_api.apps.resources.models import Resource

        # Idempotent reset. ProjectMembership uses on_delete=PROTECT so the
        # project drop fails until memberships go first. Resources are global
        # (no project FK) so we match by demo-roster name.
        prior = Project.objects.filter(name__in=(PROJECT_NAME, SECONDARY_PROJECT_NAME))
        if prior.exists():
            ProjectMembership.objects.filter(project__in=prior).delete()
            deleted = prior.delete()
            self.stdout.write(f"Cleared {deleted[0]} prior demo row(s).")
        Resource.objects.filter(name__in=[r[0] for r in DEMO_ROSTER]).delete()

        users = self._build_personas() if options.get("with_personas") else {}
        owner = users.get("raj")  # PM owns the schedule

        project = self._build_project(PROJECT_NAME, owner=owner)
        secondary = self._build_secondary_project(SECONDARY_PROJECT_NAME, owner=owner)

        self._bind_memberships(project, secondary, users)

        phase_tasks = self._build_wbs(project)
        self._build_dependencies(phase_tasks)
        self._build_baseline(project)
        self._build_board_config(project)

        resources = self._build_resources(users)
        self._assign_resources(phase_tasks, resources)

        self._build_sprint_history(project, phase_tasks, resources)
        active = self._build_active_sprint(project, phase_tasks, resources, users.get("tom"))
        self._build_planned_sprint(project)
        self._build_retro(project, users.get("maya"))
        self._build_secondary_active_sprint(secondary, users.get("tom"))

        # Activate the baseline last so it captures the CPM dates we just
        # set on the work packages.
        self._activate_baseline(project)

        self.stdout.write(self.style.SUCCESS(""))
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write(
            self.style.SUCCESS(f"  Seeded {PROJECT_NAME!r} + {SECONDARY_PROJECT_NAME!r}")
        )
        if users:
            names = ", ".join(p["username"] for p in PERSONAS)
            self.stdout.write(
                self.style.SUCCESS(f"  Personas: {names} (password={DEMO_PASSWORD!r})")
            )
        self.stdout.write(self.style.SUCCESS(f"  Active sprint: {active.name!r}"))
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write("")

    # ------------------------------------------------------------------
    # Personas
    # ------------------------------------------------------------------

    def _build_personas(self) -> dict[str, Any]:
        User = get_user_model()
        out: dict[str, Any] = {}
        for spec in PERSONAS:
            user, _ = User.objects.update_or_create(
                username=spec["username"],
                defaults={
                    "email": f"{spec['username']}@trueppm.demo",
                    "first_name": spec["first"],
                    "last_name": spec["last"],
                },
            )
            user.set_password(DEMO_PASSWORD)
            user.save(update_fields=["password"])
            out[spec["username"]] = user
        return out

    def _bind_memberships(
        self,
        project: Any,
        secondary: Any,
        users: dict[str, Any],
    ) -> None:
        from trueppm_api.apps.access.models import ProjectMembership, Role

        if users:
            role_map = {p["username"]: getattr(Role, p["role"]) for p in PERSONAS}
            for username, user in users.items():
                ProjectMembership.objects.update_or_create(
                    project=project, user=user, defaults={"role": role_map[username]}
                )
            # Diana + Sarah see the secondary project too — that's what flips
            # the multi-team Sprints lens toggle on for them (#230).
            for username in ("diana", "sarah", "tom"):
                if username in users:
                    ProjectMembership.objects.update_or_create(
                        project=secondary,
                        user=users[username],
                        defaults={"role": role_map[username]},
                    )

        # Always add superusers so a demo deployment is immediately usable
        # without logging in as a persona. Persona roles take precedence —
        # superusers who are also personas keep their persona role.
        User = get_user_model()
        persona_pks = {u.pk for u in users.values()}
        for su in User.objects.filter(is_superuser=True, is_active=True):
            if su.pk not in persona_pks:
                for proj in (project, secondary):
                    ProjectMembership.objects.update_or_create(
                        project=proj, user=su, defaults={"role": Role.ADMIN}
                    )

    # ------------------------------------------------------------------
    # Project skeleton
    # ------------------------------------------------------------------

    def _build_project(self, name: str, owner: Any) -> Any:
        from trueppm_api.apps.projects.models import Calendar, Methodology, Project

        cal = Calendar.objects.create(name=f"{name} calendar", hours_per_day=8.0)
        return Project.objects.create(
            name=name,
            description="Migrate the legacy platform to the new stack — flagship demo project.",
            start_date=date.today() - timedelta(days=120),
            calendar=cal,
            methodology=Methodology.HYBRID,
            agile_features=True,
        )

    def _build_secondary_project(self, name: str, owner: Any) -> Any:
        from trueppm_api.apps.projects.models import Calendar, Methodology, Project

        cal = Calendar.objects.create(name=f"{name} calendar", hours_per_day=8.0)
        return Project.objects.create(
            name=name,
            description="Pilot rollout to internal users — runs in parallel.",
            start_date=date.today() - timedelta(days=60),
            calendar=cal,
            methodology=Methodology.AGILE,
            agile_features=True,
        )

    # ------------------------------------------------------------------
    # WBS + dependencies + baseline
    # ------------------------------------------------------------------

    def _build_wbs(self, project: Any) -> dict[str, Any]:
        """Build 4 phases × 2-3 work packages each. Returns name → task map.

        Hierarchy uses the ``wbs_path`` ltree column directly — there is no
        ``parent`` FK on Task; summary status is inferred from having
        descendants in the same path subtree (per serializer convention).
        """
        from trueppm_api.apps.projects.models import Task

        out: dict[str, Any] = {}
        phases = [
            (
                "Discovery",
                -120,
                21,
                [
                    ("Stakeholder interviews", 7),
                    ("Architecture review", 7),
                    ("Risk register kickoff", 7),
                ],
            ),
            (
                "Build",
                -90,
                60,
                [
                    ("Auth migration", 18),
                    ("Data layer rewrite", 24),
                    ("API surface refresh", 18),
                ],
            ),
            (
                "Migration",
                -30,
                30,
                [
                    ("Pilot data sync", 14),
                    ("Cutover rehearsal", 8),
                    ("Comms + rollback plan", 8),
                ],
            ),
            (
                "Cutover",
                0,
                14,
                [
                    ("Production cutover", 7),
                    ("Post-launch hardening", 7),
                ],
            ),
        ]
        start = project.start_date
        for phase_idx, (phase_name, day_offset, dur, packages) in enumerate(phases, start=1):
            phase_start = start + timedelta(days=120 + day_offset)
            phase = Task.objects.create(
                project=project,
                name=phase_name,
                duration=dur,
                early_start=phase_start,
                early_finish=phase_start + timedelta(days=dur),
                wbs_path=str(phase_idx),
                status="IN_PROGRESS",
            )
            out[phase_name] = phase
            cur = phase_start
            for wp_idx, (pkg_name, pkg_dur) in enumerate(packages, start=1):
                wp = Task.objects.create(
                    project=project,
                    name=pkg_name,
                    duration=pkg_dur,
                    early_start=cur,
                    early_finish=cur + timedelta(days=pkg_dur),
                    wbs_path=f"{phase_idx}.{wp_idx}",
                    is_critical=phase_name in ("Build", "Migration"),
                    status="IN_PROGRESS" if cur < date.today() else "NOT_STARTED",
                )
                out[pkg_name] = wp
                cur += timedelta(days=pkg_dur)

        # Two contractual milestones land on the WBS.
        for ms_idx, (ms_name, ms_offset) in enumerate(
            (("UAT signoff", -7), ("Production cutover signoff", 14)), start=1
        ):
            Task.objects.create(
                project=project,
                name=ms_name,
                duration=0,
                early_start=date.today() + timedelta(days=ms_offset),
                early_finish=date.today() + timedelta(days=ms_offset),
                wbs_path=f"M.{ms_idx}",
                is_milestone=True,
                status="NOT_STARTED",
            )
        return out

    def _build_dependencies(self, phase_tasks: dict[str, Any]) -> None:
        from trueppm_api.apps.projects.models import Dependency

        chain = [
            "Stakeholder interviews",
            "Architecture review",
            "Auth migration",
            "Data layer rewrite",
            "API surface refresh",
            "Pilot data sync",
            "Cutover rehearsal",
            "Production cutover",
            "Post-launch hardening",
        ]
        for prev, nxt in pairwise(chain):
            if prev in phase_tasks and nxt in phase_tasks:
                Dependency.objects.create(
                    predecessor=phase_tasks[prev],
                    successor=phase_tasks[nxt],
                    dep_type="FS",
                    lag=0,
                )

    def _build_baseline(self, project: Any) -> Any:
        from trueppm_api.apps.projects.models import Baseline, BaselineTask, Task

        baseline = Baseline.objects.create(
            project=project,
            name="Contract baseline",
            is_active=False,  # activate after CPM dates settle
            has_cpm_dates=True,
        )
        for task in Task.objects.filter(project=project, is_deleted=False):
            BaselineTask.objects.create(
                baseline=baseline,
                task_id=task.pk,
                task_name=task.name,
                start=task.early_start,
                finish=task.early_finish,
                duration=task.duration,
            )
        return baseline

    def _activate_baseline(self, project: Any) -> None:
        from trueppm_api.apps.projects.models import Baseline

        Baseline.objects.filter(project=project, name="Contract baseline").update(is_active=True)

    def _build_board_config(self, project: Any) -> None:
        from trueppm_api.apps.projects.models import BoardColumnConfig

        BoardColumnConfig.objects.update_or_create(
            project=project,
            defaults={
                "columns": [
                    {
                        "status": "BACKLOG",
                        "label": "Backlog",
                        "visible": True,
                        "color": "#94A3B8",
                        "wip_limit": None,
                    },
                    {
                        "status": "NOT_STARTED",
                        "label": "To Do",
                        "visible": True,
                        "color": "#64748B",
                        "wip_limit": None,
                    },
                    {
                        "status": "IN_PROGRESS",
                        "label": "In Progress",
                        "visible": True,
                        "color": "#3B82F6",
                        "wip_limit": 3,
                    },
                    {
                        "status": "REVIEW",
                        "label": "Review",
                        "visible": True,
                        "color": "#A855F7",
                        "wip_limit": 2,
                    },
                    {
                        "status": "COMPLETE",
                        "label": "Done",
                        "visible": True,
                        "color": "#22C55E",
                        "wip_limit": None,
                    },
                ],
            },
        )

    # ------------------------------------------------------------------
    # Resources + assignments
    # ------------------------------------------------------------------

    def _build_resources(self, users: dict[str, Any]) -> dict[str, Any]:
        from trueppm_api.apps.resources.models import Resource

        out: dict[str, Any] = {}
        for name, role, units in DEMO_ROSTER:
            r = Resource.objects.create(name=name, job_role=role, max_units=units)
            out[name] = r
        return out

    def _assign_resources(self, phase_tasks: dict[str, Any], resources: dict[str, Any]) -> None:
        from trueppm_api.apps.resources.models import TaskResource
        from trueppm_api.apps.resources.services import ensure_project_resource

        # Spread assignments across the in-flight work packages. Cleo is the
        # over-allocated member — pinned to two simultaneous packages at full
        # units so the capacity preflight surfaces the conflict.
        assignments = [
            ("Auth migration", "Aisha Khan", 1.0),
            ("Data layer rewrite", "Ben Lee", 1.0),
            ("Data layer rewrite", "Cleo Ng", 0.8),
            ("API surface refresh", "Cleo Ng", 0.6),  # over-allocated
            ("Pilot data sync", "Dan Ortiz", 1.0),
            ("Cutover rehearsal", "Tom Nguyen", 1.0),
        ]
        for pkg_name, res_name, units in assignments:
            if pkg_name in phase_tasks and res_name in resources:
                task = phase_tasks[pkg_name]
                resource = resources[res_name]
                TaskResource.objects.create(task=task, resource=resource, units=units)
                # Mirror the API auto-roster behaviour so demo Team views are populated (#241).
                ensure_project_resource(task.project, resource)

    # ------------------------------------------------------------------
    # Sprints (history → active → planned)
    # ------------------------------------------------------------------

    def _build_sprint_history(
        self, project: Any, phase_tasks: dict[str, Any], resources: dict[str, Any]
    ) -> None:
        """Eight closed sprints with realistic 38 ± 6 pts velocity."""
        from trueppm_api.apps.projects.models import Sprint, SprintState

        committed_completed = [
            (40, 36),
            (38, 35),
            (42, 38),
            (36, 41),
            (40, 37),
            (38, 39),
            (44, 40),
            (40, 38),
        ]
        cursor = date.today() - timedelta(days=14 * 9)
        for i, (committed, completed) in enumerate(committed_completed, start=1):
            start = cursor
            finish = start + timedelta(days=13)
            Sprint.objects.create(
                project=project,
                name=f"Sprint {i} — closed",
                goal=f"Closed sprint #{i} of the demo history.",
                start_date=start,
                finish_date=finish,
                state=SprintState.COMPLETED,
                committed_points=committed,
                committed_task_count=committed // 4,
                completed_points=completed,
                completed_task_count=completed // 4,
                activated_at=datetime.combine(start, datetime.min.time(), tzinfo=UTC),
                closed_at=datetime.combine(finish, datetime.min.time(), tzinfo=UTC),
            )
            cursor = finish + timedelta(days=1)

    def _build_active_sprint(
        self,
        project: Any,
        phase_tasks: dict[str, Any],
        resources: dict[str, Any],
        tom: Any,
    ) -> Any:
        from trueppm_api.apps.projects.models import (
            Sprint,
            SprintBurnSnapshot,
            SprintState,
            Task,
        )

        # Sprint window: started 7 days ago, finishes 7 days from now.
        today = date.today()
        start = today - timedelta(days=7)
        finish = today + timedelta(days=6)

        sprint = Sprint.objects.create(
            project=project,
            name="Sprint 9 — Telemetry & FAT prep",
            goal="Close out telemetry firmware sweep and prep FAT review.",
            start_date=start,
            finish_date=finish,
            state=SprintState.ACTIVE,
            committed_points=44,
            committed_task_count=14,
            activated_at=datetime.combine(start, datetime.min.time(), tzinfo=UTC),
        )

        # Story-level tasks under the Build phase, all assigned to the
        # active sprint with realistic point + status mix.
        # IN_PROGRESS=4 trips the WIP limit (3) so the overload chip lights up.
        story_specs = [
            ("Wire telemetry channel", 8, "IN_PROGRESS", True),
            ("Calibrate FAT bench", 5, "IN_PROGRESS", True),
            ("Telemetry power tap", 3, "IN_PROGRESS", False),
            ("Doc draft — FAT runbook", 2, "IN_PROGRESS", False),
            ("Channel sweep regression", 5, "REVIEW", False),
            ("Cap-bank dry run", 3, "REVIEW", False),
            ("Smoke test harness", 3, "COMPLETE", True),
            ("Rev-A schematic review", 2, "COMPLETE", False),
            ("Field harness layout", 5, "BACKLOG", False),
            ("Spare-parts BOM", 2, "BACKLOG", False),
            ("Pilot site visit prep", 3, "NOT_STARTED", False),
            ("Test fixture inventory", 3, "NOT_STARTED", False),
        ]
        parent = phase_tasks.get("Auth migration") or phase_tasks.get("Build")
        parent_path = str(parent.wbs_path) if parent and parent.wbs_path else "2.1"
        for idx, (name, pts, status, is_critical) in enumerate(story_specs, start=1):
            Task.objects.create(
                project=project,
                name=name,
                duration=1,
                wbs_path=f"{parent_path}.{idx}",
                sprint=sprint,
                story_points=pts,
                status=status,
                is_critical=is_critical,
                assignee=tom,
            )

        # Daily burn snapshots — actual line is slightly behind ideal so the
        # burndown chart shows a "behind" trend, with a scope-add on day 4.
        # ``update_or_create`` because the task_status_changed signal already
        # wrote today's row (one per task save above) — we want our scripted
        # series to win.
        committed = sprint.committed_points or 0
        days_in = 8  # snapshots 0..7 inclusive
        for offset in range(days_in):
            day = start + timedelta(days=offset)
            ideal_remaining = committed * (1 - offset / 13)
            actual_remaining = max(0, round(ideal_remaining + 4))  # 4 pts behind
            scope_change = 4 if offset == 4 else 0
            SprintBurnSnapshot.objects.update_or_create(
                sprint=sprint,
                snapshot_date=day,
                defaults={
                    "remaining_points": actual_remaining + scope_change,
                    "remaining_task_count": max(0, 14 - offset),
                    "completed_points": max(0, committed - actual_remaining),
                    "completed_task_count": offset,
                    "scope_change_points": scope_change,
                    "scope_change_task_count": 1 if scope_change else 0,
                },
            )
        return sprint

    def _build_planned_sprint(self, project: Any) -> Any:
        from trueppm_api.apps.projects.models import Sprint, SprintState

        today = date.today()
        start = today + timedelta(days=7)
        finish = start + timedelta(days=13)
        return Sprint.objects.create(
            project=project,
            name="Sprint 10 — Pilot deployment",
            goal="Deploy to pilot users and validate cutover runbook.",
            start_date=start,
            finish_date=finish,
            state=SprintState.PLANNED,
        )

    def _build_secondary_active_sprint(self, project: Any, tom: Any) -> Any:
        """An active sprint on the Pilot project — flips Tom's multi-team toggle."""
        from trueppm_api.apps.projects.models import Sprint, SprintState, Task

        today = date.today()
        start = today - timedelta(days=4)
        finish = today + timedelta(days=9)
        sprint = Sprint.objects.create(
            project=project,
            name="Pilot Sprint 3 — Onboarding flow",
            goal="Ship onboarding flow to pilot users.",
            start_date=start,
            finish_date=finish,
            state=SprintState.ACTIVE,
            committed_points=22,
            committed_task_count=6,
            activated_at=datetime.combine(start, datetime.min.time(), tzinfo=UTC),
        )
        if tom is None:
            return sprint
        # One assigned task so Tom shows up in the multi-team lens for Pilot.
        Task.objects.create(
            project=project,
            name="Pilot — onboarding email copy",
            duration=1,
            sprint=sprint,
            story_points=3,
            status="IN_PROGRESS",
            assignee=tom,
        )
        return sprint

    def _build_retro(self, project: Any, maya: Any) -> Any:
        """Retro on the most recently closed sprint with a promoted action item."""
        from trueppm_api.apps.projects.models import (
            RetroActionItem,
            Sprint,
            SprintRetro,
            SprintState,
            Task,
            TaskStatus,
        )

        last_closed = (
            Sprint.objects.filter(project=project, state=SprintState.COMPLETED)
            .order_by("-closed_at")
            .first()
        )
        if last_closed is None:
            return None
        next_planned = (
            Sprint.objects.filter(project=project, state=SprintState.PLANNED)
            .order_by("start_date")
            .first()
        )
        retro = SprintRetro.objects.create(
            sprint=last_closed,
            notes=(
                "What went well: telemetry channel sweep landed on time.\n"
                "What did not: scope crept on day 4 (PM hot-fix). "
                "Next time: lock scope at sprint start, gate hot-fixes through retro."
            ),
            created_by=maya,
        )
        # Three action items; one is promoted into a real task in the next
        # planned sprint so the link chip on the panel renders against
        # actual data.
        promoted_task = None
        if next_planned is not None:
            promoted_task = Task.objects.create(
                project=project,
                name="Lock sprint scope at planning gate",
                duration=1,
                sprint=next_planned,
                story_points=3,
                status=TaskStatus.BACKLOG,
                assignee=maya,
            )
        RetroActionItem.objects.create(
            retro=retro,
            text="Lock sprint scope at planning gate",
            assignee=maya,
            story_points=3,
            promoted_task_id=promoted_task.pk if promoted_task else None,
        )
        RetroActionItem.objects.create(
            retro=retro,
            text="Add scope-add row to retro template",
            assignee=maya,
            story_points=1,
        )
        RetroActionItem.objects.create(
            retro=retro,
            text="Document hot-fix gating in playbook",
            assignee=maya,
            story_points=2,
        )
        return retro
