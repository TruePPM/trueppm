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
