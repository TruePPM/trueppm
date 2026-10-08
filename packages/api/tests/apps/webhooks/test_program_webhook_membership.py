"""Program-scoped webhook fan-out honours project membership of the owner (#4310).

A program-scoped webhook fires for events on every member project. The program
grant is not a read grant on the project, so the webhook's registrant
(``created_by``) must hold live ``ProjectMembership`` on the project the event came
from. Project-scoped webhooks get the identical check against their own project
(#4325) — see ``test_project_webhook_membership.py``.

#4330 adds a role floor on top of that same membership: live membership used to
be enough at any role, but the delivery-log read endpoint has always been
Admin-only, so a registrant demoted to Viewer or Member (not removed) kept
receiving the same payloads via dispatch that they could no longer read back
through the delivery log. Dispatch now requires ``role >= Role.ADMIN`` on that
live membership — see the "role floor" tests below, and
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


def test_program_webhook_owned_by_admin_fires(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """#4330: Admin is the floor, so an Admin registrant still fires."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    _program_webhook(program, member_owner)

    assert _dispatch(project_p) == 1
    assert WebhookDelivery.objects.count() == 1


def test_program_webhook_owned_by_owner_fires(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """#4330: Owner is above the Admin floor, so an Owner registrant fires too."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.OWNER)
    _program_webhook(program, member_owner)

    assert _dispatch(project_p) == 1
    assert WebhookDelivery.objects.count() == 1


def test_program_webhook_owned_by_mere_member_does_not_fire(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """#4330: live membership below Admin (Member here) is no longer enough.

    Before #4330 this registrant fired (any live membership qualified) — the
    delivery-log read endpoint has always been Admin-only, so dispatch must now
    match it.
    """
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    _program_webhook(program, member_owner)

    assert _dispatch(project_p) == 0
    assert WebhookDelivery.objects.count() == 0


def test_program_webhook_stops_firing_when_owner_membership_revoked(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """Membership is read live at dispatch: soft-deleting it stops delivery."""
    membership = ProjectMembership.objects.create(
        project=project_p, user=member_owner, role=Role.ADMIN
    )
    _program_webhook(program, member_owner)
    assert _dispatch(project_p) == 1

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    assert _dispatch(project_p) == 0


def test_program_webhook_stops_firing_when_owner_demoted_to_viewer(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """#4330: a demotion (still a LIVE member, just a lower role) must also stop
    delivery — not only a full removal. This is the exact gap #4330 reports: a
    webhook creator demoted from Admin to Viewer kept receiving full event
    payloads via dispatch even though the delivery-log endpoint would now
    refuse them."""
    membership = ProjectMembership.objects.create(
        project=project_p, user=member_owner, role=Role.ADMIN
    )
    _program_webhook(program, member_owner)
    assert _dispatch(project_p) == 1

    membership.role = Role.VIEWER
    membership.save(update_fields=["role"])

    assert _dispatch(project_p) == 0


def test_program_webhook_stops_firing_when_owner_demoted_to_member(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """#4330: same demotion gap, landing one band higher (Admin -> Member)."""
    membership = ProjectMembership.objects.create(
        project=project_p, user=member_owner, role=Role.ADMIN
    )
    _program_webhook(program, member_owner)
    assert _dispatch(project_p) == 1

    membership.role = Role.MEMBER
    membership.save(update_fields=["role"])

    assert _dispatch(project_p) == 0


def test_program_webhook_with_deleted_owner_fails_closed(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """``created_by`` is SET_NULL on user delete — a NULL owner must not deliver."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    _program_webhook(program, member_owner)
    Webhook.objects.update(created_by=None)

    assert _dispatch(project_p) == 0


def test_program_webhook_with_deactivated_owner_fails_closed(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    _program_webhook(program, member_owner)
    member_owner.is_active = False
    member_owner.save(update_fields=["is_active"])

    assert _dispatch(project_p) == 0


def test_project_webhook_also_requires_live_creator_membership(
    project_p: Project, program_admin: Any
) -> None:
    """#4325: project-scoped webhooks get the same live-membership check.

    ``program_admin`` holds a Program Admin grant but no ``ProjectMembership`` on
    ``project_p`` — a project-scoped webhook they registered must not deliver.
    Full project-scoped coverage lives in ``test_project_webhook_membership.py``.
    """
    Webhook.objects.create(
        project=project_p,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created"],
        created_by=program_admin,
    )

    assert _dispatch(project_p) == 0


def test_dispatch_resolves_owner_membership_in_one_query_per_event(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """Several program webhooks cost one membership query per event, not one each."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
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


def _client_for(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def test_non_member_admin_cannot_re_point_a_members_webhook(
    program: Program, project_p: Project, member_owner: Any, program_admin: Any
) -> None:
    """#4310 (B2, option c): a non-member admin's PATCH is refused, so the URL is unchanged."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    hook = _program_webhook(program, member_owner)

    resp = _client_for(program_admin).patch(
        f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/",
        {"url": "https://attacker.example.com/collect"},
        format="json",
    )

    assert resp.status_code == 403
    hook.refresh_from_db()
    assert hook.url == "https://example.com/hook"
    assert hook.created_by_id == member_owner.pk
    # The original subscription still receives P's event; the attacker URL gets nothing.
    assert _dispatch(project_p) == 1


def test_non_member_admin_empty_patch_then_delivery_log_leaks_nothing(
    program: Program, project_p: Project, member_owner: Any, program_admin: Any
) -> None:
    """#4310 (B3 closure): a no-op PATCH must not make the outsider the registrant.

    Previously an empty PATCH re-stamped created_by, and the delivery log then
    returned every stored past payload of P. Both steps are refused now.
    """
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    hook = _program_webhook(program, member_owner)
    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        dispatch_webhooks(str(project_p.pk), "task.created", {"id": "t-4310-secret"})
    assert WebhookDelivery.objects.filter(webhook=hook).count() == 1

    client = _client_for(program_admin)
    patch_resp = client.patch(
        f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/", {}, format="json"
    )
    assert patch_resp.status_code == 403

    log_resp = client.get(f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/deliveries/")
    assert log_resp.status_code == 403
    assert b"t-4310-secret" not in log_resp.content
    hook.refresh_from_db()
    assert hook.created_by_id == member_owner.pk


def test_member_creator_can_patch_then_loses_edit_on_revocation(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """The registrant edits while a live member, and is refused once membership is revoked."""
    ProgramMembership.objects.create(program=program, user=member_owner, role=Role.ADMIN)
    membership = ProjectMembership.objects.create(
        project=project_p, user=member_owner, role=Role.MEMBER
    )
    hook = _program_webhook(program, member_owner)
    client = _client_for(member_owner)
    url = f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/"

    ok = client.patch(url, {"url": "https://example.com/new-hook"}, format="json")
    assert ok.status_code == 200, ok.content

    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])
    refused = client.patch(url, {"url": "https://example.com/newer-hook"}, format="json")
    assert refused.status_code == 403
    hook.refresh_from_db()
    assert hook.url == "https://example.com/new-hook"


def test_another_admin_cannot_read_a_members_delivery_log(
    program: Program, project_p: Project, member_owner: Any, program_admin: Any
) -> None:
    """#4310 (B3): the delivery log replays past payloads, so it is the registrant's only."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.ADMIN)
    ProgramMembership.objects.create(program=program, user=member_owner, role=Role.ADMIN)
    hook = _program_webhook(program, member_owner)
    assert _dispatch(project_p) == 1

    url = f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/deliveries/"
    assert _client_for(program_admin).get(url).status_code == 403
    assert _client_for(member_owner).get(url).status_code == 200


def _edit_url(program: Program, hook: Webhook) -> str:
    return f"/api/v1/programs/{program.pk}/webhooks/{hook.pk}/"


def test_creator_must_be_a_member_of_every_program_project_to_edit(
    program: Program, project_p: Project, calendar: Calendar, member_owner: Any
) -> None:
    """#4310 (option c): membership on ONE of the program's projects is not enough.

    The edit gate requires the creator to be a live member of every live project in the
    program. Adding a second project later locks the creator out until they join it.
    """
    project_q = Project.objects.create(
        name="Juno",
        code="juno-4310",
        start_date=date(2026, 4, 1),
        calendar=calendar,
        program=program,
    )
    ProgramMembership.objects.create(program=program, user=member_owner, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    hook = _program_webhook(program, member_owner)
    client = _client_for(member_owner)

    refused = client.patch(
        _edit_url(program, hook), {"url": "https://example.com/new-hook"}, format="json"
    )
    assert refused.status_code == 403
    hook.refresh_from_db()
    assert hook.url == "https://example.com/hook"

    ProjectMembership.objects.create(project=project_q, user=member_owner, role=Role.MEMBER)
    allowed = client.patch(
        _edit_url(program, hook), {"url": "https://example.com/new-hook"}, format="json"
    )
    assert allowed.status_code == 200, allowed.content
    hook.refresh_from_db()
    assert hook.url == "https://example.com/new-hook"


def test_put_by_non_member_on_creatorless_webhook_is_refused(
    program: Program, project_p: Project, program_admin: Any
) -> None:
    """A webhook whose registrant was deleted (created_by NULL) cannot be replaced by an admin."""
    hook = _program_webhook(program, program_admin)
    Webhook.objects.filter(pk=hook.pk).update(created_by=None)

    resp = _client_for(program_admin).put(
        _edit_url(program, hook),
        {"url": "https://attacker.example.com/collect", "events": ["task.created"]},
        format="json",
    )

    assert resp.status_code == 403
    hook.refresh_from_db()
    assert hook.url == "https://example.com/hook"


def test_put_by_member_creator_with_full_membership_succeeds(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    ProgramMembership.objects.create(program=program, user=member_owner, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    hook = _program_webhook(program, member_owner)

    resp = _client_for(member_owner).put(
        _edit_url(program, hook),
        {"url": "https://example.com/put-hook", "events": ["task.created"]},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    hook.refresh_from_db()
    assert hook.url == "https://example.com/put-hook"


def test_superuser_who_is_not_the_creator_cannot_edit_a_members_webhook(
    program: Program, project_p: Project, member_owner: Any
) -> None:
    """Neither a superuser nor a workspace admin is a bypass for the registrant rule."""
    ProjectMembership.objects.create(project=project_p, user=member_owner, role=Role.MEMBER)
    hook = _program_webhook(program, member_owner)
    superuser = User.objects.create_user(
        username="superuser_4310", password="pw", is_superuser=True, is_staff=True
    )

    resp = _client_for(superuser).patch(
        _edit_url(program, hook), {"url": "https://attacker.example.com/collect"}, format="json"
    )

    assert resp.status_code == 403
    hook.refresh_from_db()
    assert hook.url == "https://example.com/hook"
