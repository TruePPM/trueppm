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


def _client_and_token(owner: object, scopes: list[str]) -> tuple[APIClient, ApiToken]:
    raw = f"{TOKEN_PREFIX}{uuid.uuid4().hex}{uuid.uuid4().hex}"
    token = ApiToken.objects.create(
        owner=owner,
        name="bot",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=scopes,
    )
    c = APIClient()
    c.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return c, token


def _client(owner: object, scopes: list[str]) -> APIClient:
    return _client_and_token(owner, scopes)[0]


def _session(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
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
    """The scope authenticates on the webhook routes only: every other route is 401.

    Includes the surfaces that prepend ``ProjectApiTokenAuthentication`` ahead of the
    default stack — the MCP-readable project reads and the key resolver
    (``resolve/``, ``keys/``) — which the base authenticator refuses for this scope.
    """
    c = _client(admin, [SCOPE_WEBHOOKS_MANAGE])
    for url in (
        "/api/v1/projects/",
        f"/api/v1/projects/{project.pk}/",
        "/api/v1/tasks/",
        "/api/v1/auth/me/",
        f"/api/v1/resolve/?ref={project.pk}",
        "/api/v1/keys/?name=Platform",
        # The MCP-readable schedule-structure reads (#5006).
        f"/api/v1/projects/{project.pk}/history/",
        f"/api/v1/projects/{project.pk}/baselines/",
        f"/api/v1/projects/{project.pk}/phases/",
        f"/api/v1/dependencies/?project={project.pk}",
        "/api/v1/calendars/",
    ):
        assert c.get(url).status_code == 401, url


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


# --- revocation (#2414) ------------------------------------------------------


@pytest.mark.django_db
def test_revoking_the_token_deactivates_the_webhooks_it_configured(
    project: Project, admin: object, webhook: Webhook
) -> None:
    """A leaked token's webhook must stop delivering when the token is revoked.

    Covers both durable-grant shapes the token can produce: a webhook it registered,
    and a session-registered webhook it repointed. A webhook the owner's own session
    configured, and one another token of the same owner configured, stay live.
    """
    c, token = _client_and_token(admin, [SCOPE_WEBHOOKS_MANAGE])
    other_c, _ = _client_and_token(admin, [SCOPE_WEBHOOKS_MANAGE])
    created = c.post(_url(project), _BODY, format="json")
    assert created.status_code == 201, created.data
    repoint = c.patch(
        f"{_url(project)}{webhook.pk}/", {"url": "https://attacker.example.com/h"}, format="json"
    )
    assert repoint.status_code == 200, repoint.data
    untouched = Webhook.objects.create(
        project=project,
        url="https://example.com/own",
        secret="x" * 20,
        events=["task.created"],
        created_by=admin,
    )
    sibling = other_c.post(_url(project), _BODY, format="json")
    assert sibling.status_code == 201, sibling.data

    program = Program.objects.create(name="Revoke")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    prog = c.post(f"/api/v1/programs/{program.pk}/webhooks/", _BODY, format="json")
    assert prog.status_code == 201, prog.data

    assert _session(admin).delete(f"/api/v1/me/api-tokens/{token.pk}/").status_code == 204

    for pk in (created.data["id"], webhook.pk, prog.data["id"]):
        row = Webhook.objects.get(pk=pk)
        assert row.is_active is False, pk
        assert row.disabled_at is not None
        assert "API token" in row.disabled_reason
    assert Webhook.objects.get(pk=untouched.pk).is_active is True
    assert Webhook.objects.get(pk=sibling.data["id"]).is_active is True


@pytest.mark.django_db
def test_a_session_edit_after_the_token_does_not_erase_its_attribution(
    project: Project, admin: object
) -> None:
    """Append-only, like WebhookEditor: a later session PUT carrying the same url keeps it."""
    c, token = _client_and_token(admin, [SCOPE_WEBHOOKS_MANAGE])
    pk = c.post(_url(project), _BODY, format="json").data["id"]
    assert (
        _session(admin).patch(f"{_url(project)}{pk}/", {"url": _BODY["url"]}, format="json")
    ).status_code == 200
    assert _session(admin).delete(f"/api/v1/me/api-tokens/{token.pk}/").status_code == 204
    assert Webhook.objects.get(pk=pk).is_active is False


def _revoke_like_destroy(token: ApiToken) -> None:
    """Run ``MyApiTokenViewSet.destroy``'s two statements, as a concurrent revoke would."""
    from django.utils import timezone

    from trueppm_api.apps.webhooks.models import deactivate_webhooks_set_by_token

    ApiToken.objects.filter(pk=token.pk, revoked_at__isnull=True).update(revoked_at=timezone.now())
    deactivate_webhooks_set_by_token(token.pk)


@pytest.mark.django_db
@pytest.mark.parametrize("shape", ["project_create", "program_create", "repoint", "reenable"])
def test_a_revoke_landing_after_authentication_refuses_the_write(
    project: Project, admin: object, webhook: Webhook, shape: str
) -> None:
    """A revoke between authentication and the write's commit leaves no live webhook.

    The request has already authenticated when the revoke runs, and the revoke's
    deactivate sweep cannot see an editor row this write has not inserted yet. The
    write must therefore re-read the token under its row lock and refuse (#2414).
    The revoke is injected at the profile-lock step, i.e. after authentication and
    before ``serializer.save``.
    """
    from trueppm_api.apps.webhooks import views as wh_views

    c, token = _client_and_token(admin, [SCOPE_WEBHOOKS_MANAGE])
    if shape == "reenable":
        webhook.is_active = False
        webhook.save(update_fields=["is_active"])
    before = set(Webhook.objects.values_list("pk", flat=True))
    real = wh_views.lock_and_recheck_credential_cutoff

    def revoke_then_lock(request: object) -> None:
        _revoke_like_destroy(token)
        real(request)

    with patch.object(wh_views, "lock_and_recheck_credential_cutoff", revoke_then_lock):
        if shape == "project_create":
            resp = c.post(_url(project), _BODY, format="json")
        elif shape == "program_create":
            program = Program.objects.create(name="RaceProg")
            ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
            resp = c.post(f"/api/v1/programs/{program.pk}/webhooks/", _BODY, format="json")
        elif shape == "repoint":
            resp = c.patch(
                f"{_url(project)}{webhook.pk}/",
                {"url": "https://attacker.example.com/h"},
                format="json",
            )
        else:
            resp = c.patch(f"{_url(project)}{webhook.pk}/", {"is_active": True}, format="json")

    assert resp.status_code == 401, resp.data
    assert set(Webhook.objects.values_list("pk", flat=True)) == before
    webhook.refresh_from_db()
    assert webhook.url == "https://example.com/hook"
    assert webhook.is_active is (shape != "reenable")


# --- schema (#4461 403 on the full-token-refused writes) ---------------------


def test_schema_declares_the_token_refusal_on_webhook_writes() -> None:
    """The 403 a full-access token receives on create/update stays in the contract."""
    import json
    from pathlib import Path

    root = next(p for p in Path(__file__).resolve().parents if (p / "docs" / "api").is_dir())
    paths = json.loads((root / "docs" / "api" / "openapi.json").read_text())["paths"]
    # The three operations whose 403 is the token refusal itself; the other webhook
    # writes declare their own, richer 403 first (``setdefault`` keeps it).
    ops = [
        paths["/api/v1/programs/{program_pk}/webhooks/"]["post"],
        paths["/api/v1/projects/{project_pk}/webhooks/{id}/"]["put"],
        paths["/api/v1/projects/{project_pk}/webhooks/{id}/"]["patch"],
    ]
    for op in ops:
        assert "403" in op["responses"], op["operationId"]
        assert "API token" in op["responses"]["403"]["description"], op["operationId"]
