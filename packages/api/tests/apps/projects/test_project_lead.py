"""Tests for the Project lead field + picker wiring (#966).

Mirrors the Program.lead contract: lead is a nullable FK to User, writable only
by Admin+ (field-gated in ``ProjectSerializer.validate``), and the chosen lead
must already hold a ProjectMembership (``validate_lead``).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
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


@pytest.fixture
def owner(project: Project) -> object:
    u = _user("owner")
    _member(project, u, Role.OWNER)
    return u


@pytest.fixture
def member(project: Project) -> object:
    """A plain project member — eligible to be assigned as lead."""
    u = _user("member")
    _member(project, u, Role.MEMBER)
    return u


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/"


@pytest.mark.django_db
def test_admin_can_set_lead_to_a_member(project: Project, owner: object, member: object) -> None:
    resp = _client(owner).patch(_url(project), {"lead": str(member.pk)}, format="json")
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.lead_id == member.pk
    # lead_detail is the read-only nested payload the General page renders.
    assert resp.data["lead_detail"]["username"] == "member"


@pytest.mark.django_db
def test_lead_must_be_a_project_member(project: Project, owner: object) -> None:
    stranger = _user("stranger")  # exists, but holds no membership on this project
    resp = _client(owner).patch(_url(project), {"lead": str(stranger.pk)}, format="json")
    assert resp.status_code == 400
    assert "member of this project" in str(resp.data["lead"]).lower()
    project.refresh_from_db()
    assert project.lead_id is None


@pytest.mark.django_db
def test_lead_can_be_unset(project: Project, owner: object, member: object) -> None:
    project.lead = member
    project.save(update_fields=["lead"])
    resp = _client(owner).patch(_url(project), {"lead": None}, format="json")
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.lead_id is None


@pytest.mark.django_db
def test_scheduler_cannot_set_lead(project: Project, member: object) -> None:
    """lead is not in _SCHEDULER_WRITABLE_FIELDS, so a sub-Admin is rejected (#769 gate)."""
    sched = _user("scheduler")
    _member(project, sched, Role.SCHEDULER)
    resp = _client(sched).patch(_url(project), {"lead": str(member.pk)}, format="json")
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.lead_id is None
