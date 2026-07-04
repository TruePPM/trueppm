"""Tests for the risk / baseline / comment webhook events (#1082, ADR-0206).

Five first-party domain events extend the webhook catalog beyond agile:

- ``risk.opened``    — RiskViewSet.perform_create (new risks default to OPEN)
- ``risk.escalated`` — RiskViewSet.perform_update, when computed severity
                       (probability × impact) increases vs the pre-save value
- ``risk.closed``    — RiskViewSet.perform_update, on the transition into CLOSED
- ``baseline.captured`` — BaselineViewSet.perform_create
- ``comment.created``   — TaskCommentViewSet.perform_create (every comment)

All five dispatch inside ``transaction.on_commit``, so the tests use
``django_capture_on_commit_callbacks(execute=True)`` and assert against a patched
``views._dispatch_webhooks`` trampoline.

None of these events carries a velocity/pulse (team-performance) signal, so no
ADR-0104 privacy gate applies. ``comment.created`` deliberately carries no comment
body (privacy-conservative) and is distinct from ``task.mentioned``, which fires
only when a comment @mentions someone.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import views
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    RiskStatus,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="rbc_owner", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="RbcEv", start_date=date(2026, 3, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _fired_events(mock: Any) -> list[str]:
    return [call.args[1] for call in mock.call_args_list]


def _payload_for(mock: Any, event_type: str) -> dict[str, Any]:
    return next(c for c in mock.call_args_list if c.args[1] == event_type).args[2]


def _create_risk(
    project: Project, *, probability: int, impact: int, status: str = RiskStatus.OPEN
) -> Risk:
    """Create a risk directly (bypassing the emit path) for update-scenario setup."""
    return Risk.objects.create(
        project=project,
        title="Register risk",
        probability=probability,
        impact=impact,
        status=status,
    )


def _risk_url(project: Project, risk: Risk | None = None) -> str:
    base = f"/api/v1/projects/{project.pk}/risks/"
    return f"{base}{risk.pk}/" if risk else base


# ---------------------------------------------------------------------------
# risk.opened (RiskViewSet.perform_create)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_fires_risk_opened(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(
            _risk_url(project),
            {"title": "Budget overrun", "probability": 2, "impact": 5},
            format="json",
        )
    assert resp.status_code == 201, resp.data
    assert "risk.opened" in _fired_events(mock_dispatch)
    payload = _payload_for(mock_dispatch, "risk.opened")
    assert payload["id"] == resp.data["id"]
    assert payload["project"] == str(project.pk)
    assert payload["title"] == "Budget overrun"
    assert payload["status"] == RiskStatus.OPEN
    assert payload["probability"] == 2
    assert payload["impact"] == 5
    assert payload["severity"] == 10  # 2 × 5, computed
    assert payload["source"] == "api"
    assert "short_id" in payload
    assert "owner" in payload


@pytest.mark.django_db
def test_create_as_closed_does_not_fire_risk_opened(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """status is client-writable — a risk POSTed straight to CLOSED must not emit
    risk.opened (it would never be balanced by a risk.closed transition)."""
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(
            _risk_url(project),
            {"title": "Retired risk", "probability": 1, "impact": 1, "status": RiskStatus.CLOSED},
            format="json",
        )
    assert resp.status_code == 201, resp.data
    assert "risk.opened" not in _fired_events(mock_dispatch)


# ---------------------------------------------------------------------------
# risk.escalated (RiskViewSet.perform_update — severity increase)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_fires_risk_escalated_when_severity_increases(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    risk = _create_risk(project, probability=2, impact=2)  # severity 4
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_risk_url(project, risk), {"impact": 5}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "risk.escalated" in events
    # risk.opened is a create-only event — never re-fired on update.
    assert "risk.opened" not in events
    payload = _payload_for(mock_dispatch, "risk.escalated")
    assert payload["id"] == str(risk.pk)
    assert payload["severity"] == 10  # 2 × 5


@pytest.mark.django_db
def test_update_does_not_fire_risk_escalated_when_severity_unchanged(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A title-only edit leaves severity untouched, so no escalation fires."""
    risk = _create_risk(project, probability=3, impact=2)  # severity 6
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_risk_url(project, risk), {"title": "Renamed"}, format="json")
    assert resp.status_code == 200, resp.data
    assert "risk.escalated" not in _fired_events(mock_dispatch)


@pytest.mark.django_db
def test_update_does_not_fire_risk_escalated_when_severity_decreases(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Severity going *down* is a de-escalation, not an escalation — no event."""
    risk = _create_risk(project, probability=4, impact=4)  # severity 16
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_risk_url(project, risk), {"impact": 2}, format="json")
    assert resp.status_code == 200, resp.data
    assert "risk.escalated" not in _fired_events(mock_dispatch)


# ---------------------------------------------------------------------------
# risk.closed (RiskViewSet.perform_update — transition into CLOSED)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_fires_risk_closed_on_transition_into_closed(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    risk = _create_risk(project, probability=2, impact=2, status=RiskStatus.OPEN)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(_risk_url(project, risk), {"status": RiskStatus.CLOSED}, format="json")
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "risk.closed" in events
    # Status changed but severity did not — no escalation.
    assert "risk.escalated" not in events
    payload = _payload_for(mock_dispatch, "risk.closed")
    assert payload["id"] == str(risk.pk)
    assert payload["status"] == RiskStatus.CLOSED


@pytest.mark.django_db
def test_update_does_not_fire_risk_closed_when_moving_to_resolved(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """RESOLVED is a distinct terminal state — risk.closed fires only on CLOSED."""
    risk = _create_risk(project, probability=2, impact=2, status=RiskStatus.OPEN)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(
            _risk_url(project, risk), {"status": RiskStatus.RESOLVED}, format="json"
        )
    assert resp.status_code == 200, resp.data
    assert "risk.closed" not in _fired_events(mock_dispatch)


@pytest.mark.django_db
def test_single_update_can_fire_both_escalated_and_closed(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """One PATCH that raises severity *and* moves to CLOSED emits both events."""
    risk = _create_risk(project, probability=2, impact=2, status=RiskStatus.OPEN)  # sev 4
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.patch(
            _risk_url(project, risk),
            {"impact": 5, "status": RiskStatus.CLOSED},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    events = _fired_events(mock_dispatch)
    assert "risk.escalated" in events
    assert "risk.closed" in events


# ---------------------------------------------------------------------------
# baseline.captured (BaselineViewSet.perform_create)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_baseline_fires_baseline_captured(
    client: APIClient,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    Task.objects.create(project=project, name="A", duration=1)
    Task.objects.create(project=project, name="B", duration=1)
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(
            f"/api/v1/projects/{project.pk}/baselines/",
            {"name": "Sprint 1 plan"},
            format="json",
        )
    assert resp.status_code == 201, resp.data
    assert "baseline.captured" in _fired_events(mock_dispatch)
    payload = _payload_for(mock_dispatch, "baseline.captured")
    assert payload["id"] == resp.data["id"]
    assert payload["project"] == str(project.pk)
    assert payload["name"] == "Sprint 1 plan"
    assert payload["task_count"] == 2
    assert payload["created_by"] == str(owner.pk)
    assert payload["has_cpm_dates"] is False  # tasks have no early_start
    assert payload["source"] == "api"


# ---------------------------------------------------------------------------
# comment.created (TaskCommentViewSet.perform_create)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_comment_fires_comment_created_without_body(
    client: APIClient,
    project: Project,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Reviewable", duration=1)
    url = f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/"
    with (
        patch.object(views, "_dispatch_webhooks") as mock_dispatch,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = client.post(url, {"body": "looks good to me"}, format="json")
    assert resp.status_code == 201, resp.data
    events = _fired_events(mock_dispatch)
    assert "comment.created" in events
    # A plain comment (no @mention) must NOT fire task.mentioned.
    assert "task.mentioned" not in events
    payload = _payload_for(mock_dispatch, "comment.created")
    # Privacy-conservative: the comment content is never in the payload.
    assert "body" not in payload
    assert payload["comment_id"] == resp.data["id"]
    assert payload["author"] == str(owner.pk)
    assert payload["author_display"] == owner.username
    assert "created_at" in payload
    # Task context is spread in — "id" is the task's id.
    assert payload["id"] == str(task.pk)
    assert payload["source"] == "api"
