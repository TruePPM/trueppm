"""send_robust isolation for the projects-app extension-point signals (#850).

``risk_changed``, ``task_status_changed``, and ``sprint_scope_changed`` are OSS
extension points Enterprise connects receivers against. They are dispatched with
``send_robust`` so a buggy third-party receiver cannot break the OSS write path.
These tests assert a raising receiver does NOT propagate out of the write.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import record_sprint_scope_change
from trueppm_api.apps.projects.signals import (
    risk_changed,
    sprint_scope_changed,
    task_status_changed,
)

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar, owner: object) -> Project:
    p = Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=calendar)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


def _boom(sender: object, **kwargs: object) -> None:
    raise ValueError("receiver exploded")


# ---------------------------------------------------------------------------
# risk_changed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_risk_changed_receiver_failure_does_not_break_save(project: Project) -> None:
    risk_changed.connect(_boom, weak=False)
    try:
        # The write must complete despite the raising receiver.
        risk = Risk.objects.create(project=project, title="R", probability=2, impact=3)
    finally:
        risk_changed.disconnect(_boom)
    assert Risk.objects.filter(pk=risk.pk).exists()


@pytest.mark.django_db
def test_risk_changed_receiver_failure_does_not_break_soft_delete(project: Project) -> None:
    risk = Risk.objects.create(project=project, title="R", probability=2, impact=3)
    risk_changed.connect(_boom, weak=False)
    try:
        risk.soft_delete()
    finally:
        risk_changed.disconnect(_boom)
    risk.refresh_from_db()
    assert risk.is_deleted is True


# ---------------------------------------------------------------------------
# task_status_changed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_status_changed_receiver_failure_does_not_break_save(project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=2)
    task_status_changed.connect(_boom, weak=False)
    try:
        task.status = TaskStatus.IN_PROGRESS
        task.save(update_fields=["status"])
    finally:
        task_status_changed.disconnect(_boom)
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


# ---------------------------------------------------------------------------
# sprint_scope_changed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sprint_scope_changed_receiver_failure_does_not_break_write(
    project: Project, owner: object
) -> None:
    sprint = Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.ACTIVE,
    )
    task = Task.objects.create(project=project, name="Injected", duration=1)
    sprint_scope_changed.connect(_boom, weak=False)
    try:
        scope_change = record_sprint_scope_change(task=task, sprint=sprint, by=owner)
    finally:
        sprint_scope_changed.disconnect(_boom)
    # The SprintScopeChange row was still recorded despite the raising receiver.
    assert SprintScopeChange.objects.filter(pk=scope_change.pk).exists()
