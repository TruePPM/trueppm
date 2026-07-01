"""Tests for the additive ``ProjectSerializer.my_role`` field (ADR-0186 §F, #504).

``my_role`` / ``my_role_label`` expose the caller's own role on a project so the
MCP server can pass it through as ``caller_role`` (it must come from the
authoritative API, never be inferred client-side). The value is backed by the
``_my_role`` annotation on ``ProjectViewSet.get_queryset`` — a Subquery over
ProjectMembership — so it stays a single scalar per row (no N+1). Mirrors the
existing ``ProgramSerializer.my_role`` contract.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _user(username: str) -> object:
    return User.objects.create_user(username=username, password="pw")


def _member(project: Project, user: object, role: Role) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
def test_retrieve_includes_my_role_for_owner(project: Project) -> None:
    """Detail response carries the caller's role ordinal + human label."""
    owner = _user("owner")
    _member(project, owner, Role.OWNER)
    resp = _client(owner).get(f"/api/v1/projects/{project.id}/")
    assert resp.status_code == 200, resp.data
    assert resp.data["my_role"] == Role.OWNER
    assert resp.data["my_role_label"] == "Project Admin"


@pytest.mark.django_db
def test_list_includes_my_role_for_member(project: Project) -> None:
    """List response reflects a non-owner role — a Member sees MEMBER, not OWNER."""
    member = _user("member")
    _member(project, member, Role.MEMBER)
    resp = _client(member).get("/api/v1/projects/")
    assert resp.status_code == 200, resp.data
    rows = resp.data["results"]
    assert len(rows) == 1
    assert rows[0]["my_role"] == Role.MEMBER
    assert rows[0]["my_role_label"] == "Team Member"


@pytest.mark.django_db
def test_my_role_reflects_each_callers_own_role(project: Project) -> None:
    """Two members on the same project each see their own distinct role."""
    owner = _user("owner")
    scheduler = _user("scheduler")
    _member(project, owner, Role.OWNER)
    _member(project, scheduler, Role.SCHEDULER)

    owner_resp = _client(owner).get(f"/api/v1/projects/{project.id}/")
    sched_resp = _client(scheduler).get(f"/api/v1/projects/{project.id}/")
    assert owner_resp.data["my_role"] == Role.OWNER
    assert sched_resp.data["my_role"] == Role.SCHEDULER
    assert sched_resp.data["my_role_label"] == "Resource Manager"


@pytest.mark.django_db
def test_list_my_role_annotation_has_no_n_plus_1(calendar: Calendar) -> None:
    """Adding projects must not add a query per row — the role is a Subquery.

    Guards the perf contract in ADR-0186 §F: ``my_role`` is annotation-backed,
    so the list query count is invariant to the number of projects returned.
    """
    owner = _user("owner")
    client = _client(owner)

    def _make_project(name: str) -> Project:
        p = Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)
        _member(p, owner, Role.OWNER)
        return p

    _make_project("A")
    with CaptureQueriesContext(connection) as one_project:
        resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert all("my_role" in row for row in resp.data["results"])

    _make_project("B")
    _make_project("C")
    with CaptureQueriesContext(connection) as three_projects:
        resp = client.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 3

    # No per-row query growth: the my_role Subquery is evaluated inline with the
    # page fetch, so three projects cost the same number of queries as one.
    assert len(three_projects) == len(one_project)
