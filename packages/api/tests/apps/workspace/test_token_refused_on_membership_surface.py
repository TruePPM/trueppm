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

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_LEGACY_FULL,
    ApiToken,
    Calendar,
    Methodology,
    Project,
)
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


@pytest.fixture
def project(owner: Any) -> Project:
    proj = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="Std")
    )
    ProjectMembership.objects.create(project=proj, user=owner, role=Role.OWNER)
    return proj


@pytest.fixture
def program(owner: Any) -> Any:
    return create_program(
        name="G", description="", methodology=Methodology.HYBRID, created_by=owner
    )


@pytest.mark.django_db
def test_token_cannot_transfer_project_ownership(owner: Any, member: Any, project: Project) -> None:
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    url = f"/api/v1/projects/{project.pk}/transfer/"
    body = {"new_owner_user_id": member.pk}
    _refused(_bearer(owner).post(url, body, format="json"))
    assert ProjectMembership.objects.get(project=project, user=member).role == Role.MEMBER
    assert ProjectMembership.objects.get(project=project, user=owner).role == Role.OWNER
    ok = _session(owner).post(url, body, format="json")
    assert ok.status_code == 200, ok.content
    assert ProjectMembership.objects.get(project=project, user=member).role == Role.OWNER


@pytest.mark.django_db
def test_token_cannot_transfer_program_sponsorship(owner: Any, member: Any, program: Any) -> None:
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    url = f"/api/v1/programs/{program.pk}/transfer-sponsorship/"
    body = {"new_owner_user_id": member.pk}
    _refused(_bearer(owner).post(url, body, format="json"))
    assert ProgramMembership.objects.get(program=program, user=member).role == Role.MEMBER
    assert ProgramMembership.objects.get(program=program, user=owner).role == Role.OWNER
    ok = _session(owner).post(url, body, format="json")
    assert ok.status_code == 200, ok.content
    assert ProgramMembership.objects.get(program=program, user=member).role == Role.OWNER


@pytest.mark.django_db
def test_token_cannot_grant_or_change_a_program_membership(
    owner: Any, member: Any, program: Any
) -> None:
    url = f"/api/v1/programs/{program.pk}/members/"
    body = {"user": member.pk, "role": Role.MEMBER}
    _refused(_bearer(owner).post(url, body, format="json"))
    assert not ProgramMembership.objects.filter(program=program, user=member).exists()
    ok = _session(owner).post(url, body, format="json")
    assert ok.status_code == 201, ok.content
    pm = ProgramMembership.objects.get(program=program, user=member)
    _refused(_bearer(owner).patch(f"{url}{pm.pk}/", {"role": Role.ADMIN}, format="json"))
    pm.refresh_from_db()
    assert pm.role == Role.MEMBER


@pytest.mark.django_db
def test_token_cannot_delete_resend_or_resend_all_invites(owner: Any) -> None:
    session = _session(owner)
    created = session.post(
        "/api/v1/workspace/invites/",
        {"email": "inv@example.com", "role": WorkspaceRole.MEMBER},
        format="json",
    )
    assert created.status_code in (200, 201), created.content
    invite_id = created.data["id"]
    token_client = _bearer(owner)
    _refused(token_client.post(f"/api/v1/workspace/invites/{invite_id}/resend/"))
    _refused(token_client.post("/api/v1/workspace/invites/resend-all/"))
    _refused(token_client.delete(f"/api/v1/workspace/invites/{invite_id}/"))
    # The invite is still pending: the refusal fired before the view body ran.
    assert session.get("/api/v1/workspace/invites/").data["results"][0]["id"] == invite_id


@pytest.mark.django_db
def test_token_cannot_delete_group_members_or_group_projects(
    owner: Any, member: Any, project: Project
) -> None:
    session = _session(owner)
    gid = session.post("/api/v1/workspace/groups/", {"name": "G"}, format="json").data["id"]
    assert (
        session.post(
            f"/api/v1/workspace/groups/{gid}/members/", {"user": member.pk}, format="json"
        ).status_code
        == 201
    )
    token_client = _bearer(owner)
    _refused(token_client.delete(f"/api/v1/workspace/groups/{gid}/members/{member.pk}/"))
    _refused(token_client.delete(f"/api/v1/workspace/groups/{gid}/projects/{project.pk}/"))
    assert session.delete(f"/api/v1/workspace/groups/{gid}/members/{member.pk}/").status_code == 204


@pytest.mark.django_db
def test_token_can_still_remove_a_project_or_program_member(
    owner: Any, member: Any, project: Project, program: Any
) -> None:
    """Pinned on purpose: removing access is the containment direction (#3847).

    ``destroy`` is excluded from ``token_refused_actions`` so a leaked token's owner can
    still evict and self-remove with it. A future "refuse everything" sweep that breaks
    this should have to change this test and say why.
    """
    pm = ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    resp = _bearer(owner).delete(f"/api/v1/projects/{project.pk}/members/{pm.pk}/")
    assert resp.status_code == 204, resp.content
    assert not ProjectMembership.objects.filter(pk=pm.pk, is_deleted=False).exists()

    gm = ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    resp = _bearer(owner).delete(f"/api/v1/programs/{program.pk}/members/{gm.pk}/")
    assert resp.status_code == 204, resp.content
    assert not ProgramMembership.objects.filter(pk=gm.pk, is_deleted=False).exists()
