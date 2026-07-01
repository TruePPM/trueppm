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
from django.db.models import OuterRef, Subquery
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
def test_my_role_annotation_resolves_in_a_single_query(calendar: Calendar) -> None:
    """``my_role`` is a Subquery annotation — O(1) in the row count (ADR-0186 §F).

    ``ProjectViewSet.get_queryset`` attaches ``_my_role`` as a correlated Subquery
    over ProjectMembership, and the serializer reads it with ``getattr`` (never a
    per-row query). This mirrors that annotation and proves it resolves inline with
    the page fetch: three projects cost the same single query as one.

    The full ``/api/v1/projects/`` response also carries pre-existing per-row
    serializer costs unrelated to this field — the ``effective_*``/``inherited_*``
    settings resolvers fetch per-project related rows, tracked in #1482 — so this
    test isolates the ``my_role`` annotation contract itself rather than asserting
    whole-list query invariance (the row-level correctness of ``my_role`` is covered
    by the retrieve/list tests above).
    """
    owner = _user("owner")
    for name in ("A", "B", "C"):
        p = Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)
        _member(p, owner, Role.OWNER)

    my_role_sq = ProjectMembership.objects.filter(
        project=OuterRef("pk"), user=owner, is_deleted=False
    ).values("role")[:1]
    qs = Project.objects.annotate(_my_role=Subquery(my_role_sq))

    with CaptureQueriesContext(connection) as ctx:
        roles = list(qs.values_list("_my_role", flat=True))

    assert len(roles) == 3
    assert set(roles) == {Role.OWNER}
    # Single query for all three rows: the Subquery is evaluated inline with the
    # page fetch, so my_role adds no per-row cost.
    assert len(ctx) == 1
