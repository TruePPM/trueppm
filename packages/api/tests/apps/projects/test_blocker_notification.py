"""Actionable task.blocked email body (ADR-0165, #1158).

``render_blocker_notification`` enriches the frozen email body with the actor, the
soft ``blocking_task`` title, and a deep-link to the task — while NEVER emitting the
private ``blocked_reason`` (the Morgan boundary, ADR-0124 §4). The link line appears
only when ``FRONTEND_BASE_URL`` is configured.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings

from trueppm_api.apps.projects.blocker_services import (
    render_blocker_notification,
    task_deep_link,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()

REASON = "SECRET: vendor escalation, blocked on legal sign-off"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def actor(db: object) -> Any:
    return User.objects.create_user(username="marcus", password="pw", email="m@x.io")


@pytest.fixture
def blocking(project: Project) -> Task:
    return Task.objects.create(project=project, name="Vendor contract", duration=1)


@pytest.fixture
def blocked(project: Project, actor: Any, blocking: Task) -> Task:
    return Task.objects.create(
        project=project,
        name="Foundation pour",
        duration=1,
        blocked_reason=REASON,
        blocker_type="vendor",
        blocked_by=actor,
        blocking_task=blocking,
    )


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com")
def test_email_body_has_actor_blocking_task_and_link(blocked: Task) -> None:
    subject, body = render_blocker_notification(blocked)
    assert subject == "Foundation pour is blocked"
    assert "Flagged by marcus." in body
    assert 'Waiting on: "Vendor contract".' in body
    assert (
        f"https://app.example.com/projects/{blocked.project_id}/schedule?task={blocked.pk}" in body
    )
    # The private reason is never in the body.
    assert REASON not in body
    assert "SECRET" not in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="")
def test_link_omitted_when_base_url_unset(blocked: Task) -> None:
    _subject, body = render_blocker_notification(blocked)
    assert "Open the task:" not in body
    # Actor + blocking-task still render — the email degrades gracefully.
    assert "Flagged by marcus." in body
    assert 'Waiting on: "Vendor contract".' in body


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com/")
def test_trailing_slash_stripped(blocked: Task) -> None:
    link = task_deep_link(blocked)
    assert "//projects" not in link
    assert link == (
        f"https://app.example.com/projects/{blocked.project_id}/schedule?task={blocked.pk}"
    )


@pytest.mark.django_db
@override_settings(FRONTEND_BASE_URL="https://app.example.com")
def test_bare_flag_renders_without_optional_lines(project: Project) -> None:
    """No actor, no blocking_task, no type: still a clean single lead line + link."""
    task = Task.objects.create(project=project, name="Lonely", duration=1, blocked_reason="x")
    _subject, body = render_blocker_notification(task)
    assert '"Lonely" was flagged blocked' in body
    assert "Flagged by" not in body
    assert "Waiting on:" not in body
    assert "Open the task:" in body
