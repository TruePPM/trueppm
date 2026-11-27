"""User FK writes must not reveal which account ids exist (#5003).

``Task.assignee``, ``Task.on_behalf_of``, ``Project.lead`` and ``Program.lead`` accept
a user pk. A pk that
names no account and a pk that names an existing non-member must produce the same
response body, or the write enumerates accounts.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    Calendar,
    Methodology,
    Program,
    Project,
    Task,
)

User = get_user_model()

pytestmark = pytest.mark.django_db

_UNUSED_PK = 987654


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="oracle_owner", password="pw")


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="oracle_stranger", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def program(owner: Any) -> Program:
    return create_program(
        name="G", description="", methodology=Methodology.HYBRID, created_by=owner
    )


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _body(resp: Any) -> tuple[int, Any]:
    return resp.status_code, resp.json()


def test_task_patch_answers_a_non_member_and_an_unused_pk_identically(
    owner: Any, stranger: Any, task: Task
) -> None:
    url = f"/api/v1/tasks/{task.pk}/"
    existing = _client(owner).patch(url, {"assignee": stranger.pk}, format="json")
    unused = _client(owner).patch(url, {"assignee": _UNUSED_PK}, format="json")
    assert existing.status_code == 400
    assert _body(existing) == _body(unused)
    assert "member of this project" in str(existing.data["assignee"])


def test_task_patch_stays_identical_when_the_body_has_a_second_error(
    owner: Any, stranger: Any, task: Task
) -> None:
    """Both refusals are field-level, so another bad field cannot split them."""
    url = f"/api/v1/tasks/{task.pk}/"
    extra = {"duration": -5, "status": "NOT_A_STATUS"}
    existing = _client(owner).patch(url, {"assignee": stranger.pk, **extra}, format="json")
    unused = _client(owner).patch(url, {"assignee": _UNUSED_PK, **extra}, format="json")
    assert existing.status_code == 400
    assert _body(existing) == _body(unused)


def test_task_create_answers_a_non_member_and_an_unused_pk_identically(
    owner: Any, stranger: Any, project: Project
) -> None:
    def _post(pk: int) -> Any:
        return _client(owner).post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "N", "duration": 1, "assignee": pk},
            format="json",
        )

    assert _post(stranger.pk).status_code == 400
    assert _body(_post(stranger.pk)) == _body(_post(_UNUSED_PK))
    assert not Task.objects.filter(name="N").exists()


@pytest.mark.parametrize("role", [Role.MEMBER, Role.ADMIN])
def test_on_behalf_of_patch_is_not_an_account_oracle(
    role: int, stranger: Any, project: Project
) -> None:
    """A Member used to get 403 for an existing non-member and 400 for an unused pk."""
    writer = User.objects.create_user(username="oracle_writer", password="pw")
    ProjectMembership.objects.create(project=project, user=writer, role=role)
    task = Task.objects.create(
        project=project, name="A", duration=1, executor_kind="agent", assignee=writer
    )
    url = f"/api/v1/tasks/{task.pk}/"

    existing = _client(writer).patch(url, {"on_behalf_of": stranger.pk}, format="json")
    unused = _client(writer).patch(url, {"on_behalf_of": _UNUSED_PK}, format="json")

    assert existing.status_code == 400, existing.data
    assert _body(existing) == _body(unused)
    own = _client(writer).patch(url, {"on_behalf_of": writer.pk}, format="json")
    assert own.status_code == 200, own.data
    assert own.data["on_behalf_of"] == writer.pk


def test_on_behalf_of_create_is_not_an_account_oracle_for_an_outsider(
    owner: Any, stranger: Any, project: Project
) -> None:
    def _post(pk: int) -> Any:
        return _client(stranger).post(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "name": "N",
                "duration": 1,
                "executor_kind": "agent",
                "on_behalf_of": pk,
            },
            format="json",
        )

    assert _body(_post(owner.pk)) == _body(_post(_UNUSED_PK))
    assert not Task.objects.filter(name="N").exists()


def test_task_create_still_accepts_a_member(owner: Any, project: Project) -> None:
    resp = _client(owner).post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "N", "duration": 1, "assignee": owner.pk},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["assignee"] == owner.pk


def test_an_outsider_cannot_probe_a_foreign_projects_membership(
    owner: Any, stranger: Any, project: Project
) -> None:
    """The body is validated before the create's role check, so a member pk used to
    answer 403 and a non-member pk 400."""

    def _post(pk: int) -> Any:
        return _client(stranger).post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "N", "duration": 1, "assignee": pk},
            format="json",
        )

    member = _post(owner.pk)
    unused = _post(_UNUSED_PK)
    assert _body(member) == _body(unused)
    assert not Task.objects.filter(name="N").exists()


def test_project_lead_patch_is_not_an_account_oracle(
    owner: Any, stranger: Any, project: Project
) -> None:
    url = f"/api/v1/projects/{project.pk}/"
    existing = _client(owner).patch(url, {"lead": stranger.pk}, format="json")
    unused = _client(owner).patch(url, {"lead": _UNUSED_PK}, format="json")
    assert existing.status_code == 400
    assert _body(existing) == _body(unused)


def test_project_create_refuses_a_non_creator_lead_without_revealing_existence(
    owner: Any, stranger: Any
) -> None:
    calendar = Calendar.objects.create(name="Standard")

    def _post(pk: int) -> Any:
        return _client(owner).post(
            "/api/v1/projects/",
            {
                "name": "Created",
                "start_date": "2026-04-01",
                "calendar": str(calendar.pk),
                "lead": pk,
            },
            format="json",
        )

    existing = _post(stranger.pk)
    assert existing.status_code == 400, existing.data
    assert _body(existing) == _body(_post(_UNUSED_PK))
    assert not Project.objects.filter(name="Created").exists()
    own = _post(owner.pk)
    assert own.status_code == 201, own.data


def test_program_lead_patch_is_not_an_account_oracle(
    owner: Any, stranger: Any, program: Program
) -> None:
    url = f"/api/v1/programs/{program.pk}/"
    existing = _client(owner).patch(url, {"lead": stranger.pk}, format="json")
    unused = _client(owner).patch(url, {"lead": _UNUSED_PK}, format="json")
    assert existing.status_code == 400
    assert _body(existing) == _body(unused)


def test_program_create_lead_is_not_an_account_oracle(owner: Any, stranger: Any) -> None:
    def _post(pk: int) -> Any:
        return _client(owner).post(
            "/api/v1/programs/",
            {"name": "Phase 2", "methodology": "HYBRID", "lead": pk},
            format="json",
        )

    existing = _post(stranger.pk)
    assert existing.status_code == 400, existing.data
    assert _body(existing) == _body(_post(_UNUSED_PK))
