"""A trashed project's members are not recipients (#4599).

#4577 made "a trashed project confers no role" an invariant and #4599 extended the
membership-floor gate to the project axis. These pin the recipient-set resolvers the
issue named: @-group expansion, impediment recipients and the admin/owner cohorts.
Each is asserted live first, so a vacuous empty result cannot pass.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.groups import resolve_group_members
from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.blocker_services import resolve_impediment_recipients
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def world() -> dict[str, object]:
    cal = Calendar.objects.create(name="Std")
    project = Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=cal)
    admin = User.objects.create_user(username="pm", password="pw")
    member = User.objects.create_user(username="dev", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    task = Task.objects.create(project=project, name="T", duration=1, assignee=member)
    return {"project": project, "admin": admin, "member": member, "task": task}


def _trash(project: Project) -> None:
    Project.objects.filter(pk=project.pk).update(is_deleted=True)


@pytest.mark.parametrize("key", ["all", "admins"])
def test_group_expansion_skips_trashed_project(world: dict[str, object], key: str) -> None:
    project = world["project"]
    assert resolve_group_members(project.pk, key)  # type: ignore[attr-defined]
    _trash(project)  # type: ignore[arg-type]
    assert resolve_group_members(project.pk, key) == []  # type: ignore[attr-defined]


def test_impediment_recipients_skip_trashed_project(world: dict[str, object]) -> None:
    task = world["task"]
    assert resolve_impediment_recipients(task)  # type: ignore[arg-type]
    _trash(world["project"])  # type: ignore[arg-type]
    assert resolve_impediment_recipients(Task.objects.get(pk=task.pk)) == set()  # type: ignore[attr-defined]
