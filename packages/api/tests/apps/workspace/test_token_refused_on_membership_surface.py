"""A personal access token cannot mint or hand off workspace authority (#3847).

Invites, member role changes, group grants, ownership transfer and the project/program
membership grants each create access that outlives the credential that created it, and a
workspace export is exfiltration revoking the token cannot recall. Every refusal below is
paired with a session that still succeeds, so the test proves the guard and not a
generally broken route.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL, ApiToken, Calendar, Project
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

User = get_user_model()

_REFUSAL = "API tokens cannot manage"


@pytest.fixture
def owner(db: object) -> Any:
    user = User.objects.create_user(username="ws_owner", password="pw", email="o@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.OWNER
    )
    return user


@pytest.fixture
def member(db: object) -> Any:
    user = User.objects.create_user(username="ws_member", password="pw", email="m@example.com")
    WorkspaceMembership.objects.create(
        workspace=Workspace.load(), user=user, role=WorkspaceRole.MEMBER
    )
    return user


def _bearer(owner: Any) -> APIClient:
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="pat",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_LEGACY_FULL],
        expires_at=timezone.now() + timedelta(days=30),
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _session(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _refused(resp: Any) -> None:
    assert resp.status_code == 403, resp.content
    assert _REFUSAL in str(resp.data["detail"])


@pytest.mark.django_db
def test_token_cannot_transfer_ownership(owner: Any, member: Any) -> None:
    resp = _bearer(owner).post(
        "/api/v1/workspace/transfer-ownership/", {"new_owner_user_id": member.pk}, format="json"
    )
    _refused(resp)
    assert WorkspaceMembership.objects.get(user=owner).role == WorkspaceRole.OWNER
    ok = _session(owner).post(
        "/api/v1/workspace/transfer-ownership/", {"new_owner_user_id": member.pk}, format="json"
    )
    assert ok.status_code == 200, ok.content


@pytest.mark.django_db
def test_token_cannot_create_download_or_list_workspace_exports(owner: Any) -> None:
    token_client = _bearer(owner)
    _refused(token_client.post("/api/v1/workspace/export/"))
    _refused(token_client.get("/api/v1/workspace/export/"))
    _refused(token_client.get(f"/api/v1/workspace/export/{uuid.uuid4()}/"))
    _refused(token_client.get(f"/api/v1/workspace/export/{uuid.uuid4()}/download/"))
    # A session still reaches the list (not refused by the guard).
    assert _session(owner).get("/api/v1/workspace/export/").status_code == 200


@pytest.mark.django_db
def test_token_cannot_mint_an_invite_but_can_still_read_the_list(owner: Any) -> None:
    token_client = _bearer(owner)
    body = {"email": "new@example.com", "role": WorkspaceRole.MEMBER}
    _refused(token_client.post("/api/v1/workspace/invites/", body, format="json"))
    assert token_client.get("/api/v1/workspace/invites/").status_code == 200
    assert _session(owner).post("/api/v1/workspace/invites/", body, format="json").status_code in (
        200,
        201,
    )


@pytest.mark.django_db
def test_token_cannot_change_or_remove_a_member(owner: Any, member: Any) -> None:
    url = f"/api/v1/workspace/members/{member.pk}/"
    token_client = _bearer(owner)
    _refused(token_client.patch(url, {"role": WorkspaceRole.ADMIN}, format="json"))
    _refused(token_client.delete(url))
    assert WorkspaceMembership.objects.get(user=member).role == WorkspaceRole.MEMBER
    ok = _session(owner).patch(url, {"role": WorkspaceRole.ADMIN}, format="json")
    assert ok.status_code == 200, ok.content


@pytest.mark.django_db
def test_token_cannot_manage_groups_but_can_read_them(owner: Any, member: Any) -> None:
    token_client = _bearer(owner)
    _refused(token_client.post("/api/v1/workspace/groups/", {"name": "G"}, format="json"))
    assert token_client.get("/api/v1/workspace/groups/").status_code == 200
    created = _session(owner).post("/api/v1/workspace/groups/", {"name": "G"}, format="json")
    assert created.status_code == 201, created.content
    gid = created.data["id"]
    _refused(
        token_client.post(
            f"/api/v1/workspace/groups/{gid}/members/", {"user_id": member.pk}, format="json"
        )
    )
    _refused(token_client.patch(f"/api/v1/workspace/groups/{gid}/", {"name": "H"}, format="json"))
    _refused(token_client.delete(f"/api/v1/workspace/groups/{gid}/"))
    _refused(
        token_client.post(
            f"/api/v1/workspace/groups/{gid}/projects/",
            {"project_id": str(uuid.uuid4()), "role": 200},
            format="json",
        )
    )


@pytest.mark.django_db
def test_token_cannot_grant_a_project_membership(owner: Any, member: Any) -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    url = f"/api/v1/projects/{project.pk}/members/"
    body = {"user": member.pk, "role": Role.MEMBER}
    _refused(_bearer(owner).post(url, body, format="json"))
    assert not ProjectMembership.objects.filter(project=project, user=member).exists()
    ok = _session(owner).post(url, body, format="json")
    assert ok.status_code == 201, ok.content
    pm = ProjectMembership.objects.get(project=project, user=member)
    _refused(_bearer(owner).patch(f"{url}{pm.pk}/", {"role": Role.ADMIN}, format="json"))
