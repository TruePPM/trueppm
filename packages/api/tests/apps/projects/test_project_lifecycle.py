"""The draft lifecycle and its exclusion list (#2962).

Three things must stay true, and each has been got wrong somewhere before:

1. ``lifecycle`` is not ``is_archived``. A draft is fully WRITABLE — conflating
   them would make Resume impossible, which is the entire point of a draft.
2. A draft is excluded from anything that AGGREGATES. A half-built plan inside a
   rollup makes that rollup a guess with a chart around it.
3. A draft is NOT hidden from a direct read. Exclusion-from-reads is
   indistinguishable from a 404, which is why the MCP surface returns
   ``lifecycle`` as a field instead.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.lifecycle import is_draft, visible_projects
from trueppm_api.apps.projects.models import (
    Calendar,
    Program,
    Project,
    ProjectLifecycle,
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
