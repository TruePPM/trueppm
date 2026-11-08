"""The draft lifecycle and its exclusion list (#2962).

Three things must stay true, and each has been got wrong somewhere before:

1. ``lifecycle`` is not ``is_archived``. A draft is fully WRITABLE — conflating
   them would make Resume impossible, which is the entire point of a draft.
2. A draft is excluded from anything that AGGREGATES. A half-built plan inside a
   rollup makes that rollup a guess with a chart around it.
3. A draft is NOT hidden from a direct read. Exclusion-from-reads is
   indistinguishable from a 404, which is why the MCP surface returns
   ``lifecycle`` as a field instead.

``TestEveryExcludedSurface`` (#3128) is the per-call-site half of point 2. The
exclusion list named four surfaces and was wired into two of them, so the other
surfaces below were each leaking. **Every test there flips the same project back
to ACTIVE and asserts the surface then DOES show it** — without that second half a
passing assertion proves only that the fixture was empty, which is exactly how a
missing filter reads as a green test.
"""

from __future__ import annotations

import datetime
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.lifecycle import is_draft, visible_projects
from trueppm_api.apps.projects.models import (
    Baseline,
    Calendar,
    Program,
    Project,
    ProjectLifecycle,
    Task,
    TaskStatus,
)


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="lifeuser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Artemis")


@pytest.mark.django_db
class TestLifecycleIsNotArchived:
    def test_existing_projects_default_to_active(self, calendar: Calendar) -> None:
        """No backfill: every project that already exists is committed."""
        p = Project.objects.create(name="A", start_date=date(2026, 3, 2), calendar=calendar)
        assert p.lifecycle == ProjectLifecycle.ACTIVE
        assert not is_draft(p)

    def test_a_draft_is_writable(self, calendar: Calendar) -> None:
        """The whole distinction from is_archived.

        Archived is hard read-only, refused on the project and every nested
        viewset. If a draft behaved that way, Resume — the reason drafts exist —
        would be impossible.
        """
        p = Project.objects.create(
            name="Draft",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        assert p.is_archived is False
        p.name = "Renamed while draft"
        p.save()
        p.refresh_from_db()
        assert p.name == "Renamed while draft"


@pytest.mark.django_db
class TestExclusionFromAggregates:
    def test_visible_projects_drops_drafts(self, calendar: Calendar, program: Program) -> None:
        Project.objects.create(
            name="Committed", start_date=date(2026, 3, 2), calendar=calendar, program=program
        )
        Project.objects.create(
            name="Half-built",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            program=program,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        names = set(
            visible_projects(Project.objects.filter(program=program)).values_list("name", flat=True)
        )
        assert names == {"Committed"}

    def test_the_program_rollup_excludes_a_draft(
        self, calendar: Calendar, program: Program
    ) -> None:
        """The surface a PMO puts in front of a CEO."""
        from trueppm_api.apps.projects.program_rollup import compute_program_rollup

        Project.objects.create(
            name="Committed", start_date=date(2026, 3, 2), calendar=calendar, program=program
        )
        Project.objects.create(
            name="Half-built",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            program=program,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        rollup = compute_program_rollup(program)
        assert rollup is not None
        blob = str(rollup)
        assert "Half-built" not in blob


@pytest.mark.django_db
class TestDraftsAreNotSecret:
    def test_a_direct_read_still_returns_the_draft(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        """Exclusion is about aggregates, not access.

        Hiding it here would be indistinguishable from a 404 — the failure the
        MCP correction exists to avoid.
        """
        p = Project.objects.create(
            name="Draft",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
        r = client.get(f"/api/v1/projects/{p.id}/")
        assert r.status_code == 200

    def test_lifecycle_is_a_stated_field_a_client_can_filter_on(
        self, client: APIClient, user: object, calendar: Calendar
    ) -> None:
        p = Project.objects.create(
            name="Draft",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
        r = client.get(f"/api/v1/projects/{p.id}/")
        assert r.data["lifecycle"] == "draft"


# ---------------------------------------------------------------------------
# The exclusion list, applied per call site (#3128)
# ---------------------------------------------------------------------------


def _commit(project: Project) -> Project:
    """Flip a draft to ACTIVE, for the "and now it DOES appear" half of each test."""
    project.lifecycle = ProjectLifecycle.ACTIVE
    project.save(update_fields=["lifecycle"])
    return project


def _overdue_task(project: Project, name: str) -> Task:
    """A task that drags its project into the ``critical`` schedule-health band.

    SPI = complete-by-today / planned-by-today, so one long-past ``early_finish``
    with nothing complete is enough.
    """
    return Task.objects.create(
        project=project,
        name=name,
        duration=1,
        early_finish=date(2026, 2, 1),
        status=TaskStatus.IN_PROGRESS,
    )


@pytest.fixture
def committed(user: Any, calendar: Calendar, program: Program) -> Project:
    p = Project.objects.create(
        name="Committed", start_date=date(2026, 3, 2), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.fixture
def draft(user: Any, calendar: Calendar, program: Program) -> Project:
    p = Project.objects.create(
        name="Half-built",
        start_date=date(2026, 3, 2),
        calendar=calendar,
        program=program,
        lifecycle=ProjectLifecycle.DRAFT,
    )
    ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
    return p


@pytest.mark.django_db
class TestEveryExcludedSurface:
    """One test per call site routed through the helper by #3128."""

    # -- portfolio health ---------------------------------------------------

    def test_top_contributing_project_never_names_a_draft(
        self, program: Program, committed: Project, draft: Project
    ) -> None:
        """The weekly program-health email deep-links one project by name.

        Naming a plan nobody has committed to would send a PMO into a half-built
        schedule and call it the cause of the band.
        """
        from trueppm_api.apps.projects.program_rollup import top_contributing_project

        _overdue_task(draft, "Late")

        assert top_contributing_project(program) is None

        _commit(draft)
        named = top_contributing_project(program)
        assert named is not None
        assert named["name"] == "Half-built"

    def test_health_summary_excludes_a_draft(
        self, client: APIClient, committed: Project, draft: Project
    ) -> None:
        """``/projects/health-summary/`` — the "which of mine is on fire?" triage."""
        url = "/api/v1/projects/health-summary/"

        rows = client.get(url).data
        assert {r["name"] for r in rows} == {"Committed"}

        _commit(draft)
        rows = client.get(url).data
        assert {r["name"] for r in rows} == {"Committed", "Half-built"}

    def test_me_work_signals_excludes_a_draft(
        self, user: Any, committed: Project, draft: Project
    ) -> None:
        """The My Work band reduces WORST-first, so one draft would set it alone."""
        from trueppm_api.apps.projects.services import me_work_signals

        _overdue_task(draft, "Late")

        assert "schedule_health" not in me_work_signals(user, active_sprints=[])

        _commit(draft)
        signals = me_work_signals(user, active_sprints=[])
        assert signals["schedule_health"]["band"] == "critical"

    def test_program_directory_project_count_excludes_a_draft(
        self, client: APIClient, user: Any, program: Program, committed: Project, draft: Project
    ) -> None:
        """The badge must count the same set the tab it opens lists.

        ``ProgramViewSet.projects`` already excluded drafts, so a counted draft
        made the directory say 2 and the drill-through show 1.
        """
        ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)

        def _count() -> int:
            body = client.get("/api/v1/programs/").data
            rows = body["results"] if isinstance(body, dict) else body
            return int(next(r for r in rows if r["name"] == "Artemis")["project_count"])

        assert _count() == 1

        _commit(draft)
        assert _count() == 2

    def test_resource_contention_excludes_a_draft(
        self, client: APIClient, user: Any, program: Program, committed: Project, draft: Project
    ) -> None:
        """A speculative allocation must not show a real person as contended."""
        from trueppm_api.apps.resources.models import Resource, TaskResource

        ProgramMembership.objects.create(program=program, user=user, role=Role.SCHEDULER)
        janus = Resource.objects.create(name="Janus", max_units=Decimal("1.00"))
        for project, label in ((committed, "Real work"), (draft, "Maybe work")):
            task = Task.objects.create(
                project=project,
                name=label,
                duration=5,
                early_start=date(2026, 7, 6),
                early_finish=date(2026, 7, 10),
            )
            TaskResource.objects.create(task=task, resource=janus, units=Decimal("1.00"))

        url = f"/api/v1/programs/{program.pk}/resource-contention/"

        def _span_labels() -> set[str]:
            body = client.get(url).data
            return {span["name"] for resource in body["resources"] for span in resource["tasks"]}

        assert _span_labels() == {"Real work"}

        _commit(draft)
        assert _span_labels() == {"Real work", "Maybe work"}

    # -- search -------------------------------------------------------------

    def test_omni_search_excludes_a_drafts_tasks(
        self, client: APIClient, committed: Project, draft: Project
    ) -> None:
        """``/me/search/`` — the global palette, ranking one team's card above another's."""
        Task.objects.create(project=committed, name="Widget rollout", duration=1)
        Task.objects.create(project=draft, name="Widget prototype", duration=1)
        url = "/api/v1/me/search/?q=Widget"

        assert {r["title"] for r in client.get(url).data["results"]} == {"Widget rollout"}

        _commit(draft)
        assert {r["title"] for r in client.get(url).data["results"]} == {
            "Widget rollout",
            "Widget prototype",
        }

    def test_program_task_search_excludes_a_draft(
        self, client: APIClient, user: Any, program: Program, committed: Project, draft: Project
    ) -> None:
        """The cross-project dependency picker — every row it offers becomes an edge.

        Worse than a plain search leak: gating committed work on an uncommitted
        plan would let a draft move a real project's dates.
        """
        ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
        Task.objects.create(project=committed, name="Widget rollout", duration=1)
        Task.objects.create(project=draft, name="Widget prototype", duration=1)
        url = f"/api/v1/programs/{program.pk}/task-search/?q=Widget"

        assert {r["name"] for r in client.get(url).data} == {"Widget rollout"}

        _commit(draft)
        assert {r["name"] for r in client.get(url).data} == {
            "Widget rollout",
            "Widget prototype",
        }

    # -- notification fan-out ----------------------------------------------

    def test_stale_task_sweep_skips_a_draft(
        self, user: Any, committed: Project, draft: Project
    ) -> None:
        """Every card in a plan still being written is "stale" by construction."""
        from trueppm_api.apps.notifications.models import Notification, NotificationEventType
        from trueppm_api.apps.notifications.services import create_stale_task_notifications

        task = Task.objects.create(
            project=draft,
            name="Forgotten card",
            duration=1,
            status=TaskStatus.REVIEW,
            assignee=user,
        )
        Task.objects.filter(pk=task.pk).update(
            status_changed_at=timezone.now() - timedelta(days=30)
        )

        assert create_stale_task_notifications() == 0
        assert not Notification.objects.filter(
            event_type=NotificationEventType.TASK_STALE.value
        ).exists()

        _commit(draft)
        assert create_stale_task_notifications() == 1

    def test_overallocation_digest_skips_a_draft(
        self,
        user: Any,
        committed: Project,
        draft: Project,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A resource "overallocated" by an uncommitted plan is not overallocated.

        Asserted on the fan-out itself — which projects the digest computes
        utilization for — rather than on the rendered body, so the test cannot
        pass merely because the fixture had nobody over capacity.
        """
        from trueppm_api.apps.notifications import digests

        seen: list[str] = []

        def _record(project: Project, *args: Any, **kwargs: Any) -> dict[str, Any]:
            seen.append(project.name)
            return {"resources": []}

        monkeypatch.setattr(digests, "compute_utilization", _record)
        sunday = datetime.datetime(2026, 7, 26, 17, 0, tzinfo=datetime.UTC)

        digests.build_resource_overallocation_digest(user, sunday)
        assert seen == ["Committed"]

        seen.clear()
        _commit(draft)
        digests.build_resource_overallocation_digest(user, sunday)
        assert sorted(seen) == ["Committed", "Half-built"]

    def test_daily_forecast_floor_skips_a_draft(
        self, committed: Project, draft: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Each captured snapshot whose end date moved emails every ADMIN.

        On a plan the author is in the middle of typing that is a daily "your end
        date slipped" about their own keystrokes.
        """
        from trueppm_api.apps.scheduling import services as scheduling_services
        from trueppm_api.apps.scheduling import tasks as scheduling_tasks

        seen: list[Any] = []
        # Patched on the defining module: the sweep imports the helper inside the
        # function body, so the name is resolved at call time from `services`.
        monkeypatch.setattr(
            scheduling_services,
            "safe_capture_forecast_snapshot",
            lambda project_id, trigger: seen.append(project_id),
        )

        scheduling_tasks._do_daily_forecast_floor()
        assert seen == [committed.pk]

        seen.clear()
        _commit(draft)
        scheduling_tasks._do_daily_forecast_floor()
        assert sorted(seen, key=str) == sorted([committed.pk, draft.pk], key=str)

    def test_overallocation_digest_drafts_do_not_consume_cap_slots(
        self, user: Any, calendar: Calendar, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The exclusion runs BEFORE ``MAX_PROJECTS_PER_DIGEST`` slices, not after.

        The cap orders by ``project_id``, so a draft sorting ahead of a real
        project would otherwise eat its slot and silently drop a genuine
        overallocation from the digest — and leave the "showing the first N of M"
        footer counting a project the body never mentions.
        """
        import uuid

        from trueppm_api.apps.notifications import digests

        low = Project.objects.create(
            id=uuid.UUID(int=1),
            name="Half-built",
            start_date=date(2026, 3, 2),
            calendar=calendar,
            lifecycle=ProjectLifecycle.DRAFT,
        )
        high = Project.objects.create(
            id=uuid.UUID(int=2),
            name="Committed",
            start_date=date(2026, 3, 2),
            calendar=calendar,
        )
        for p in (low, high):
            ProjectMembership.objects.create(project=p, user=user, role=Role.SCHEDULER)

        seen: list[str] = []
        monkeypatch.setattr(
            digests,
            "compute_utilization",
            lambda project, *a, **k: seen.append(project.name) or {"resources": []},
        )
        # A cap of 1 makes the ordering load-bearing: the draft sorts first.
        monkeypatch.setattr(digests, "MAX_PROJECTS_PER_DIGEST", 1)

        digests.build_resource_overallocation_digest(
            user, datetime.datetime(2026, 7, 26, 17, 0, tzinfo=datetime.UTC)
        )
        assert seen == ["Committed"]

    def test_exclude_draft_projects_refuses_a_multi_valued_path(self, program: Program) -> None:
        """The helper's one real footgun, closed at the call rather than in prose.

        ``exclude(projects__lifecycle=DRAFT)`` on a ``Program`` queryset reads like
        the same exclusion but asks the opposite question: it drops every program
        that has ANY draft child. A wrong answer, not a slow one — and nothing
        downstream would reveal it.
        """
        from trueppm_api.apps.projects.lifecycle import exclude_draft_projects

        with pytest.raises(ValueError, match="multi-valued"):
            exclude_draft_projects(Program.objects.all(), path="projects")

        # The supported shape still works, on the same call.
        assert exclude_draft_projects(Task.objects.all()).count() == 0

    def test_program_schedule_graph_excludes_a_draft(
        self, program: Program, committed: Project, draft: Project
    ) -> None:
        """The merged program CPM anchors on a GLOBAL project_finish.

        `engine.schedule()` takes `project_finish = max(t.early_finish ...)` across
        the whole merged task set, so a draft that simply runs later inflates
        `total_float` for every committed task and can flip `is_critical` off —
        with no dependency between them at all. The "disjoint components are
        independent" intuition is wrong here, which is why this surface is on the
        list despite being a computation rather than a report.
        """
        from trueppm_api.apps.projects.program_schedule import gather_program_schedule

        Task.objects.create(project=committed, name="Real", duration=5)
        Task.objects.create(project=draft, name="Speculative", duration=400)

        names = {p.name for p in gather_program_schedule(program).member_projects}
        assert names == {"Committed"}

        _commit(draft)
        names = {p.name for p in gather_program_schedule(program).member_projects}
        assert names == {"Committed", "Half-built"}

    def test_me_work_signals_draft_only_user_keeps_their_own_cards(
        self, user: Any, draft: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The exclusion narrows the two cross-project AGGREGATES, nothing else.

        `sprint_burndown` and `utilization` are the caller's own sprint and their
        own allocation. Narrowing the shared membership queryset made the empty
        aggregate scope short-circuit the whole function, blanking both cards for a
        user whose only project is a draft — hiding the author's own work from them
        is the opposite of what the exclusion list asks for.
        """
        from trueppm_api.apps.projects import services
        from trueppm_api.apps.projects.models import Sprint, SprintState

        sprint = Sprint.objects.create(
            project=draft,
            name="S1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 16),
            state=SprintState.ACTIVE,
        )
        monkeypatch.setattr(services, "_sprint_burndown_signal", lambda s: {"reached": True})

        signals = services.me_work_signals(user, active_sprints=[sprint])

        # The two cross-project aggregates stay silent — no committed project to
        # reduce over — which is the exclusion doing its job...
        assert "schedule_health" not in signals
        assert "forecast" not in signals
        # ...and the own-work block still ran rather than being short-circuited.
        assert signals["sprint_burndown"] == {"reached": True}

        # A user with no membership at all still returns early, as before.
        stranger = get_user_model().objects.create_user(username="nomember", password="pw")
        assert services.me_work_signals(stranger, active_sprints=[sprint]) == {}


@pytest.mark.django_db
class TestSurfacesDeliberatelyKept:
    """The two surfaces #3144 weighed against the list and left unfiltered.

    These pin a **product decision**, not a filter. Both were found leaking by the
    #3128 audit and both were kept, so the next sweep that applies the exclusion
    "everywhere" has to fail here and read the reasoning in ``lifecycle.py``
    rather than change behavior silently. Each asserts the draft row is PRESENT —
    the inverse of ``TestEveryExcludedSurface``, and the whole point.
    """

    def test_program_stakeholders_still_reaches_a_draft_only_viewer(
        self, committed: Project, draft: Project
    ) -> None:
        """The literal row #3144 describes: one membership, and it is on the draft.

        Every notification surface the exclusion list does cover narrows what a
        notification is *about*; this one narrows who receives it.
        """
        from trueppm_api.apps.access.groups import resolve_group_members

        viewer = get_user_model().objects.create_user(username="draft-viewer", password="pw")
        # Their ONLY membership in the program is on the uncommitted plan.
        ProjectMembership.objects.create(project=draft, user=viewer, role=Role.VIEWER)

        # The mention itself is written on a committed project in the program.
        reached = resolve_group_members(committed.pk, "program-stakeholders")
        assert viewer.pk in reached

        # Committing changes nothing — the person was always reachable.
        _commit(draft)
        assert resolve_group_members(committed.pk, "program-stakeholders") == reached

    def test_program_pms_and_schedulers_still_reach_the_draft_authors(
        self, committed: Project, draft: Project
    ) -> None:
        """Why the exclusion has no legal placement, stated as a test.

        ``_program_membership_base_qs`` is the one base all four ``@program-*`` keys
        narrow and it forbids per-key filters, so an exclusion added there — the
        only place the module's own rule allows — cuts the draft's own Admin and
        Scheduler out of program-wide coordination. This fails on a base-qs filter
        AND on a per-key one, which the stakeholder test alone does not.
        """
        from trueppm_api.apps.access.groups import resolve_group_members

        users = get_user_model().objects
        admin = users.create_user(username="draft-admin", password="pw")
        scheduler = users.create_user(username="draft-scheduler", password="pw")
        ProjectMembership.objects.create(project=draft, user=admin, role=Role.ADMIN)
        ProjectMembership.objects.create(project=draft, user=scheduler, role=Role.SCHEDULER)

        assert admin.pk in resolve_group_members(committed.pk, "program-pms")
        assert scheduler.pk in resolve_group_members(committed.pk, "program-schedulers")
        assert {admin.pk, scheduler.pk} <= set(resolve_group_members(committed.pk, "program-all"))

    def test_mention_reach_count_equals_what_the_resolver_delivers(
        self, program: Program, committed: Project, draft: Project
    ) -> None:
        """The ADR-0697 lockstep, asserted as an EQUALITY rather than two literals.

        Two ``== 1`` literals can both be re-baselined to ``== 0`` in the sweep that
        breaks them. The equality fails whenever either side moves alone, in either
        direction, which is the only form that survives a deliberate reversal.
        """
        from trueppm_api.apps.access.groups import (
            count_program_stakeholder_reach,
            resolve_group_members,
        )

        users = get_user_model().objects
        ProjectMembership.objects.create(
            project=draft,
            user=users.create_user(username="v-draft", password="pw"),
            role=Role.VIEWER,
        )
        ProjectMembership.objects.create(
            project=committed,
            user=users.create_user(username="v-live", password="pw"),
            role=Role.VIEWER,
        )

        reached = resolve_group_members(committed.pk, "program-stakeholders")
        assert count_program_stakeholder_reach(program.pk).viewer_member_count == len(reached)

    def test_a_mention_written_in_a_draft_still_fans_out_to_the_program(
        self, committed: Project, draft: Project
    ) -> None:
        """The other leak direction: the ORIGIN project's lifecycle is not consulted.

        A PM typing ``@program-stakeholders`` into a draft is deliberately asking
        for the review a draft exists to get — unlike #3128's three notification
        sites, which are unattended machine sweeps over a project population.
        """
        from trueppm_api.apps.access.groups import resolve_group_members

        viewer = get_user_model().objects.create_user(username="live-viewer", password="pw")
        ProjectMembership.objects.create(project=committed, user=viewer, role=Role.VIEWER)

        assert viewer.pk in resolve_group_members(draft.pk, "program-stakeholders")

    def test_program_all_cap_counts_draft_memberships(
        self, committed: Project, draft: Project, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The named cost of keeping, pinned so a later change to it is deliberate.

        Draft memberships consume ``ALL_GROUP_HARD_CAP`` slots, so enough drafts can
        trip ``GroupTooLargeError`` on the strength of plans nobody committed to.
        Accepted (#3144): the cap guards blast radius over people who are genuinely
        reached. If a ``GroupTooLargeError`` report ever traces here, this is why.
        """
        from trueppm_api.apps.access import groups

        # The cap is set so the DRAFT membership is the one that trips it: the
        # program otherwise resolves to exactly ``cap``. A draft exclusion anywhere
        # in the base would leave this under the cap and raise nothing.
        for name, project in (("cap-a", committed), ("cap-b", draft)):
            ProjectMembership.objects.create(
                project=project,
                user=get_user_model().objects.create_user(username=name, password="pw"),
                role=Role.MEMBER,
            )
        monkeypatch.setattr(groups, "ALL_GROUP_HARD_CAP", 2)

        with pytest.raises(groups.GroupTooLargeError):
            groups.resolve_group_members(committed.pk, "program-all")

    def test_asset_feeds_still_show_a_draft_projects_own_files(
        self,
        client: APIClient,
        user: Any,
        program: Program,
        committed: Project,
        draft: Project,
    ) -> None:
        """Your own attachment must stay findable while you are still planning.

        Both tiers answer the same because the workspace feed is the program feed
        with the ``project__program=`` clause dropped. Covers a file AND a link on
        the draft: the feed is a two-source merge, so a filter added to
        ``_file_queryset`` alone would pass a file-only assertion.
        """
        from trueppm_api.apps.integrations.models import TaskLink
        from trueppm_api.apps.projects.models import TaskAttachment

        ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
        for project, file_name in ((draft, "wip-scope.pdf"), (committed, "signed-scope.pdf")):
            task = Task.objects.create(project=project, name=f"Spec {file_name}", duration=1)
            TaskAttachment.objects.create(
                task=task,
                file=f"attachments/{task.pk}/{file_name}",
                file_name=file_name,
                uploaded_by=user,
            )
        draft_task = Task.objects.create(project=draft, name="Linked", duration=1)
        TaskLink.objects.create(
            task=draft_task,
            url="https://example.test/wip-scope-mr",
            provider="gitlab",
            custom_title="wip-scope draft MR",
        )

        expected = {"wip-scope.pdf", "signed-scope.pdf", "wip-scope draft MR"}
        for url in (f"/api/v1/programs/{program.pk}/assets/", "/api/v1/assets/"):
            titles = {row["title"] for row in client.get(url).data["results"]}
            assert titles == expected, url
            # ``q`` is a filter on this browse list, not the omni-search palette —
            # it is the param most likely to be swept, so pin it on both sources.
            filtered = {row["title"] for row in client.get(url, {"q": "wip-scope"}).data["results"]}
            assert filtered == {"wip-scope.pdf", "wip-scope draft MR"}, url


@pytest.mark.django_db
class TestLifecycleIsNotAClientWritableField:
    """The draft transition is server-owned (#3127).

    ``lifecycle`` and ``draft_started_at`` were declared on ``ProjectSerializer``
    under a comment calling them read-only, and then left out of
    ``read_only_fields`` — so any Admin+ PATCH could set either one. Both
    directions did real damage, and the second is unrecoverable:

    * ``active -> draft`` took the project off every surface on the #3128
      exclusion list at once, silently and for everyone;
    * ``draft -> active`` walked past ``commit_project()`` and so captured no
      baseline v1. ``commit_project()`` refuses a project that is already active,
      so the anchor can never be laid down afterwards — the project reads as
      committed forever with nothing to measure variance against.

    These pin the field as read-only *and* pin that the sanctioned endpoint still
    works, because a fix that simply froze the field would be indistinguishable
    from one that broke the commit moment.
    """

    def test_every_project_serializer_declares_both_fields_read_only(self) -> None:
        """The mechanism, pinned over the whole population rather than a list of two.

        Asserted on the serializers rather than only through HTTP so that adding a
        field back to ``fields`` without adding it to ``read_only_fields`` fails
        here, rather than only on whichever endpoint a test happens to exercise.

        The population is **discovered**, not enumerated: a third ``Project``
        serializer added later that exposes ``lifecycle`` would be invisible to a
        hand-written tuple, which is the failure mode that let the original defect
        ship — a comment claimed read-only and nothing checked the claim. The two
        assertions below the loop are what stop the discovery itself going quiet: if
        the walk ever returns nothing, or stops finding the two serializers we know
        expose these fields, the loop would pass vacuously.
        """
        from rest_framework import serializers as drf_serializers

        from trueppm_api.apps.projects import serializers as project_serializers
        from trueppm_api.apps.projects.serializers import (
            ProjectDetailSerializer,
            ProjectSerializer,
        )

        checked: set[str] = set()
        for name in dir(project_serializers):
            cls = getattr(project_serializers, name)
            if not isinstance(cls, type) or not issubclass(cls, drf_serializers.ModelSerializer):
                continue
            if getattr(cls.Meta, "model", None) is not Project:
                continue
            declared = set(cls.Meta.fields or ())
            if not {"lifecycle", "draft_started_at"} & declared:
                continue
            fields = cls().fields
            for field_name in ("lifecycle", "draft_started_at"):
                if field_name in fields:
                    assert fields[field_name].read_only is True, f"{cls.__name__}.{field_name}"
            checked.add(cls.__name__)

        assert ProjectSerializer.__name__ in checked
        assert ProjectDetailSerializer.__name__ in checked

    def test_an_owner_cannot_patch_an_active_project_into_a_draft(
        self, client: APIClient, committed: Project
    ) -> None:
        """The denial-of-visibility direction.

        A draft is dropped by program rollup, portfolio health, omni-search, My
        Work, the notification fan-out and digest audience, and the nightly
        forecast and program-schedule passes. One PATCH must not be able to do
        that to a project a whole program is reading.
        """
        response = client.patch(
            f"/api/v1/projects/{committed.pk}/", {"lifecycle": "draft"}, format="json"
        )

        assert response.status_code == 200
        committed.refresh_from_db()
        assert committed.lifecycle == ProjectLifecycle.ACTIVE
        # The response must not claim the write landed either — a client that
        # echoes the payload back would show a Draft chip over an active project.
        assert response.json()["lifecycle"] == ProjectLifecycle.ACTIVE

    def test_an_owner_cannot_patch_a_draft_active_behind_the_commit_moment(
        self, client: APIClient, draft: Project
    ) -> None:
        """The unrecoverable direction: active with no baseline to measure against."""
        from trueppm_api.apps.projects.models import Baseline

        response = client.patch(
            f"/api/v1/projects/{draft.pk}/", {"lifecycle": "active"}, format="json"
        )

        assert response.status_code == 200
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.DRAFT
        assert Baseline.objects.filter(project=draft).count() == 0

    def test_draft_started_at_is_not_client_writable(
        self, client: APIClient, draft: Project
    ) -> None:
        """The 7-day resume window's anchor is a server fact, not a client claim."""
        forged = timezone.now() - timedelta(days=365)

        response = client.patch(
            f"/api/v1/projects/{draft.pk}/",
            {"draft_started_at": forged.isoformat()},
            format="json",
        )

        assert response.status_code == 200
        draft.refresh_from_db()
        assert draft.draft_started_at is None

    def test_create_cannot_choose_its_own_lifecycle(self, client: APIClient) -> None:
        """A project cannot be born a draft by asking to be one.

        Create-as-draft is a server decision (still unbuilt — it is blocked on the
        commit affordance, #3129). Until the server makes it, a client asking for
        it must get an ordinary active project rather than one that is invisible
        to every aggregate with no way in the product to make it visible again.
        """
        response = client.post(
            "/api/v1/projects/",
            {
                "name": "Asked to be a draft",
                "start_date": "2026-03-02",
                "lifecycle": "draft",
                "draft_started_at": timezone.now().isoformat(),
            },
            format="json",
        )

        assert response.status_code == 201
        created = Project.objects.get(pk=response.json()["id"])
        assert created.lifecycle == ProjectLifecycle.ACTIVE
        assert created.draft_started_at is None

    def test_the_commit_endpoint_is_still_the_way_through(
        self, client: APIClient, draft: Project
    ) -> None:
        """Freezing the field must not have frozen the transition.

        Without this, a fix that made ``lifecycle`` read-only and simultaneously
        broke ``POST /commit/`` would pass every assertion above.
        """
        from trueppm_api.apps.projects.models import Baseline

        response = client.post(f"/api/v1/projects/{draft.pk}/commit/")

        assert response.status_code == 200
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.ACTIVE
        assert Baseline.objects.filter(project=draft, name="Baseline v1").count() == 1


@pytest.mark.django_db
class TestCreateAsDraft:
    """A project can actually BE created in draft (#3233).

    The state this whole module tests was, until now, unreachable in production.
    ``lifecycle`` defaults to ACTIVE and every ``DRAFT`` assignment in the repository
    lived inside a test fixture — so ``POST /projects/{id}/commit/`` returned
    ``409 already_committed`` for every project that existed, and the Draft pill, the
    Commit button, ``CommitPlanConfirmDialog``, ``commitRefusal``, ``canCommitPlan``,
    ``draftExclusion`` and 14 server-side exclusion call sites were all built, secured
    and tested against a state no user could enter.

    ``start_as_draft`` is an **intent** flag, not a writable ``lifecycle``: #3127 made
    that field read-only and argued at length that neither transition is a field a
    client may set, at create or at update. Nothing here reopens that, and
    ``TestLifecycleIsNotAClientWritableField`` above still pins it over the whole
    serializer population.
    """

    def _payload(self, calendar: Calendar, **extra: Any) -> dict[str, Any]:
        return {
            "name": "Nakatomi Rebuild",
            "start_date": "2026-09-01",
            "calendar": str(calendar.pk),
            **extra,
        }

    def test_create_without_the_flag_is_active(self, client: APIClient, calendar: Calendar) -> None:
        """The default is unchanged — this is the no-regression half.

        Without it, a passing draft assertion below proves only that the flag was
        honored, not that omitting it still yields a committed project.
        """
        res = client.post("/api/v1/projects/", self._payload(calendar), format="json")
        assert res.status_code == 201, res.data
        project = Project.objects.get(pk=res.data["id"])
        assert project.lifecycle == ProjectLifecycle.ACTIVE
        assert project.draft_started_at is None
        assert not is_draft(project)

    def test_create_with_the_flag_is_draft_and_stamped(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        res = client.post(
            "/api/v1/projects/", self._payload(calendar, start_as_draft=True), format="json"
        )
        assert res.status_code == 201, res.data
        project = Project.objects.get(pk=res.data["id"])
        assert project.lifecycle == ProjectLifecycle.DRAFT
        assert is_draft(project)
        # Both halves of the transition are server-owned, so the stamp is not optional:
        # a draft without it cannot be aged.
        assert project.draft_started_at is not None

    def test_flag_false_is_active(self, client: APIClient, calendar: Calendar) -> None:
        res = client.post(
            "/api/v1/projects/", self._payload(calendar, start_as_draft=False), format="json"
        )
        assert res.status_code == 201, res.data
        assert Project.objects.get(pk=res.data["id"]).lifecycle == ProjectLifecycle.ACTIVE

    def test_the_flag_is_write_only(self, client: APIClient, calendar: Calendar) -> None:
        """It must never echo back — it is an instruction, not a property of the project."""
        res = client.post(
            "/api/v1/projects/", self._payload(calendar, start_as_draft=True), format="json"
        )
        assert "start_as_draft" not in res.data
        assert res.data["lifecycle"] == ProjectLifecycle.DRAFT

    def test_lifecycle_is_still_not_settable_at_create(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        """#3127 is not reopened by the create path.

        DRF strips read-only fields before ``validate()``, so this is a 201 with the
        write silently dropped rather than a 400 — the shape the #3127 comment
        documents. What matters is the stored value, so that is what is asserted.
        """
        res = client.post(
            "/api/v1/projects/",
            self._payload(calendar, lifecycle=ProjectLifecycle.DRAFT),
            format="json",
        )
        assert res.status_code == 201, res.data
        assert Project.objects.get(pk=res.data["id"]).lifecycle == ProjectLifecycle.ACTIVE

    def test_patch_rejects_the_flag(self, client: APIClient, calendar: Calendar) -> None:
        """Create-only, and it says so rather than dropping quietly.

        ``lifecycle`` dropping silently on PATCH is defensible — it matches the
        already-read-only ``is_archived`` beside it — but this field is new and has no
        back-compat callers, so a caller who sends it on update is told it did nothing.
        """
        res = client.post(
            "/api/v1/projects/", self._payload(calendar, start_as_draft=True), format="json"
        )
        pid = res.data["id"]
        patch = client.patch(f"/api/v1/projects/{pid}/", {"start_as_draft": True}, format="json")
        assert patch.status_code == 400
        assert "start_as_draft" in patch.data

    def test_patch_tolerates_the_flag_when_false(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        """False is a no-op, not an error — a client echoing its own form state back
        on an unrelated PATCH must not be 400'd for a field it is not using."""
        res = client.post("/api/v1/projects/", self._payload(calendar), format="json")
        pid = res.data["id"]
        patch = client.patch(
            f"/api/v1/projects/{pid}/", {"start_as_draft": False, "name": "Renamed"}, format="json"
        )
        assert patch.status_code == 200, patch.data
        assert Project.objects.get(pk=pid).name == "Renamed"

    def test_a_created_draft_is_committable_end_to_end(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        """The point of the whole issue: Draft -> Commit is reachable.

        Before this, ``POST /commit/`` answered ``409 already_committed`` for every
        project in existence, because nothing could put one in draft to begin with.
        """
        res = client.post(
            "/api/v1/projects/", self._payload(calendar, start_as_draft=True), format="json"
        )
        pid = res.data["id"]
        Task.objects.create(project_id=pid, name="Mobilize", duration=5)

        commit = client.post(f"/api/v1/projects/{pid}/commit/", {}, format="json")
        assert commit.status_code == 200, commit.data

        project = Project.objects.get(pk=pid)
        assert project.lifecycle == ProjectLifecycle.ACTIVE
        assert Baseline.objects.filter(project=project, is_active=True).exists()

        # And the anchor does not move: a second commit is refused.
        again = client.post(f"/api/v1/projects/{pid}/commit/", {}, format="json")
        assert again.status_code == 409

    def test_a_created_draft_is_excluded_from_aggregates(
        self, client: APIClient, calendar: Calendar
    ) -> None:
        """End-to-end proof it is a real draft, not just a stored string.

        Flips back to ACTIVE and re-asserts, per this module's standing rule: without
        the second half a passing exclusion assertion proves only that the fixture
        was empty.
        """
        res = client.post(
            "/api/v1/projects/",
            self._payload(calendar, start_as_draft=True),
            format="json",
        )
        pid = res.data["id"]
        assert not visible_projects(Project.objects.all()).filter(pk=pid).exists()

        Project.objects.filter(pk=pid).update(lifecycle=ProjectLifecycle.ACTIVE)
        assert visible_projects(Project.objects.all()).filter(pk=pid).exists()
