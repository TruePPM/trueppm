"""Shared builders for the cost-model tests (ADR-1324, #754)."""

from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Any

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.timetracking.models import TimeEntry
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()


def user(username: str) -> Any:
    return User.objects.create_user(username=username, password="pw")


def workspace_admin(username: str = "wsadmin") -> Any:
    u = user(username)
    WorkspaceMembership.objects.create(workspace=Workspace.load(), user=u, role=WorkspaceRole.ADMIN)
    return u


def project(name: str = "P", *, budget: str | None = None, program: Any = None) -> Project:
    cal = Calendar.objects.filter(name="Standard").first() or Calendar.objects.create(
        name="Standard"
    )
    return Project.objects.create(
        name=name,
        start_date=datetime.date(2026, 1, 1),
        calendar=cal,
        program=program,
        budget=Decimal(budget) if budget is not None else None,
    )


def member(p: Project, u: Any, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=p, user=u, role=role)


def task(p: Project, name: str = "T", percent: float = 0.0) -> Task:
    return Task.objects.create(project=p, name=name, duration=1, percent_complete=percent)


def resource(name: str, u: Any = None, rate: str | None = None) -> Resource:
    return Resource.objects.create(
        name=name, user=u, cost_rate=Decimal(rate) if rate is not None else None
    )


def log(t: Task, u: Any, minutes: int) -> TimeEntry:
    return TimeEntry.objects.create(
        task=t, user=u, minutes=minutes, entry_date=datetime.date(2026, 3, 2)
    )


def assign(t: Task, r: Resource) -> TaskResource:
    return TaskResource.objects.create(task=t, resource=r, units=Decimal("1.00"))


def client(u: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=u)
    return c
