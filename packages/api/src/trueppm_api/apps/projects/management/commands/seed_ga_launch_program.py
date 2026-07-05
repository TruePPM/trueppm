"""Seed the "1.0 GA Launch" hybrid sample program (issue #1151).

Builds one OSS ``Program`` of four workstream projects that ship a single
outcome (a fictional 1.0 GA launch), so an evaluator can see the thing that
makes a P3M tool worth using in a way a standalone demo project cannot: a
program of related projects where **shared people** and **cross-project
dependencies** create real coordination pressure.

The four workstreams are outcomes, not departments:

* **A — Platform Hardening & Scale** (waterfall)
* **B — SOC 2 Type II Readiness** (waterfall, gated governance)
* **C — Security Pen-Test & Remediation** (hybrid; remediation Kanban)
* **D — GA Marketing & Launch** (agile; two sprints)

The showcase is a critical path that runs *across* projects, formed by three
**accepted** cross-project dependency edges:

* ``B3`` (SOC 2 evidence) ← ``C5`` (Security sign-off)
* ``D5`` (GA go-live) ← ``A5`` (Platform GA-ready) **and** ← ``C5``

Those edges are real ``Dependency`` rows (``pending_acceptance=False``), so the
program-scoped CPM pass (ADR-0120 D3) computes a genuine, program-true critical
path that stays correct when an evaluator drags a task — a static / SNET-faked
path was explicitly rejected in #1151. The command sets **no** CPM outputs
(``early_start``/``is_critical``/floats); it runs the real program pass after
seeding so the schedule is computed, never hard-coded.

Idempotent — re-running clears any prior "1.0 GA Launch" program (by name) and
re-seeds. With ``--with-personas`` the seven persona logins get the resolved
demo password so an operator can sign in as any role; without it the accounts
still exist (the RBAC matrix and assignments need them) but carry unusable
passwords.

Usage::

    python manage.py seed_ga_launch_program
    python manage.py seed_ga_launch_program --with-personas
"""

from __future__ import annotations

import logging
import os
import secrets
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

# Program name is the idempotency key — a re-run clears and rebuilds any program
# with this exact name. Sales demos and CI fixtures should treat it as reserved.
PROGRAM_NAME = "1.0 GA Launch"
PROGRAM_CODE = "GALA"

# All four projects are anchored to this Monday so the overlapping windows line
# up deterministically (spec §6). 2026-07-06 is a Monday.
PROGRAM_START = date(2026, 7, 6)

# One company holiday exercises calendar-aware scheduling/lag. 2026-09-07 is the
# US Labor Day (first Monday of September 2026).
HOLIDAY = date(2026, 9, 7)

# Env var an operator can set to choose a known demo-account password. Mirrors
# seed_demo_project (#1350): never a fixed, guessable password on a public
# instance — "demo" only under DEBUG, else a printed-once random token.
DEMO_PASSWORD_ENV = "TRUEPPM_DEMO_PASSWORD"

# (username, first, last, job_role). Dana owns the program; the other six span
# the four workstreams so shared people over-allocate (spec §5).
PERSONAS = [
    ("dana", "Dana", "Okafor", "Program Manager"),
    ("malcolm", "Malcolm", "Reed", "Platform Engineer"),
    ("janus", "Janus", "Vela", "InfoSec Engineer"),
    ("bob", "Bob", "Tran", "Compliance Officer"),
    ("jane", "Jane", "Castellano", "Marketing Lead"),
    ("lena", "Lena", "Fischer", "Technical Writer"),
    ("sam", "Sam", "Ortiz", "Backend Engineer"),
]


class Command(BaseCommand):
    """Seed the "1.0 GA Launch" hybrid sample program (#1151, idempotent)."""

    help = 'Seed the "1.0 GA Launch" hybrid sample program (idempotent).'

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--with-personas",
            action="store_true",
            help=(
                "Give the seven persona accounts the resolved demo password so they are "
                "loginable. Without it the accounts still exist (the RBAC matrix and "
                "assignments need them) but carry unusable passwords."
            ),
        )

    def handle(self, *args: object, **options: object) -> None:
        with_personas = bool(options.get("with_personas"))
        password, password_source = self._resolve_demo_password() if with_personas else (None, None)

        # Seed the whole program in one transaction so a failure leaves no partial
        # program behind. The CPM pass runs *after* commit (below) so it reads
        # committed rows and its own on_commit hooks fire normally.
        with transaction.atomic():
            program = self._seed(password, with_personas)

        # Run the real program-scoped CPM pass (ADR-0120 D3). The three accepted
        # cross-project edges make program_has_accepted_cross_edges() true, so this
        # is the pass that would be escalated to in production; calling its
        # extracted synchronous entrypoint here gives the command a fully computed
        # program-true schedule (cross-project critical path, floats, criticality)
        # without a broker. Nothing in the seed set CPM outputs.
        from trueppm_api.apps.scheduling.tasks import _run_program_schedule

        _run_program_schedule(str(program.pk))

        self._report(program, with_personas, password, password_source)

    # ------------------------------------------------------------------
    # Orchestration
    # ------------------------------------------------------------------

    def _seed(self, password: str | None, with_personas: bool) -> Any:
        from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
        from trueppm_api.apps.access.services import create_program
        from trueppm_api.apps.projects.models import Methodology, Visibility

        self._reset()

        users = self._build_personas(password, with_personas)
        calendar = self._build_calendar()

        # create_program mints the OWNER ProgramMembership for the creator (Dana),
        # so the program always has an owner. Per-project ownership is the four
        # workstream leads (spec §7); Dana is program OWNER + project ADMIN.
        program = create_program(
            name=PROGRAM_NAME,
            description=(
                "Ship TruePPM 1.0 to GA: platform scale, security sign-off, SOC 2 "
                "audit-readiness, and a coordinated launch — four workstreams, one outcome."
            ),
            methodology=Methodology.HYBRID,
            created_by=users["dana"],
        )
        program.code = PROGRAM_CODE
        program.lead = users["dana"]
        program.visibility = Visibility.WORKSPACE
        program.save(update_fields=["code", "lead", "visibility"])

        # The four workstream leads join the program as MEMBER (spec §7).
        for username in ("malcolm", "bob", "janus", "jane"):
            ProgramMembership.objects.update_or_create(
                program=program, user=users[username], defaults={"role": Role.MEMBER}
            )

        resources = self._build_resources(users, calendar)

        # Build all four projects and index every task by its short id ("A1"…"D5")
        # so cross-project dependency edges can resolve endpoints in any project.
        tasks: dict[str, Any] = {}
        projects = self._build_projects(program, calendar, users)
        self._build_tasks(projects, users, tasks)
        self._build_dependencies(tasks, users["dana"])
        self._build_assignments(projects, tasks, resources)
        self._build_project_memberships(projects, users, Role, ProjectMembership)
        self._build_board_config(projects["C"])
        self._build_sprints(projects["D"], tasks, users["dana"])

        return program

    def _reset(self) -> None:
        """Idempotent teardown of a prior "1.0 GA Launch" program.

        ``ProjectMembership.project`` and ``ProgramMembership.program`` are both
        ``on_delete=PROTECT``, so memberships must be deleted before the rows they
        guard. Deleting the projects cascades their tasks (and thus every
        cross-project ``Dependency``, whose endpoints are ``on_delete=CASCADE``),
        sprints, burndown snapshots, board config, and task/project resource rows.
        Global ``Resource`` rows carry no program FK, so they are matched by the
        demo email domain and cleared to avoid duplicate people on a reload.
        """
        from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership
        from trueppm_api.apps.projects.models import Program, Project
        from trueppm_api.apps.resources.models import Resource

        prior = Program.objects.filter(name=PROGRAM_NAME)
        if prior.exists():
            project_ids = list(
                Project.objects.filter(program__in=prior).values_list("pk", flat=True)
            )
            ProjectMembership.objects.filter(project_id__in=project_ids).delete()
            Project.objects.filter(pk__in=project_ids).delete()
            ProgramMembership.objects.filter(program__in=prior).delete()
            deleted = prior.delete()
            self.stdout.write(f"Cleared {deleted[0]} prior '{PROGRAM_NAME}' row(s).")
        Resource.objects.filter(email__endswith="@trueppm.demo").delete()

    # ------------------------------------------------------------------
    # Personas + resources
    # ------------------------------------------------------------------

    def _resolve_demo_password(self) -> tuple[str, str]:
        """Resolve the persona login password and its source (mirrors #1350).

        A fixed weak password must never reach a public (non-DEBUG) instance.
        Resolution order: ``TRUEPPM_DEMO_PASSWORD`` env var, then ``"demo"`` under
        ``DEBUG``, else a random token printed once so the operator can record it.
        """
        env_password = os.environ.get(DEMO_PASSWORD_ENV)
        if env_password:
            return env_password, "env"
        if settings.DEBUG:
            return "demo", "debug"
        return secrets.token_urlsafe(16), "generated"

    def _build_personas(self, password: str | None, with_personas: bool) -> dict[str, Any]:
        """Create/refresh the seven persona ``User`` accounts.

        The accounts always exist because the RBAC matrix, project leads, and task
        assignees all reference them (spec §7/§6). ``--with-personas`` sets the
        resolved demo password so they are loginable; otherwise the password is
        unusable — the demo data is complete but no dormant weak logins are minted.
        """
        User = get_user_model()
        out: dict[str, Any] = {}
        for username, first, last, _job_role in PERSONAS:
            user, _ = User.objects.update_or_create(
                username=username,
                defaults={
                    "email": f"{username}@trueppm.demo",
                    "first_name": first,
                    "last_name": last,
                },
            )
            if with_personas and password is not None:
                # Demo-seed fixture: password resolved by _resolve_demo_password
                # (env > "demo" under DEBUG > random token), not an interactive
                # signup — password validators do not apply.
                # nosemgrep: unvalidated-password
                user.set_password(password)
            else:
                # Unusable password (Django sets a sentinel hash, not a real
                # credential) — nothing to validate.
                # nosemgrep: unvalidated-password
                user.set_password(None)
            user.save(update_fields=["password"])
            out[username] = user
        return out

    def _build_resources(self, users: dict[str, Any], calendar: Any) -> dict[str, Any]:
        """One ``Resource`` per persona, linked to the ``User`` and shared calendar."""
        from trueppm_api.apps.resources.models import Resource

        out: dict[str, Any] = {}
        for username, first, last, job_role in PERSONAS:
            out[username] = Resource.objects.create(
                name=f"{first} {last}",
                email=f"{username}@trueppm.demo",
                job_role=job_role,
                max_units=Decimal("1.0"),
                calendar=calendar,
                user=users[username],
            )
        return out

    # ------------------------------------------------------------------
    # Calendar
    # ------------------------------------------------------------------

    def _build_calendar(self) -> Any:
        """Shared "Standard 5-day" calendar (Mon–Fri) with one company holiday.

        ``working_days=31`` is the Mon–Fri bitmask (Mon 1 + Tue 2 + Wed 4 + Thu 8
        + Fri 16). The single ``CalendarException`` (Labor Day) exercises
        calendar-aware scheduling and lag across the program.
        """
        from trueppm_api.apps.projects.models import Calendar, CalendarException

        calendar = Calendar.objects.create(
            name="Standard 5-day",
            working_days=31,
            hours_per_day=8.0,
            timezone="UTC",
        )
        CalendarException.objects.create(
            calendar=calendar,
            exc_start=HOLIDAY,
            exc_end=HOLIDAY,
            description="Labor Day (company holiday)",
        )
        return calendar

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    def _build_projects(self, program: Any, calendar: Any, users: dict[str, Any]) -> dict[str, Any]:
        from trueppm_api.apps.projects.models import Methodology, Project

        # (key, name, methodology, agile_features, lead-username)
        specs = [
            ("A", "Platform Hardening & Scale", Methodology.WATERFALL, False, "malcolm"),
            ("B", "SOC 2 Type II Readiness", Methodology.WATERFALL, False, "bob"),
            ("C", "Security Pen-Test & Remediation", Methodology.HYBRID, True, "janus"),
            ("D", "GA Marketing & Launch", Methodology.AGILE, True, "jane"),
        ]
        out: dict[str, Any] = {}
        for key, name, methodology, agile, lead in specs:
            out[key] = Project.objects.create(
                program=program,
                name=name,
                start_date=PROGRAM_START,
                calendar=calendar,
                methodology=methodology,
                agile_features=agile,
                lead=users[lead],
                is_sample=True,
            )
        return out

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    def _build_tasks(
        self, projects: dict[str, Any], users: dict[str, Any], tasks: dict[str, Any]
    ) -> None:
        """Create every workstream task. CPM outputs are deliberately left unset.

        Each spec row becomes one flat leaf task (siblings, no WBS decomposition —
        these are workstreams, not decomposed phases). ``planned_start`` is left
        null so the scheduler computes earliest-possible dates from the dependency
        graph; the cross-project edges (not a hard-coded SNET) drive the sequence.
        """
        from trueppm_api.apps.projects.models import (
            DeliveryMode,
            GovernanceClass,
            Task,
            TaskType,
        )

        # (key, project, name, duration, is_milestone, type, governance_class,
        #  delivery_mode, story_points, assignee-username)
        specs = [
            # A — Platform Hardening & Scale (waterfall)
            (
                "A1",
                "A",
                "Capacity baseline & load test",
                5,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.WATERFALL,
                None,
                "malcolm",
            ),
            (
                "A2",
                "A",
                "Autoscaling & HA rollout",
                8,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.WATERFALL,
                None,
                "malcolm",
            ),
            (
                "A3",
                "A",
                "DB failover hardening",
                6,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.WATERFALL,
                None,
                "sam",
            ),
            (
                "A4",
                "A",
                "Observability & alerting",
                4,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.WATERFALL,
                None,
                "malcolm",
            ),
            (
                "A5",
                "A",
                "Platform GA-ready",
                0,
                True,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.MILESTONE,
                None,
                "malcolm",
            ),
            # B — SOC 2 Type II Readiness (waterfall, gated)
            (
                "B1",
                "B",
                "Control gap assessment",
                5,
                False,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.WATERFALL,
                None,
                "bob",
            ),
            (
                "B2",
                "B",
                "Policy authoring",
                8,
                False,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.WATERFALL,
                None,
                "bob",
            ),
            (
                "B3",
                "B",
                "Evidence collection",
                6,
                False,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.WATERFALL,
                None,
                "bob",
            ),
            (
                "B4",
                "B",
                "Internal readiness review",
                3,
                False,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.WATERFALL,
                None,
                "bob",
            ),
            (
                "B5",
                "B",
                "Audit-ready",
                0,
                True,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.MILESTONE,
                None,
                "bob",
            ),
            # C — Security Pen-Test & Remediation (hybrid; remediation Kanban)
            (
                "C1",
                "C",
                "Pen-test execution",
                5,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.KANBAN,
                None,
                "janus",
            ),
            (
                "C2",
                "C",
                "Findings triage",
                2,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.KANBAN,
                None,
                "janus",
            ),
            (
                "C3",
                "C",
                "Remediate critical findings",
                7,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.KANBAN,
                None,
                "janus",
            ),
            (
                "C4",
                "C",
                "Re-test & verification",
                3,
                False,
                TaskType.TASK,
                GovernanceClass.FLOW,
                DeliveryMode.KANBAN,
                None,
                "janus",
            ),
            (
                "C5",
                "C",
                "Security sign-off",
                0,
                True,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.MILESTONE,
                None,
                "janus",
            ),
            # D — GA Marketing & Launch (agile; SCRUM stories + go-live milestone)
            (
                "D1",
                "D",
                "Messaging & positioning",
                3,
                False,
                TaskType.STORY,
                GovernanceClass.FLOW,
                DeliveryMode.SCRUM,
                5,
                "jane",
            ),
            (
                "D2",
                "D",
                "Website & landing pages",
                5,
                False,
                TaskType.STORY,
                GovernanceClass.FLOW,
                DeliveryMode.SCRUM,
                8,
                "jane",
            ),
            (
                "D3",
                "D",
                "Launch blog & docs",
                3,
                False,
                TaskType.STORY,
                GovernanceClass.FLOW,
                DeliveryMode.SCRUM,
                5,
                "lena",
            ),
            (
                "D4",
                "D",
                "Press & analyst outreach",
                3,
                False,
                TaskType.STORY,
                GovernanceClass.FLOW,
                DeliveryMode.SCRUM,
                5,
                "jane",
            ),
            (
                "D5",
                "D",
                "GA announcement go-live",
                0,
                True,
                TaskType.TASK,
                GovernanceClass.GATED,
                DeliveryMode.MILESTONE,
                None,
                "jane",
            ),
        ]

        # Per-project sibling wbs index ("1".."5"). Flat single-label paths carry no
        # parent/child relationship, so every task is a CPM leaf (no summary rollup).
        wbs_counter: dict[str, int] = {}
        for key, proj_key, name, dur, is_ms, ttype, gov, delivery, points, assignee in specs:
            wbs_counter[proj_key] = wbs_counter.get(proj_key, 0) + 1
            tasks[key] = Task.objects.create(
                project=projects[proj_key],
                name=name,
                wbs_path=str(wbs_counter[proj_key]),
                duration=dur,
                is_milestone=is_ms,
                type=ttype,
                governance_class=gov,
                delivery_mode=delivery,
                story_points=points,
                assignee=users[assignee],
            )

    def _build_dependencies(self, tasks: dict[str, Any], accepter: Any) -> None:
        """Wire within-project chains plus the three accepted cross-project edges.

        The cross-project edges (``B3←C5``, ``D5←A5``, ``D5←C5``) are created
        ``pending_acceptance=False`` (accepted) so the program-scoped CPM pass
        includes them — that is what makes the critical path program-true across
        the boundary rather than a per-project illusion (ADR-0120 D2/D3). Within-
        project edges are never pending.
        """
        from trueppm_api.apps.projects.models import Dependency

        now = timezone.now()

        # (predecessor-key, successor-key, dep_type, is_cross_project)
        links = [
            # A — fan-out from the baseline, converging on the GA-ready milestone.
            ("A1", "A2", "FS", False),
            ("A1", "A3", "FS", False),
            ("A2", "A4", "SS", False),  # observability spins up with the rollout
            ("A2", "A5", "FS", False),
            ("A3", "A5", "FS", False),
            ("A4", "A5", "FS", False),
            # B — linear control → policy → evidence → review → audit-ready.
            ("B1", "B2", "FS", False),
            ("B2", "B3", "FS", False),
            ("B4", "B5", "FS", False),
            ("B3", "B4", "FS", False),
            # C — linear pen-test → triage → remediate → re-test → sign-off.
            ("C1", "C2", "FS", False),
            ("C2", "C3", "FS", False),
            ("C3", "C4", "FS", False),
            ("C4", "C5", "FS", False),
            # D — stories fan out from messaging; go-live gates on the program.
            ("D1", "D3", "FS", False),
            ("D1", "D4", "FS", False),
            # Cross-project showcase edges — the program-true critical path.
            ("C5", "B3", "FS", True),  # SOC 2 evidence waits on Security sign-off
            ("A5", "D5", "FS", True),  # GA go-live waits on Platform GA-ready
            ("C5", "D5", "FS", True),  # GA go-live waits on Security sign-off
        ]
        for pred_key, succ_key, dep_type, is_cross in links:
            Dependency.objects.create(
                predecessor=tasks[pred_key],
                successor=tasks[succ_key],
                dep_type=dep_type,
                lag=0,
                # Cross-project edges are consent-gated (ADR-0120 D2); seed them
                # accepted so the program pass treats them as modeled constraints.
                pending_acceptance=False,
                accepted_by=accepter if is_cross else None,
                accepted_at=now if is_cross else None,
            )

    # ------------------------------------------------------------------
    # Resource assignments (deliberate contention)
    # ------------------------------------------------------------------

    def _build_assignments(
        self, projects: dict[str, Any], tasks: dict[str, Any], resources: dict[str, Any]
    ) -> None:
        """Assign shared people so they over-allocate in overlapping windows (spec §5).

        The over-allocation must be visible *after* the real CPM pass, not merely
        asserted. Two contention pairs hold under the honest schedule:

        * **Malcolm** runs Platform ``A2`` (1.0) while pulled into Security
          remediation ``C3`` (0.5); ``A2`` and ``C3`` overlap in the second/third
          program week → >100%.
        * **Janus** leads the Security chain ``C1–C4`` (1.0) while contributing
          SOC 2 control evidence on ``B2`` (0.5); ``B2`` runs concurrently with his
          ``C2/C3`` work → >100%.

        Note on Janus and ``B3``: the spec §5 narrative expected Janus's overlap to
        come from ``B3`` (evidence collection), but the cross-project edge
        ``B3←C5`` gates ``B3`` to *after* the entire Security chain finishes, so it
        cannot overlap his C-work. Modeling the schedule honestly (spec §4), the
        visible contention comes from the concurrent ``B2`` evidence-authoring
        window instead; Janus stays on ``B3`` too, it just is not the overlapping
        assignment. Milestones (0 duration) carry an assignee but no allocation.
        """
        from trueppm_api.apps.resources.models import TaskResource
        from trueppm_api.apps.resources.services import ensure_project_resource

        # (task-key, resource-username, units)
        assignments = [
            # A — Platform
            ("A1", "malcolm", "1.0"),
            ("A1", "sam", "1.0"),
            ("A2", "malcolm", "1.0"),  # overlaps C3 → contention
            ("A3", "sam", "1.0"),
            ("A4", "malcolm", "0.5"),
            # B — SOC 2
            ("B1", "bob", "1.0"),
            ("B2", "bob", "1.0"),
            ("B2", "lena", "0.5"),
            ("B2", "janus", "0.5"),  # evidence authoring — overlaps C2/C3 → contention
            ("B3", "bob", "1.0"),
            ("B3", "janus", "0.5"),
            ("B4", "bob", "1.0"),
            # C — Security
            ("C1", "janus", "1.0"),
            ("C2", "janus", "1.0"),
            ("C3", "janus", "1.0"),
            ("C3", "malcolm", "0.5"),  # remediation pull — overlaps A2 → contention
            ("C3", "sam", "0.5"),
            ("C4", "janus", "1.0"),
            # D — Marketing
            ("D1", "jane", "1.0"),
            ("D2", "jane", "1.0"),
            ("D2", "lena", "0.5"),
            ("D3", "lena", "0.5"),
            ("D4", "jane", "1.0"),
        ]
        for task_key, res_username, units in assignments:
            task = tasks[task_key]
            resource = resources[res_username]
            TaskResource.objects.create(task=task, resource=resource, units=Decimal(units))
            # Mirror the API auto-roster so the program's Team views are populated.
            ensure_project_resource(task.project, resource)

    # ------------------------------------------------------------------
    # RBAC matrix (spec §7)
    # ------------------------------------------------------------------

    def _build_project_memberships(
        self,
        projects: dict[str, Any],
        users: dict[str, Any],
        Role: Any,
        ProjectMembership: Any,
    ) -> None:
        """Bind the per-project 5-role matrix so every role is exercised (spec §7)."""
        # project-key -> [(username, Role), …]
        matrix: dict[str, list[tuple[str, Any]]] = {
            "A": [
                ("malcolm", Role.OWNER),
                ("dana", Role.ADMIN),
                ("sam", Role.MEMBER),
                ("janus", Role.VIEWER),
            ],
            "B": [
                ("bob", Role.OWNER),
                ("dana", Role.ADMIN),
                ("lena", Role.MEMBER),
                ("janus", Role.MEMBER),
            ],
            "C": [
                ("janus", Role.OWNER),
                ("dana", Role.ADMIN),
                ("malcolm", Role.SCHEDULER),
                ("sam", Role.MEMBER),
                ("bob", Role.VIEWER),
            ],
            "D": [
                ("jane", Role.OWNER),
                ("dana", Role.ADMIN),
                ("lena", Role.MEMBER),
                ("bob", Role.VIEWER),
            ],
        }
        for proj_key, members in matrix.items():
            for username, role in members:
                ProjectMembership.objects.update_or_create(
                    project=projects[proj_key],
                    user=users[username],
                    defaults={"role": role},
                )

    # ------------------------------------------------------------------
    # Board config (Security remediation Kanban)
    # ------------------------------------------------------------------

    def _build_board_config(self, security_project: Any) -> None:
        """Kanban board for the Security remediation flow, with a WIP limit."""
        from trueppm_api.apps.projects.models import BoardColumnConfig

        BoardColumnConfig.objects.update_or_create(
            project=security_project,
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
                        "label": "Not started",
                        "visible": True,
                        "color": "#64748B",
                        "wip_limit": None,
                    },
                    {
                        "status": "IN_PROGRESS",
                        "label": "In progress",
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
                        "label": "Complete",
                        "visible": True,
                        "color": "#22C55E",
                        "wip_limit": None,
                    },
                ],
            },
        )

    # ------------------------------------------------------------------
    # Sprints + burndown (Project D)
    # ------------------------------------------------------------------

    def _build_sprints(self, marketing_project: Any, tasks: dict[str, Any], binder: Any) -> None:
        """Two sprints on the Marketing project: a closed one (velocity) + an active one.

        S1 "Launch Readiness" is COMPLETED with committed 18 / completed 16 so a
        realistic velocity is computable (it is *not* excluded from velocity), and
        it carries daily burndown snapshots. S2 "Launch Week" is ACTIVE and bound
        to the ``D5`` go-live milestone.
        """
        from trueppm_api.apps.projects.models import Sprint, SprintBurnSnapshot, SprintState

        def _dt(day: date) -> datetime:
            return datetime.combine(day, datetime.min.time(), tzinfo=UTC)

        # S1 — closed, two weeks. Committed = D1+D2+D3 (5+8+5 = 18); completed just
        # under commit for a realistic velocity number.
        s1_start = PROGRAM_START
        s1_finish = PROGRAM_START + timedelta(days=11)  # Fri of week 2
        s1 = Sprint.objects.create(
            project=marketing_project,
            name="Launch Readiness",
            goal="Land messaging, the launch site, and the blog/docs draft.",
            start_date=s1_start,
            finish_date=s1_finish,
            state=SprintState.COMPLETED,
            capacity_points=18,
            committed_points=18,
            committed_task_count=3,
            completed_points=16,
            completed_task_count=3,
            exclude_from_velocity=False,
            activated_at=_dt(s1_start),
            closed_at=_dt(s1_finish),
        )
        for key in ("D1", "D2", "D3"):
            tasks[key].sprint = s1
            tasks[key].save(update_fields=["sprint"])
        self._build_burndown(s1, SprintBurnSnapshot, s1_start)

        # S2 — active, two weeks, bound to the GA go-live milestone.
        s2_start = PROGRAM_START + timedelta(days=14)
        s2_finish = s2_start + timedelta(days=11)
        s2 = Sprint.objects.create(
            project=marketing_project,
            name="Launch Week",
            goal="Run press & analyst outreach and execute the GA go-live.",
            start_date=s2_start,
            finish_date=s2_finish,
            state=SprintState.ACTIVE,
            capacity_points=10,
            committed_points=5,  # D4 (D5 is a 0-point milestone)
            committed_task_count=2,
            activated_at=_dt(s2_start),
            target_milestone=tasks["D5"],
            milestone_bound_by=binder,
            milestone_bound_at=timezone.now(),
        )
        for key in ("D4", "D5"):
            tasks[key].sprint = s2
            tasks[key].save(update_fields=["sprint"])

    def _build_burndown(self, sprint: Any, SprintBurnSnapshot: Any, start: date) -> None:
        """Daily burndown for the closed sprint, with one mid-sprint scope injection.

        The actual line trails the ideal slightly (a realistic "a bit behind"
        trend), and a +2-point scope change lands on day 4 so the scope-change
        columns are populated. ``update_or_create`` on ``(sprint, snapshot_date)``
        keeps the scripted series authoritative even if a task-save signal already
        wrote a row for a given day.
        """
        committed = 18
        days = 10  # snapshots for days 0..9 across the two-week window
        for offset in range(days):
            day = start + timedelta(days=offset)
            ideal_remaining = committed * (1 - offset / (days - 1))
            actual_remaining = max(0, round(ideal_remaining) + 2)  # ~2 pts behind ideal
            scope_change = 2 if offset == 4 else 0
            SprintBurnSnapshot.objects.update_or_create(
                sprint=sprint,
                snapshot_date=day,
                defaults={
                    "remaining_points": actual_remaining + scope_change,
                    "remaining_task_count": max(0, 3 - offset // 4),
                    "completed_points": max(0, committed - actual_remaining),
                    "completed_task_count": min(3, offset // 3),
                    "scope_change_points": scope_change,
                    "scope_change_task_count": 1 if scope_change else 0,
                },
            )

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def _report(
        self,
        program: Any,
        with_personas: bool,
        password: str | None,
        password_source: str | None,
    ) -> None:
        from trueppm_api.apps.projects.models import Project

        count = Project.objects.filter(program=program).count()
        self.stdout.write(self.style.SUCCESS(""))
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write(
            self.style.SUCCESS(f"  Seeded {PROGRAM_NAME!r} — {count} workstream project(s)")
        )
        names = ", ".join(username for username, *_ in PERSONAS)
        if with_personas:
            # Do not re-echo an operator-supplied secret (#1350); only surface the
            # generated token or the well-known dev default.
            detail = (
                f"password set via {DEMO_PASSWORD_ENV}"
                if password_source == "env"
                else f"password={password!r}"
            )
            self.stdout.write(self.style.SUCCESS(f"  Personas (loginable): {names} ({detail})"))
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    f"  Personas (no login — pass --with-personas to enable): {names}"
                )
            )
        self.stdout.write(
            self.style.SUCCESS(
                "  Cross-project critical path computed via program-scoped CPM (ADR-0120)."
            )
        )
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write("")
