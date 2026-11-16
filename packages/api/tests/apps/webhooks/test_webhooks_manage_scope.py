"""The ``webhooks:manage`` token scope (#2414).

A personal token carrying only this scope can create, read, update, delete and
test-ping outbound webhooks, acts under its owner's own role, and authenticates
nowhere else. It never reads the delivery log. A full-access token stays refused on
create/update (#4461), which these tests pin alongside.
"""

from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_API_FULL,
    SCOPE_WEBHOOKS_MANAGE,
    ApiToken,
    Calendar,
    Program,
    Project,
)
from trueppm_api.apps.webhooks.models import Webhook

User = get_user_model()

_BODY = {"url": "https://example.com/hook", "secret": "s" * 40, "events": ["task.created"]}


def _client(owner: object, scopes: list[str]) -> APIClient:
    raw = f"{TOKEN_PREFIX}{uuid.uuid4().hex}{uuid.uuid4().hex}"
    ApiToken.objects.create(
        owner=owner,
        name="bot",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=scopes,
    )
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return c


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="WHScope", start_date=date(2026, 3, 1), calendar=Calendar.objects.create(name="Std")
    )


@pytest.fixture
def admin(project: Project) -> object:
    user = User.objects.create_user(username="wh_scope_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def webhook(project: Project, admin: object) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created"],
        created_by=admin,
    )


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/webhooks/"


@pytest.mark.django_db
def test_scoped_token_creates_updates_and_deletes_a_webhook(
    project: Project, admin: object
) -> None:
    c = _client(admin, [SCOPE_WEBHOOKS_MANAGE])
    resp = c.post(_url(project), _BODY, format="json")
    assert resp.status_code == 201, resp.data
    pk = resp.data["id"]
    assert c.get(_url(project)).status_code == 200
    assert c.get(f"{_url(project)}{pk}/").status_code == 200
    resp = c.patch(f"{_url(project)}{pk}/", {"events": ["task.updated"]}, format="json")
    assert resp.status_code == 200, resp.data
    assert c.delete(f"{_url(project)}{pk}/").status_code == 204
    assert not Webhook.objects.filter(pk=pk).exists()


@pytest.mark.django_db
def test_scoped_token_can_test_ping(project: Project, admin: object, webhook: Webhook) -> None:
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    c = _client(admin, [SCOPE_WEBHOOKS_MANAGE])
    with patch.object(wh_tasks.deliver_webhook, "delay"):
        resp = c.post(f"{_url(project)}{webhook.pk}/test/")
    assert resp.status_code == 202, resp.data


@pytest.mark.django_db
def test_scoped_token_cannot_read_the_delivery_log(
    project: Project, admin: object, webhook: Webhook
) -> None:
    """Delivery payloads carry task notes and assignee emails (#903)."""
    url = f"{_url(project)}{webhook.pk}/deliveries/"
    assert _client(admin, [SCOPE_WEBHOOKS_MANAGE]).get(url).status_code == 403
    # A full-access token and a session still can, exactly as before.
    assert _client(admin, [SCOPE_API_FULL]).get(url).status_code == 200


@pytest.mark.django_db
def test_scoped_token_is_nothing_but_webhooks(project: Project, admin: object) -> None:
    """The scope authenticates on the webhook routes only: no other route serves it.

    The MCP-readable project routes recognize any ``tppm_`` bearer before the scope
    check, so they answer 403 (``mcp:read`` is required) rather than 401; neither
    returns data.
    """
    c = _client(admin, [SCOPE_WEBHOOKS_MANAGE])
    assert c.get("/api/v1/projects/").status_code in (401, 403)
    assert c.get(f"/api/v1/projects/{project.pk}/").status_code in (401, 403)
    assert c.get("/api/v1/tasks/").status_code in (401, 403)
    assert c.get("/api/v1/auth/me/").status_code in (401, 403)


@pytest.mark.django_db
def test_scoped_token_never_widens_the_owners_role(project: Project) -> None:
    """ADR-0112: a Member's webhooks:manage token is refused where the Member is."""
    member = User.objects.create_user(username="wh_scope_member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = _client(member, [SCOPE_WEBHOOKS_MANAGE])
    assert c.post(_url(project), _BODY, format="json").status_code == 403
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_scoped_token_cannot_reach_a_project_its_owner_is_not_in(admin: object) -> None:
    other = Project.objects.create(
        name="Other", start_date=date(2026, 3, 1), calendar=Calendar.objects.create(name="Std2")
    )
    resp = _client(admin, [SCOPE_WEBHOOKS_MANAGE]).post(_url(other), _BODY, format="json")
    assert resp.status_code in (403, 404)
    assert not Webhook.objects.filter(project=other).exists()


@pytest.mark.django_db
def test_full_access_token_is_still_refused_on_create_and_update(
    project: Project, admin: object, webhook: Webhook
) -> None:
    """#4461 is unchanged: only the narrow scope may mint or repoint a webhook."""
    c = _client(admin, [SCOPE_API_FULL])
    assert c.post(_url(project), _BODY, format="json").status_code == 403
    resp = c.patch(f"{_url(project)}{webhook.pk}/", {"url": "https://x.example.com"}, "json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_row_carrying_both_scopes_resolves_to_full_and_is_refused(
    project: Project, admin: object
) -> None:
    c = _client(admin, [SCOPE_API_FULL, SCOPE_WEBHOOKS_MANAGE])
    assert c.post(_url(project), _BODY, format="json").status_code == 403


@pytest.mark.django_db
def test_program_webhooks_accept_the_scoped_token() -> None:
    program = Program.objects.create(name="Artemis")
    admin = User.objects.create_user(username="wh_scope_padmin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    c = _client(admin, [SCOPE_WEBHOOKS_MANAGE])
    url = f"/api/v1/programs/{program.pk}/webhooks/"
    resp = c.post(url, _BODY, format="json")
    assert resp.status_code == 201, resp.data
    pk = resp.data["id"]
    assert c.patch(f"{url}{pk}/", {"events": ["task.updated"]}, format="json").status_code == 200
    assert c.get(f"{url}{pk}/deliveries/").status_code == 403
    assert c.delete(f"{url}{pk}/").status_code == 204


# --- minting -----------------------------------------------------------------


@pytest.mark.django_db
def test_personal_token_can_be_minted_with_the_scope(admin: object) -> None:
    c = APIClient()
    c.force_authenticate(user=admin)
    resp = c.post(
        "/api/v1/me/api-tokens/",
        {"name": "ci", "scopes": [SCOPE_WEBHOOKS_MANAGE]},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["scopes"] == [SCOPE_WEBHOOKS_MANAGE]


@pytest.mark.django_db
@pytest.mark.parametrize("other", [SCOPE_API_FULL, "mcp:read"])
def test_the_scope_cannot_be_combined(admin: object, other: str) -> None:
    c = APIClient()
    c.force_authenticate(user=admin)
    resp = c.post(
        "/api/v1/me/api-tokens/",
        {"name": "ci", "scopes": [SCOPE_WEBHOOKS_MANAGE, other]},
        format="json",
    )
    assert resp.status_code == 400
    assert "scopes" in resp.data


@pytest.mark.django_db
def test_project_scoped_token_cannot_carry_the_scope(project: Project, admin: object) -> None:
    """A project token resolves to its minter, which would widen it on these routes."""
    c = APIClient()
    c.force_authenticate(user=admin)
    resp = c.post(
        f"/api/v1/projects/{project.pk}/api-tokens/",
        {"name": "ci", "scopes": [SCOPE_WEBHOOKS_MANAGE]},
        format="json",
    )
    assert resp.status_code == 400, resp.data
    assert "scopes" in resp.data
