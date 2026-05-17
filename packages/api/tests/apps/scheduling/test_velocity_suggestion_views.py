"""API endpoint tests for VelocitySuggestionViewSet (ADR-0065)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.scheduling.models import VelocitySuggestion

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.COMPLETED,
        completed_points=20,
    )


@pytest.fixture
def task(project: Project, sprint: Sprint) -> Task:
    return Task.objects.create(
        project=project,
        name="Build",
        duration=2,
        most_likely_duration=2,
        sprint=sprint,
        story_points=5,
    )


@pytest.fixture
def suggestion(task: Task, sprint: Sprint) -> VelocitySuggestion:
    return VelocitySuggestion.objects.create(
        task=task,
        sprint=sprint,
        suggested_duration=3,
        team_velocity_per_day=Decimal("1.667"),
    )


def _client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Auth + membership gates
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_requires_authentication(suggestion: VelocitySuggestion) -> None:
    resp = APIClient().get("/api/v1/velocity-suggestions/")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_list_returns_only_member_projects(
    project: Project, suggestion: VelocitySuggestion
) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    member = User.objects.create_user(username="member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.VIEWER)

    outsider_resp = _client_for(outsider).get("/api/v1/velocity-suggestions/")
    assert outsider_resp.status_code == 200
    assert outsider_resp.json()["count"] == 0

    member_resp = _client_for(member).get("/api/v1/velocity-suggestions/")
    assert member_resp.status_code == 200
    assert member_resp.json()["count"] == 1


@pytest.mark.django_db
def test_list_filter_by_task(
    project: Project, sprint: Sprint, task: Task, suggestion: VelocitySuggestion
) -> None:
    other_task = Task.objects.create(
        project=project, name="Other", duration=1, sprint=sprint, story_points=2
    )
    VelocitySuggestion.objects.create(
        task=other_task,
        sprint=sprint,
        suggested_duration=1,
        team_velocity_per_day=Decimal("2.000"),
    )
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).get(f"/api/v1/velocity-suggestions/?task={task.id}")
    assert resp.status_code == 200
    ids = [row["id"] for row in resp.json()["results"]]
    assert str(suggestion.id) in ids
    assert len(ids) == 1


@pytest.mark.django_db
def test_list_filter_pending_only(
    project: Project, sprint: Sprint, task: Task, suggestion: VelocitySuggestion
) -> None:
    from django.utils import timezone

    # Add a dismissed sibling — it should be filtered out by pending=true.
    other_task = Task.objects.create(
        project=project, name="Done", duration=1, sprint=sprint, story_points=2
    )
    VelocitySuggestion.objects.create(
        task=other_task,
        sprint=sprint,
        suggested_duration=1,
        team_velocity_per_day=Decimal("2.000"),
        dismissed_at=timezone.now(),
    )
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).get("/api/v1/velocity-suggestions/?pending=true")
    assert resp.status_code == 200
    rows = resp.json()["results"]
    assert len(rows) == 1
    assert rows[0]["id"] == str(suggestion.id)


# ---------------------------------------------------------------------------
# Accept
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_accept(project: Project, task: Task, suggestion: VelocitySuggestion) -> None:
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_scheduler_cannot_accept(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    scheduler = User.objects.create_user(username="sched", password="pw")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)

    resp = _client_for(scheduler).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 403


@pytest.mark.django_db(transaction=True)
def test_admin_accept_writes_duration_and_enqueues_cpm(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)

        resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")

    assert resp.status_code == 200
    suggestion.refresh_from_db()
    task.refresh_from_db()
    assert task.most_likely_duration == 3  # Was 2; suggestion was 3.
    assert suggestion.accepted_at is not None
    assert suggestion.accepted_by_id == pm.pk
    assert suggestion.dismissed_at is None
    # CPM recompute enqueued.
    mock_task.delay.assert_called_once_with(str(project.pk))


@pytest.mark.django_db
def test_accept_idempotent_when_already_accepted(
    project: Project, suggestion: VelocitySuggestion
) -> None:
    from django.utils import timezone

    suggestion.accepted_at = timezone.now()
    suggestion.save(update_fields=["accepted_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_accept_after_dismiss_is_409(project: Project, suggestion: VelocitySuggestion) -> None:
    from django.utils import timezone

    suggestion.dismissed_at = timezone.now()
    suggestion.save(update_fields=["dismissed_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/accept/")
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Dismiss
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_cannot_dismiss(project: Project, suggestion: VelocitySuggestion) -> None:
    member = User.objects.create_user(username="m", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)

    resp = _client_for(member).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_admin_dismiss_stamps_audit_only(
    project: Project, task: Task, suggestion: VelocitySuggestion
) -> None:
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 200
    suggestion.refresh_from_db()
    task.refresh_from_db()
    assert suggestion.dismissed_at is not None
    assert suggestion.dismissed_by_id == pm.pk
    assert suggestion.accepted_at is None
    # Task duration untouched.
    assert task.most_likely_duration == 2


@pytest.mark.django_db
def test_dismiss_after_accept_is_409(project: Project, suggestion: VelocitySuggestion) -> None:
    from django.utils import timezone

    suggestion.accepted_at = timezone.now()
    suggestion.save(update_fields=["accepted_at"])
    pm = User.objects.create_user(username="pm", password="pw")
    ProjectMembership.objects.create(project=project, user=pm, role=Role.ADMIN)

    resp = _client_for(pm).post(f"/api/v1/velocity-suggestions/{suggestion.id}/dismiss/")
    assert resp.status_code == 409
