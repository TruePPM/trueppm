"""DB-level role band + safe role labels (#4583, ADR-0072).

A role ordinal outside ``[VIEWER, OWNER]`` must be refused by the database, while an
in-band ordinal the OSS enum does not name (an Enterprise custom role at 250) must
be storable and must not 500 any display path.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProjectMembership,
    Role,
    project_role_label,
)
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace.models import Group, GroupProject, Workspace

User = get_user_model()
CUSTOM_BAND = 250  # between SCHEDULER (200) and ADMIN (300): a legal custom-role ordinal


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Band", start_date=date(2026, 1, 1))


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, 401, 500])
def test_project_membership_rejects_out_of_band_role(project: Project, bad: int) -> None:
    user = User.objects.create_user(username=f"u{bad}", password="pw")
    with pytest.raises(IntegrityError), transaction.atomic():
        ProjectMembership.objects.create(project=project, user=user, role=bad)


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, 401])
def test_program_membership_rejects_out_of_band_role(bad: int) -> None:
    program = Program.objects.create(name="Prog")
    user = User.objects.create_user(username=f"p{bad}", password="pw")
    with pytest.raises(IntegrityError), transaction.atomic():
        ProgramMembership.objects.create(program=program, user=user, role=bad)


@pytest.mark.django_db
def test_group_project_and_default_member_role_reject_out_of_band(project: Project) -> None:
    group = Group.objects.create(workspace=Workspace.load(), name="g")
    with pytest.raises(IntegrityError), transaction.atomic():
        GroupProject.objects.create(group=group, project=project, role=401)
    with pytest.raises(IntegrityError), transaction.atomic():
        Project.objects.filter(pk=project.pk).update(default_member_role=0)


@pytest.mark.django_db
def test_band_edges_and_custom_ordinal_are_storable(project: Project) -> None:
    for i, role in enumerate([Role.VIEWER, CUSTOM_BAND, Role.OWNER]):
        user = User.objects.create_user(username=f"ok{i}", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
    assert ProjectMembership.objects.filter(project=project).count() == 3


def test_project_role_label_falls_back_instead_of_raising() -> None:
    assert project_role_label(Role.OWNER) == "Project Admin"
    assert project_role_label(CUSTOM_BAND) == "Custom role (250)"


@pytest.mark.django_db
def test_member_list_with_custom_ordinal_returns_200(project: Project) -> None:
    owner = User.objects.create_user(username="own", password="pw")
    custom = User.objects.create_user(username="cust", password="pw")
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    row = ProjectMembership.objects.create(project=project, user=custom, role=CUSTOM_BAND)
    assert "Custom role (250)" in str(row)
    c = APIClient()
    c.force_authenticate(user=owner)
    resp = c.get(f"/api/v1/projects/{project.pk}/members/")
    assert resp.status_code == 200
    labels = {m["role"]: m["role_label"] for m in resp.data}
    assert labels[CUSTOM_BAND] == "Custom role (250)"


def test_project_role_bounds_match_enum() -> None:
    from trueppm_api.apps.projects.models import _ROLE_BAND_MAX, _ROLE_BAND_MIN

    assert (_ROLE_BAND_MIN, _ROLE_BAND_MAX) == (Role.VIEWER, Role.OWNER)
