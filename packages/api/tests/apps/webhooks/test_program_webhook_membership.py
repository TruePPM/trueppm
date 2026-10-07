"""Program-scoped webhook fan-out honours project membership of the owner (#4310).

A program-scoped webhook fires for events on every member project. The program
grant is not a read grant on the project, so the webhook's registrant
(``created_by``) must hold live ``ProjectMembership`` on the project the event came
from. Project-scoped webhooks are unchanged.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project
from trueppm_api.apps.webhooks import tasks as wh_tasks
from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks
from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def program() -> Program:
    return Program.objects.create(name="Atlas")


@pytest.fixture
def program_admin() -> Any:
    """A Program Admin with NO membership on any member project."""
    user = User.objects.create_user(username="prog_admin_4310", password="pw")
    return user


@pytest.fixture
def member_owner() -> Any:
    return User.objects.create_user(username="member_owner_4310", password="pw")


@pytest.fixture
def project_p(program: Program, calendar: Calendar, program_admin: Any) -> Project:
    ProgramMembership.objects.create(program=program, user=program_admin, role=Role.ADMIN)
    return Project.objects.create(
        name="Apollo",
        code="apollo",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )


def _program_webhook(program: Program, owner: Any) -> Webhook:
    return Webhook.objects.create(
        program=program,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created"],
        created_by=owner,
    )


def _dispatch(project: Project) -> int:
    """Dispatch a ``task.created`` event for ``project``; return deliveries enqueued."""
    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})
        return int(mock_task.delay.call_count)


def test_program_webhook_owned_by_non_member_admin_does_not_fire(
    program: Program, project_p: Project, program_admin: Any
) -> None:
    """Mallory-style registrant: Program Admin, no ProjectMembership on P. No delivery."""
    _program_webhook(program, program_admin)

    assert _dispatch(project_p) == 0
    assert WebhookDelivery.objects.count() == 0


def test_program_webhook_owned_by_member_fires(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    _program_webhook(program, member_owner)

    assert _dispatch(project_p) == 1
    assert WebhookDelivery.objects.count() == 1


def test_program_webhook_stops_firing_when_owner_membership_revoked(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """Membership is read live at dispatch: soft-deleting it stops delivery."""
    membership = ProjectMembership.objects.create(
        project=project_p, user=member_owner, role=Role.MEMBER
    )
    _program_webhook(program, member_owner)
    assert _dispatch(project_p) == 1

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert _dispatch(project_p) == 0


def test_program_webhook_with_deleted_owner_fails_closed(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """``created_by`` is SET_NULL on user delete — a NULL owner must not deliver."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    _program_webhook(program, member_owner)
    Webhook.objects.update(created_by=None)

    assert _dispatch(project_p) == 0


def test_program_webhook_with_deactivated_owner_fails_closed(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    _program_webhook(program, member_owner)
    member_owner.is_active = False
    member_owner.save(update_fields=["is_active"])

    assert _dispatch(project_p) == 0


def test_project_webhook_is_not_gated_by_creator_membership(
    project_p: Project, program_admin: Any
) -> None:
    """Pins scope: the membership re-check is for program-scoped rows only."""
    Webhook.objects.create(
        project=project_p,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created"],
        created_by=program_admin,
    )

    assert _dispatch(project_p) == 1


def test_dispatch_resolves_owner_membership_in_one_query_per_event(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """Several program webhooks cost one membership query per event, not one each."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    for i in range(3):
        Webhook.objects.create(
            program=program,
            url=f"https://example.com/hook{i}",
            secret="test-secret-123",
            events=["task.created"],
            created_by=member_owner,
        )

    with CaptureQueriesContext(connection) as ctx:
        _dispatch(project_p)

    membership_queries = [
        q["sql"] for q in ctx.captured_queries if '"access_project_membership"' in q["sql"]
    ]
    assert len(membership_queries) == 1, membership_queries
    assert WebhookDelivery.objects.count() == 3
