"""Seed a synthetic program at a chosen scale for capacity testing (issue #2391).

Usage::

    export TRUEPPM_CAPACITY_PASSWORD=...   # required; see _resolve_password
    python manage.py seed_capacity --projects 1 --tasks 4000 --edge-ratio 1.2
    python manage.py seed_capacity --reset

Distinct from ``load_sample_project``, which loads a
*fixed-size* curated fixture for evaluation. This command generates an
arbitrarily large, structurally realistic program so the published scale
envelope can be measured to first sustained breach rather than to a fixed load.

**Not a demo seed.** The rows are synthetic filler; names are generated. Its only
job is to put a defensible shape of data behind the API at a known size.

Fidelity caveats — these are stated in the published envelope, not hidden here:

* Rows are written with ``bulk_create``, so per-row ``save()`` side effects are
  skipped: no ``django-simple-history`` rows, and ``server_version`` stays 0.
  A schedule read does not touch either, so read latency is unaffected — but
  on-disk size and any sync-delta measurement will understate an organically
  grown database.
* Dependencies are generated strictly forward (a lower task index always
  precedes a higher one), which is acyclic by construction. Real programs
  contain the same edge types but a messier topology.
"""

from __future__ import annotations

import os
import random
from datetime import date
from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Dependency,
    Program,
    Project,
    Task,
    bulk_create_tasks,
)
from trueppm_api.apps.sync.sequence import allocate_for_projects

User = get_user_model()

CAPACITY_PROGRAM_CODE = "CAPACITY"
CAPACITY_OWNER_EMAIL = "capacity@trueppm.local"

# The owner is a real, loginable account, so its password is supplied from the
# environment rather than committed — a fixed credential in a tracked file is a
# secret-scanner finding however disposable the stack is (#2457). Same reasoning
# and same `${VAR:?}` compose pattern already used for CAPACITY_INTEGRATION_KEY.
CAPACITY_OWNER_PASSWORD_ENV = "TRUEPPM_CAPACITY_PASSWORD"

MINT_HINT = (
    f"  export {CAPACITY_OWNER_PASSWORD_ENV}=$(python3 -c "
    "'import secrets; print(secrets.token_urlsafe(16))')"
)

# Fixed seed so two runs of the same size produce the same graph — a capacity
# number that moves between runs must be the code changing, not the fixture.
RANDOM_SEED = 23910


class Command(BaseCommand):
    help = "Generate a synthetic program at a chosen scale for capacity testing."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--projects", type=int, default=1, help="Projects to create.")
        parser.add_argument(
            "--tasks", type=int, default=1000, help="Tasks per project (not the total)."
        )
        parser.add_argument(
            "--edge-ratio",
            type=float,
            default=1.0,
            help=(
                "Dependency edges per task. 1.0 is a single chain; above 1.0 adds "
                "forward cross-links. CPM cost is edge-driven, so this is the "
                "dimension that moves recompute time."
            ),
        )
        parser.add_argument(
            "--breadth",
            type=int,
            default=12,
            help="Children per WBS summary row — sets how deep the hierarchy runs.",
        )
        parser.add_argument(
            "--reset",
            action="store_true",
            help="Delete the existing capacity program first (leaves other data alone).",
        )
        parser.add_argument(
            "--member-email",
            default=None,
            help=(
                "Also grant an EXISTING user OWNER membership on every created "
                "project. Lets a harness that authenticates as some other seeded "
                "account read the capacity fixture."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        projects: int = options["projects"]
        tasks_per_project: int = options["tasks"]
        edge_ratio: float = options["edge_ratio"]
        breadth: int = options["breadth"]
        member_email: str | None = options["member_email"]

        if tasks_per_project < 1 or projects < 1:
            raise CommandError("--projects and --tasks must both be >= 1.")
        if edge_ratio < 0:
            raise CommandError("--edge-ratio must be >= 0.")

        rng = random.Random(RANDOM_SEED)
        owner = self._resolve_owner()
        # Resolved BEFORE any writing starts: a typo here must not leave a seeded
        # program the harness cannot read (see _resolve_member).
        member = self._resolve_member(member_email)

        if options["reset"]:
            self._reset(owner)

        program = self._build_program(owner)

        total_tasks = 0
        total_edges = 0
        for index in range(projects):
            created_tasks, created_edges = self._build_project(
                program=program,
                owner=owner,
                member=member,
                index=index,
                task_count=tasks_per_project,
                edge_ratio=edge_ratio,
                breadth=breadth,
                rng=rng,
            )
            total_tasks += created_tasks
            total_edges += created_edges
            self.stdout.write(
                f"  project {index + 1}/{projects}: {created_tasks} tasks, {created_edges} edges"
            )

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded {projects} project(s), {total_tasks} tasks, "
                f"{total_edges} dependency edges under program "
                f"{program.code} ({program.id})."
            )
        )
        if member is not None:
            self.stdout.write(f"  also granted OWNER to {member.email}")

    # ──────────────────────────────────────────────────────────────────
    # Build steps
    # ──────────────────────────────────────────────────────────────────

    def _resolve_password(self) -> str:
        """The load driver's password, from the environment or not at all.

        There is deliberately no default. The alternative — a committed constant
        shared with ``run_capacity.py`` so both sides agree — is what this
        replaces: a fixed password for a real, loginable account is a finding in
        a public tree regardless of how disposable the stack it runs against is
        (#2457). Failing loudly here is also the only way the operator learns the
        runner will fail the same way three steps later.
        """
        password = os.environ.get(CAPACITY_OWNER_PASSWORD_ENV, "").strip()
        if not password:
            raise CommandError(
                f"{CAPACITY_OWNER_PASSWORD_ENV} is not set — the capacity owner's "
                "password is supplied from the environment, never committed. "
                f"Mint a throwaway one:\n{MINT_HINT}\n"
                "See packages/api/perf/capacity/README.md."
            )
        return password

    def _resolve_owner(self) -> Any:
        """The account the load driver authenticates as.

        This command only ever runs against a disposable local capacity stack
        that is torn down with ``down -v``. It must never be pointed at a real
        deployment — hence the dedicated ``capacity@trueppm.local`` identity
        rather than reusing an existing superuser.
        """
        password = self._resolve_password()
        # Held to the configured validators like any other credential, on both
        # paths: an operator-supplied value is arbitrary, so a weak one must fail
        # here rather than quietly standing up a guessable login.
        owner = User.objects.filter(email=CAPACITY_OWNER_EMAIL).first()
        try:
            validate_password(password, user=owner)
        except ValidationError as exc:
            raise CommandError(
                f"The value of {CAPACITY_OWNER_PASSWORD_ENV} does not clear this "
                f"project's password validators: {'; '.join(exc.messages)}\n"
                f"Mint one that does:\n{MINT_HINT}"
            ) from exc
        if owner is None:
            owner = User.objects.create_user(
                username=CAPACITY_OWNER_EMAIL,
                email=CAPACITY_OWNER_EMAIL,
                password=password,
            )
        else:
            owner.set_password(password)
            owner.save(update_fields=["password"])
        return owner

    def _resolve_member(self, email: str | None) -> Any | None:
        """An EXISTING user to also grant membership to, or None.

        Deliberately does not create the account. This flag exists so a harness
        that authenticates as some *other* seeded identity can read the capacity
        fixture — ``perf:load`` mints its JWT for ``seed_integration_fixtures``'
        user and would otherwise get an empty task list, since project reads are
        membership-scoped. Creating a missing user here would hand that harness a
        brand-new account it has no password for, so a typo would surface as a
        silently unreadable fixture — exactly the class of "the number measured
        nothing" defect this seeding path was changed to fix (#2816). Fail instead.
        """
        if email is None:
            return None
        member = User.objects.filter(email=email).first()
        if member is None:
            raise CommandError(
                f"--member-email {email!r} does not match an existing user. This "
                "flag grants membership to an account another seeder already "
                "created; it never creates one. Seed that user first."
            )
        return member

    def _reset(self, owner: Any) -> None:
        """Hard-delete the capacity program's *projects*, so a co-resident dev DB survives.

        Deleting the Program alone is not enough and silently does the wrong
        thing: ``Project.program`` is nullable, so the projects survive as
        orphans and the next seed stacks on top of them — every subsequent
        measurement then runs against more data than its label claims.
        Memberships are cleared first because ``ProjectMembership.project`` is
        ``on_delete=PROTECT``; tasks and dependencies cascade from Project.
        """
        program = Program.objects.filter(code=CAPACITY_PROGRAM_CODE).first()
        if program is None:
            self.stdout.write("reset: no prior capacity program")
            return

        project_ids = list(Project.objects.filter(program=program).values_list("pk", flat=True))
        if not project_ids:
            self.stdout.write("reset: capacity program had no projects")
            return

        ProjectMembership.objects.filter(project_id__in=project_ids).delete()
        deleted, _ = Project.objects.filter(pk__in=project_ids).delete()
        self.stdout.write(
            f"reset: removed {len(project_ids)} prior capacity project(s) ({deleted} rows)"
        )

        # A reset that quietly under-deletes invalidates every number that
        # follows, so prove it rather than assume it.
        remaining = Project.objects.filter(program=program).count()
        if remaining:
            raise CommandError(f"reset failed: {remaining} capacity project(s) still present")

    def _build_program(self, owner: Any) -> Program:
        # ``Program.code`` is deliberately non-unique at the DB level (#2025), so
        # this lookup cannot be constraint-backed.
        # get-or-create-ok: local capacity harness, fixed constant code, single-writer CLI
        program, _ = Program.objects.get_or_create(
            code=CAPACITY_PROGRAM_CODE,
            defaults={"name": "Capacity envelope"},
        )
        return program

    @transaction.atomic
    def _build_project(
        self,
        *,
        program: Program,
        owner: Any,
        member: Any | None,
        index: int,
        task_count: int,
        edge_ratio: float,
        breadth: int,
        rng: random.Random,
    ) -> tuple[int, int]:
        project = Project.objects.create(
            name=f"Capacity project {index + 1}",
            start_date=date(2026, 1, 5),
            program=program,
            lead=owner,
            code=f"CAP{index + 1:03d}",
        )
        # The load driver authenticates as this user, so the membership is what
        # makes every measured read reach a 200 rather than a 403.
        ProjectMembership.objects.get_or_create(
            project=project, user=owner, defaults={"role": Role.OWNER}
        )
        # Same reason as the owner's membership above: without a row here the
        # requesting identity's project-scoped reads return 403/empty.
        if member is not None and member.pk != owner.pk:
            ProjectMembership.objects.get_or_create(
                project=project, user=member, defaults={"role": Role.OWNER}
            )

        # bulk_create bypasses save(), so nothing draws a sync delta cursor for
        # these rows — they would sit at sync_seq=0 and be invisible to the sync
        # pull, which would quietly make a seeded project useless for measuring it
        # (ADR-0686). One value for the whole seed is right: it is one bulk write.
        seq = allocate_for_projects([project.pk])

        tasks = self._make_tasks(project, task_count, breadth, rng)
        for task in tasks:
            task.sync_seq = seq
        # Through the funnel so a WBS-shaped seed declares its containers like every
        # other bulk writer (#3030). Nothing is declared here, and for a reason worth
        # writing down: `_make_tasks` emits ONLY depth-3 leaf paths and never the "1"
        # or "1.1" rows above them, so this project's tree has no parent rows at all.
        # The ancestor sweep therefore reports every one of those missing levels as
        # "outside the batch" and looks them up against nothing. That costs a handful
        # of empty queries, and it means the load fixture can never exercise the
        # declaration path it now routes through — but going around the funnel is what
        # would make the next change to this shape silent.
        bulk_create_tasks(tasks, batch_size=1000)

        # bulk_create bypassed save(), which is what normally advances the
        # per-project short_id counter — reconcile it so any task created through
        # the API afterwards does not collide with a seeded short_id.
        Project.objects.filter(pk=project.pk).update(object_sequence=task_count)

        edges = self._make_edges(tasks, edge_ratio, rng)
        for edge in edges:
            edge.sync_seq = seq
        Dependency.objects.bulk_create(edges, batch_size=1000, ignore_conflicts=True)

        return len(tasks), len(edges)

    def _make_tasks(
        self, project: Project, count: int, breadth: int, rng: random.Random
    ) -> list[Task]:
        """Build a WBS-shaped task list: every `breadth`-th row is a summary parent."""
        tasks: list[Task] = []
        for i in range(count):
            # "1.4.7" style ltree path — depth grows as the index climbs, so a
            # large project has a genuinely deep tree rather than a flat list.
            major = i // (breadth * breadth) + 1
            minor = (i // breadth) % breadth + 1
            leaf = i % breadth + 1
            wbs = f"{major}.{minor}.{leaf}"
            tasks.append(
                Task(
                    project=project,
                    name=f"Capacity task {i + 1}",
                    short_id=f"{i + 1:08X}",
                    wbs_path=wbs,
                    duration=rng.randint(1, 15),
                    percent_complete=0.0,
                )
            )
        return tasks

    def _make_edges(
        self, tasks: list[Task], edge_ratio: float, rng: random.Random
    ) -> list[Dependency]:
        """Forward-only edges: a chain, plus cross-links to reach the target ratio.

        Forward-only (predecessor index < successor index) makes the graph acyclic
        by construction, so the seed can never trip the engine's cycle detection.
        """
        edges: list[Dependency] = []
        if len(tasks) < 2:
            return edges

        # The spine: every task depends on the one before it.
        for i in range(1, len(tasks)):
            edges.append(Dependency(predecessor=tasks[i - 1], successor=tasks[i], dep_type="FS"))

        target = int(len(tasks) * edge_ratio)
        extra = max(0, target - len(edges))
        for _ in range(extra):
            successor_idx = rng.randrange(1, len(tasks))
            # Reach back up to 50 rows, so cross-links stay local rather than
            # spanning the whole project — closer to how real plans are wired.
            predecessor_idx = max(0, successor_idx - rng.randint(2, 50))
            if predecessor_idx >= successor_idx:
                continue
            edges.append(
                Dependency(
                    predecessor=tasks[predecessor_idx],
                    successor=tasks[successor_idx],
                    dep_type=rng.choice(["FS", "SS", "FF"]),
                )
            )
        return edges
