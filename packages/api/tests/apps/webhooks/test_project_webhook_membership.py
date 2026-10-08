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

#4330 adds a role floor on top of that same live-membership check: a registrant
demoted from Admin to Member or Viewer (still a LIVE member, not removed) kept
receiving the same payloads via dispatch that ``IsProjectAdmin`` already refused
them on the delivery-log endpoint. Dispatch now requires ``role >= Role.ADMIN``
on the registrant's live ``ProjectMembership``, matching that read gate exactly
— see the "role floor" tests below, and
``_drop_webhooks_without_live_member_owner`` in ``dispatch.py``.
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


def test_project_webhook_owned_by_owner_fires(project: Project, creator: Any) -> None:
    """#4330: Owner is above the Admin floor, so an Owner registrant fires too."""
    ProjectMembership.objects.create(project=project, user=creator, role=Role.OWNER)
    _project_webhook(project, creator)

    assert _dispatch(project) == 1
    assert WebhookDelivery.objects.count() == 1


def test_project_webhook_owned_by_mere_member_does_not_fire(project: Project, creator: Any) -> None:
    """#4330: live membership below Admin (Member here) is no longer enough.

    Before #4330 any live membership qualified — the delivery-log read
    endpoint (``IsProjectAdmin``) has always been Admin-only, so dispatch must
    now match it.
    """
    ProjectMembership.objects.create(project=project, user=creator, role=Role.MEMBER)
    _project_webhook(project, creator)

    assert _dispatch(project) == 0
    assert WebhookDelivery.objects.count() == 0


def test_project_webhook_owned_by_viewer_does_not_fire(project: Project, creator: Any) -> None:
    """#4330: same floor, Viewer this time — the lowest live role."""
    ProjectMembership.objects.create(project=project, user=creator, role=Role.VIEWER)
    _project_webhook(project, creator)

    assert _dispatch(project) == 0
    assert WebhookDelivery.objects.count() == 0


def test_project_webhook_owned_by_scheduler_does_not_fire(project: Project, creator: Any) -> None:
    """#4330: Scheduler (ordinal 200) is the band directly below Admin (300) —
    pins the floor at exactly ``Role.ADMIN``, not ``Role.SCHEDULER`` or lower.
    Without this case, a filter accidentally written as
    ``role__gte=Role.SCHEDULER`` would pass every other test in this file."""
    ProjectMembership.objects.create(project=project, user=creator, role=Role.SCHEDULER)
    _project_webhook(project, creator)

    assert _dispatch(project) == 0
    assert WebhookDelivery.objects.count() == 0


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


def test_project_webhook_stops_firing_when_creator_demoted_to_viewer(
    project: Project, creator: Any
) -> None:
    """#4330: a demotion (still a LIVE member, just a lower role) must also stop
    delivery — not only a full removal. This is the exact gap #4330 reports: a
    webhook creator demoted from Admin to Viewer kept receiving full event
    payloads via dispatch even though the delivery-log endpoint would now
    refuse them."""
    membership = ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)
    assert _dispatch(project) == 1

    membership.role = Role.VIEWER
    membership.save(update_fields=["role"])

    assert _dispatch(project) == 0


def test_project_webhook_stops_firing_when_creator_demoted_to_member(
    project: Project, creator: Any
) -> None:
    """#4330: same demotion gap, landing one band higher (Admin -> Member)."""
    membership = ProjectMembership.objects.create(project=project, user=creator, role=Role.ADMIN)
    _project_webhook(project, creator)
    assert _dispatch(project) == 1

    membership.role = Role.MEMBER
    membership.save(update_fields=["role"])

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


def test_mixed_live_and_revoked_registrants_only_the_live_one_fires(
    project: Project, creator: Any, other_admin: Any
) -> None:
    """Two project webhooks on the same project, one owned by a live member and one
    by a registrant whose membership was revoked: only the live-owned one dispatches.
    The earlier single-registrant tests above cannot show this — the membership
    query resolves the whole batch of candidate webhooks together (#4325's
    one-query guarantee), so a bug that dropped the wrong row, or none at all,
    would not be visible without both outcomes present in the same dispatch."""
    live_membership = ProjectMembership.objects.create(
        project=project, user=other_admin, role=Role.ADMIN
    )
    revoked_membership = ProjectMembership.objects.create(
        project=project, user=creator, role=Role.ADMIN
    )
    live_hook = _project_webhook(project, other_admin)
    revoked_hook = _project_webhook(project, creator)

    revoked_membership.is_deleted = True
    revoked_membership.save(update_fields=["is_deleted"])

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})
        assert mock_task.delay.call_count == 1

    deliveries = list(WebhookDelivery.objects.all())
    assert len(deliveries) == 1
    assert deliveries[0].webhook_id == live_hook.pk
    assert not WebhookDelivery.objects.filter(webhook_id=revoked_hook.pk).exists()

    # Sanity: `live_membership` is still live and was never the subject of the
    # revocation above — guards against a copy/paste bug picking the wrong var.
    assert ProjectMembership.objects.get(pk=live_membership.pk).is_deleted is False


def _client_for(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_removed_creator_loses_edit_and_delivery_log_access(
    project: Project, creator: Any, other_admin: Any
) -> None:
    """Sibling-surface check: edit, delete, and the delivery log already re-check
    the CALLER's live membership on every request via ``IsProjectAdmin`` — unlike
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

    # The delete route is re-checked per request exactly like edit — not just
    # asserted in a docstring. The webhook must still exist afterward (the
    # refusal did not partially apply) for the still-live Admin check below.
    destroy_refused = client.delete(url)
    assert destroy_refused.status_code == 403
    assert Webhook.objects.filter(pk=hook.pk).exists()

    # A different, still-live project Admin is unaffected — project-scoped admin
    # authority is not restricted to the registrant (contrast with the
    # registrant-only program-scoped rule, which exists because a program grant
    # alone is not a project-read grant).
    other_resp = _client_for(other_admin).patch(
        url, {"url": "https://example.com/admin-fixed-hook"}, format="json"
    )
    assert other_resp.status_code == 200, other_resp.content
