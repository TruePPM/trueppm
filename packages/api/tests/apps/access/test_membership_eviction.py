"""Tests for ProjectMembership revocation → WS eviction signals (#813)."""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()

_EVICT = "trueppm_api.apps.access.signals.evict_project_connection"


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="evictee", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="EvictProj", start_date=date(2026, 1, 1), calendar=cal)


@pytest.mark.django_db
def test_soft_delete_evicts_live_sockets(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.soft_delete()
    evict.assert_called_once_with(str(project.pk), str(user.pk))


@pytest.mark.django_db
def test_demotion_below_member_evicts(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.role = Role.VIEWER
        m.save()
    evict.assert_called_once_with(str(project.pk), str(user.pk))


@pytest.mark.django_db
def test_demotion_to_member_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    """Demoting Admin -> Member keeps the user connectable, so no eviction."""
    m = ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        m.role = Role.MEMBER
        m.save()
    evict.assert_not_called()


@pytest.mark.django_db
def test_creating_membership_does_not_evict(
    user: Any, project: Project, django_capture_on_commit_callbacks: Any
) -> None:
    with patch(_EVICT) as evict, django_capture_on_commit_callbacks(execute=True):
        ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    evict.assert_not_called()
