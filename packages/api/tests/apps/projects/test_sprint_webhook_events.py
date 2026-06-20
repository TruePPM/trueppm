"""Tests for the three sprint lifecycle webhook events (#1073, ADR-0147).

sprint.activated fires from SprintViewSet.activate (sync); sprint.closed fires
from the close_sprint Celery task (async outbox); sprint.scope_changed fires from
the ADR-0102 scope-accept service — and only on accept, never on reject or silent
injection. All three dispatch inside transaction.on_commit, so the API/service
tests use django_capture_on_commit_callbacks(execute=True) and assert against a
patched views._dispatch_webhooks trampoline (the close/accept paths import the
trampoline lazily from views at call time, so patching the views attribute catches
them too).

The sprint.closed payload carries the completion snapshot (velocity). Per ADR-0147
those fields are emitted to an external webhook consumer only when the team has
shared the velocity signal outward (audience == PROGRAM_SHARED); otherwise they are
null and velocity_suppressed is True (suppress-don't-drop-keys).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import views
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ProjectSignalPrivacyPolicy,
    ScopeChangeStatus,
    SignalAudience,
    Sprint,
    SprintCloseRequest,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    accept_scope_change,
    record_sprint_scope_change,
    reject_scope_change,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="sprint_owner", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="SprintEv", start_date=date(2026, 3, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


@pytest.fixture(autouse=True)
def _mock_redis_lock() -> Any:
    """Bypass the Redis SET NX lock so idempotent_task wrappers run inline."""
    mock_client = MagicMock()
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock(return_value=1)
    with patch("trueppm_api.core.idempotent.redis_lib") as redis_module:
        redis_module.from_url.return_value = mock_client
        yield mock_client


def _planned_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal="Ship the thing",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.PLANNED,
    )


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal="Ship the thing",
        start_date=date(2026, 3, 2),
        finish_date=date(2026, 3, 13),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=3,
    )


def _share_velocity(project: Project) -> None:
    """Raise the project's velocity signal to PROGRAM_SHARED (the outward rung)."""
    ProjectSignalPrivacyPolicy.objects.update_or_create(
        project=project,
        defaults={
            "signal_visibility": {
                "velocity": {
                    "audience": SignalAudience.PROGRAM_SHARED,
                    "ceiling": SignalAudience.PROGRAM_SHARED,
                }
            }
        },
    )


def _fired_events(mock: Any) -> list[str]:
    return [call.args[1] for call in mock.call_args_list]


def _payload_for(mock: Any, event_type: str) -> dict[str, Any]:
    return next(c for c in mock.call_args_list if c.args[1] == event_type).args[2]


def _task(project: Project, name: str, sprint: Sprint, **kwargs: Any) -> Task:
    kwargs.setdefault("duration", 1)
    return Task.objects.create(project=project, name=name, sprint=sprint, **kwargs)


def _inject(task: Task, sprint: Sprint, by: Any) -> Any:
    task.sprint_pending = True
    task.save(update_fields=["sprint_pending"])
    return record_sprint_scope_change(task=task, sprint=sprint, by=by)


# ---------------------------------------------------------------------------
# sprint.activated (SprintViewSet.activate — sync)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_activate_fires_sprint_activated(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = _planned_sprint(project)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(f"/api/v1/sprints/{sprint.pk}/activate/", {}, format="json")
    assert resp.status_code == 200, resp.data
    assert "sprint.activated" in _fired_events(mock_dispatch)
    payload = _payload_for(mock_dispatch, "sprint.activated")
    assert payload["id"] == str(sprint.pk)
    assert payload["project"] == str(project.pk)
    assert payload["state"] == SprintState.ACTIVE
    assert payload["source"] == "api"
    # committed_* is the published plan, never privacy-gated.
    assert "committed_points" in payload


@pytest.mark.django_db
def test_failed_activation_fires_no_webhook(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A non-PLANNED sprint 400s on activate and must emit no webhook."""
    sprint = _active_sprint(project)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(f"/api/v1/sprints/{sprint.pk}/activate/", {}, format="json")
    assert resp.status_code == 400, resp.data
    assert "sprint.activated" not in _fired_events(mock_dispatch)


# ---------------------------------------------------------------------------
# sprint.closed (close_sprint task — async) + velocity privacy
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_close_fires_sprint_closed_with_velocity_suppressed_by_default(
    owner: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Default posture (velocity audience TEAM): the completion snapshot is nulled
    and velocity_suppressed is True — a webhook consumer never receives velocity
    the team hasn't shared outward."""
    from trueppm_api.apps.projects.tasks import close_sprint

    sprint = _active_sprint(project)
    _task(project, "Done", sprint, story_points=8, status=TaskStatus.COMPLETE)
    req = SprintCloseRequest.objects.create(
        sprint=sprint, requested_by=owner, carry_over_to="backlog"
    )
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        close_sprint.run(str(req.id))
    assert "sprint.closed" in _fired_events(mock_dispatch)
    payload = _payload_for(mock_dispatch, "sprint.closed")
    assert payload["velocity_suppressed"] is True
    assert payload["completed_points"] is None
    assert payload["completed_task_count"] is None
    assert payload["goal_outcome"] is None
    # The plan (committed) is still present even while velocity is suppressed.
    assert payload["committed_points"] == 10
    assert payload["source"] == "sprint_close"


@pytest.mark.django_db
def test_close_emits_velocity_when_shared_externally(
    owner: Any,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """When the team raised velocity to PROGRAM_SHARED, the completion snapshot is
    emitted and velocity_suppressed is False."""
    from trueppm_api.apps.projects.tasks import close_sprint

    _share_velocity(project)
    sprint = _active_sprint(project)
    _task(project, "Done", sprint, story_points=8, status=TaskStatus.COMPLETE)
    req = SprintCloseRequest.objects.create(
        sprint=sprint, requested_by=owner, carry_over_to="backlog"
    )
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        close_sprint.run(str(req.id))
    payload = _payload_for(mock_dispatch, "sprint.closed")
    assert payload["velocity_suppressed"] is False
    assert payload["completed_points"] == 8
    assert payload["completed_task_count"] == 1
    assert payload["goal_outcome"] == "MET"  # 8/10 = 0.8


# ---------------------------------------------------------------------------
# sprint.scope_changed (accept service — fires on accept only)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_accept_fires_sprint_scope_changed(
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    sprint = _active_sprint(project)
    pending = _task(project, "Injected", sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        accept_scope_change(sc, owner)
    assert "sprint.scope_changed" in _fired_events(mock_dispatch)
    payload = _payload_for(mock_dispatch, "sprint.scope_changed")
    assert payload["id"] == str(sc.pk)
    assert payload["sprint"] == str(sprint.pk)
    assert payload["project"] == str(project.pk)
    assert payload["task"] == str(pending.pk)
    assert payload["status"] == ScopeChangeStatus.ACCEPTED


@pytest.mark.django_db
def test_reject_does_not_fire_sprint_scope_changed(
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Reject is a scope *decision*, but the event models scope that landed in the
    commitment — so it fires only on accept, never on reject (ADR-0147)."""
    sprint = _active_sprint(project)
    pending = _task(project, "Injected", sprint, story_points=3)
    sc = _inject(pending, sprint, owner)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        reject_scope_change(sc, owner)
    assert "sprint.scope_changed" not in _fired_events(mock_dispatch)


@pytest.mark.django_db
def test_silent_injection_does_not_fire_sprint_scope_changed(
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Recording a pending injection (no human accept) must not fire the event —
    only the ACCEPTED transition does."""
    sprint = _active_sprint(project)
    pending = _task(project, "Injected", sprint, story_points=3)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        _inject(pending, sprint, owner)
    assert "sprint.scope_changed" not in _fired_events(mock_dispatch)
