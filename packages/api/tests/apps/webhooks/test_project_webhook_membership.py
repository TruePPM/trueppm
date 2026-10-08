"""Project-scoped webhook dispatch honours live membership of the registrant (#4325).

#4310 added a live-``ProjectMembership`` re-check to program-scoped webhook
dispatch: a program grant is not a project-read grant, so a program-scoped
webhook's registrant (``created_by``) must still hold live membership on the
project an event comes from. That change deliberately left the project-scoped
branch of ``dispatch_webhooks`` untouched, reasoning (ADR-0161's amendment) that
a project-scoped webhook "is scoped to the very project whose event fires, so
there is no cross-project grant to re-check" — true of the *program* grant, but
it missed that the registrant's OWN membership on that same project can also
be revoked, and the project-scoped branch kept delivering anyway. #4325 closes
that: the identical live-membership check now also applies to project-scoped
webhooks, checked against their own project.

Edit/delete/delivery-log access for project-scoped webhooks needs no equivalent
fix: ``IsProjectAdmin`` already re-checks the *caller's* live membership on
every request (``_membership_role`` in ``apps/access/permissions.py`` only
honours non-soft-deleted rows), so a removed creator already loses those
abilities today. Only the async dispatch path read a stale assumption.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks import tasks as wh_tasks
from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks
from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Vega",
        code="vega-4325",
        start_date=date(2026, 4, 1),
        calendar=calendar,
    )


@pytest.fixture
def creator() -> Any:
    return User.objects.create_user(username="proj_hook_creator_4325", password="pw")


@pytest.fixture
def other_admin() -> Any:
    """A different project Admin — a live member, but not the webhook's creator."""
    return User.objects.create_user(username="other_admin_4325", password="pw")


def _project_webhook(project: Project, owner: Any | None) -> Webhook:
    return Webhook.objects.create(
        project=project,
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


def test_project_webhook_owned_by_live_member_fires(project: Project, creator: Any) -> None:
    ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)

    assert _dispatch(project) == 1
    assert WebhookDelivery.objects.count() == 1


def test_project_webhook_stops_firing_when_creator_membership_revoked(
    project: Project, creator: Any
) -> None:
    """Membership is read live at dispatch: soft-deleting it stops delivery."""
    membership = ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)
    assert _dispatch(project) == 1

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert _dispatch(project) == 0


def test_project_webhook_with_no_creator_fails_closed(project: Project) -> None:
    """A webhook registered with no ``created_by`` (e.g. a pre-existing row with
    the creator set to NULL) must not deliver — fail closed, not fail open."""
    _project_webhook(project, None)

    assert _dispatch(project) == 0


def test_project_webhook_with_deleted_creator_fails_closed(project: Project, creator: Any) -> None:
    """``created_by`` is SET_NULL on user delete — a NULL registrant must not deliver."""
    ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)
    Webhook.objects.update(created_by=None)

    assert _dispatch(project) == 0


def test_project_webhook_with_deactivated_creator_fails_closed(
    project: Project, creator: Any
) -> None:
    ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    assert _dispatch(project) == 0


def test_dispatch_resolves_project_webhook_membership_in_one_query_per_event(
    project: Project, creator: Any
) -> None:
    """Several project webhooks cost one membership query per event, not one each."""
    ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    for i in range(3):
        Webhook.objects.create(
            project=project,
            url=f"https://example.com/hook{i}",
            secret="test-secret-123",
            events=["task.created"],
            created_by=creator,
        )

    with CaptureQueriesContext(connection) as ctx:
        _dispatch(project)

    membership_queries = [
        q["sql"] for q in ctx.captured_queries if '"access_project_membership"' in q["sql"]
    ]
    assert len(membership_queries) == 1, membership_queries
    assert WebhookDelivery.objects.count() == 3


def _client_for(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_removed_creator_loses_edit_and_delivery_log_access(
    project: Project, creator: Any, other_admin: Any
) -> None:
    """Sibling-surface check: edit and the delivery log already re-check the
    CALLER's live membership on every request via ``IsProjectAdmin`` — unlike
    dispatch, there was no stale-assumption gap here. Documented, not patched.
    """
    ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=other_admin, role=Role.ADMIN)
    hook = _project_webhook(project, creator)
    client = _client_for(creator)
    url = f"/api/v1/projects/{project.pk}/webhooks/{hook.pk}/"

    ok = client.patch(url, {"url": "https://example.com/new-hook"}, format="json")
    assert ok.status_code == 200, ok.content

    ProjectMembership.objects.filter(project=project, user=creator).update(is_deleted=True)
    refused = client.patch(url, {"url": "https://example.com/newer-hook"}, format="json")
    assert refused.status_code == 403
    assert client.get(f"{url}deliveries/").status_code == 403

    # A different, still-live project Admin is unaffected — project-scoped admin
    # authority is not restricted to the registrant (contrast with the
    # registrant-only program-scoped rule, which exists because a program grant
    # alone is not a project-read grant).
    other_resp = _client_for(other_admin).patch(
        url, {"url": "https://example.com/admin-fixed-hook"}, format="json"
    )
    assert other_resp.status_code == 200, other_resp.content
