"""Tests for the exporter's email redaction invariant (#3627).

`GET /api/v1/projects/{id}/export/` and its program counterpart never pass
through `ResourceSerializer`, so they saw none of the #891 org-wide address
harvest control the serializer enforces. Both routes are gated only at
project/program Admin+ (`IsProjectAdmin` / `IsProgramAdmin`) which is
self-grantable by creating a throwaway project, so any account could reach the
whole resource catalog's and every project member's email in ~3 requests.

The chosen invariant (see the #3569 amendment to docs/adr/0034 and this issue):
`Resource.email` and account `email` are workspace-Admin-only content,
independent of who can reach the export action at all. The exporter now
withholds both unless the requesting user holds workspace Admin+ — the
endpoint-level gate is deliberately left alone (portability for a project's own
Admin is not the bug; the harvest is).
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.projects.seed import export_program, export_project, import_seed
from trueppm_api.apps.workspace.models import Workspace, WorkspaceMembership, WorkspaceRole

from .test_importer import _seed

pytestmark = pytest.mark.django_db

User = get_user_model()


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_workspace_admin(user: Any) -> None:
    ws = Workspace.objects.first() or Workspace.objects.create()
    WorkspaceMembership.objects.create(workspace=ws, user=user, role=WorkspaceRole.ADMIN)


@pytest.fixture
def owner() -> Any:
    # `import_seed(owner=...)` grants OWNER on every imported project (self-
    # grantable in production via `POST /api/v1/projects/`; created directly
    # here since the exploit chain itself is not what this file is testing).
    # No WorkspaceMembership row -> implicit workspace MEMBER, below ADMIN.
    return User.objects.create_user(username="seed-owner", email="owner@example.com")


@pytest.fixture
def program(owner: Any) -> Program:
    return import_seed(_seed(), owner=owner, create_users=True)


@pytest.fixture
def project(program: Program) -> Project:
    return program.projects.get(name="Platform Core")


def _resource_emails(doc: dict[str, Any]) -> list[str]:
    return [r.get("email") for r in doc.get("resources", [])]


def _account_emails(doc: dict[str, Any]) -> list[str]:
    return [a.get("email") for a in doc.get("accounts", [])]


# ---------------------------------------------------------------------------
# Exporter unit tests
# ---------------------------------------------------------------------------


def test_no_requesting_user_kwarg_is_trusted(program: Program) -> None:
    """Omitting `requesting_user` (the CLI / internal-caller contract) stays unredacted."""
    doc = export_program(program)
    assert "alex@example.com" in _resource_emails(doc)
    assert "alex@example.com" in _account_emails(doc)


def test_explicit_none_requesting_user_is_redacted(program: Program) -> None:
    """A literal `None` (an async job whose `requested_by` went NULL) is NOT trusted.

    Distinct from the omitted-kwarg case above: `_NO_HTTP_CALLER` (the default)
    means "no HTTP request in play at all"; `None` means "there was a request
    lineage and its user is gone" and must not silently upgrade to full access.
    """
    doc = export_program(program, requesting_user=None)
    assert all(e is None for e in _resource_emails(doc))
    assert all(e is None for e in _account_emails(doc))


def test_project_owner_without_workspace_admin_is_redacted(project: Project, owner: Any) -> None:
    doc = export_project(project, requesting_user=owner)
    assert all(e is None for e in _resource_emails(doc))
    assert all(e is None for e in _account_emails(doc))


def test_workspace_admin_sees_email(project: Project, owner: Any) -> None:
    _make_workspace_admin(owner)
    doc = export_project(project, requesting_user=owner)
    assert "alex@example.com" in _resource_emails(doc)
    assert "alex@example.com" in _account_emails(doc)


def test_superuser_with_no_membership_row_sees_email(project: Project) -> None:
    """Implicit workspace OWNER bootstrap (no explicit row) also passes (#3569 amendment)."""
    su = User.objects.create_superuser(username="root", email="root@example.com", password="pw")
    doc = export_project(project, requesting_user=su)
    assert "alex@example.com" in _resource_emails(doc)


def test_deactivated_workspace_admin_is_redacted(project: Project, owner: Any) -> None:
    from trueppm_api.apps.workspace.models import MemberStatus

    ws = Workspace.objects.first() or Workspace.objects.create()
    WorkspaceMembership.objects.create(
        workspace=ws, user=owner, role=WorkspaceRole.ADMIN, status=MemberStatus.DEACTIVATED
    )
    doc = export_project(project, requesting_user=owner)
    assert all(e is None for e in _resource_emails(doc))


# ---------------------------------------------------------------------------
# API-level: the actual exploit closure
# ---------------------------------------------------------------------------


def test_project_export_endpoint_withholds_email_from_self_granted_owner(
    project: Project, owner: Any
) -> None:
    """The reachable-in-3-requests chain from the issue: Owner reaches the endpoint
    (IsProjectAdmin is satisfied), but the response no longer carries email."""
    resp = _client(owner).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 200, resp.content
    import json

    body = json.loads(b"".join(resp.streaming_content) if resp.streaming else resp.content)
    assert all(e is None for e in _resource_emails(body))
    assert all(e is None for e in _account_emails(body))


def test_project_export_endpoint_includes_email_for_workspace_admin(
    project: Project, owner: Any
) -> None:
    _make_workspace_admin(owner)
    resp = _client(owner).get(f"/api/v1/projects/{project.pk}/export/")
    assert resp.status_code == 200, resp.content
    import json

    body = json.loads(b"".join(resp.streaming_content) if resp.streaming else resp.content)
    assert "alex@example.com" in _resource_emails(body)
    assert "alex@example.com" in _account_emails(body)


def test_program_export_endpoint_withholds_email_from_self_granted_owner(
    program: Program, owner: Any
) -> None:
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/export/")
    assert resp.status_code == 200, resp.content
    import json

    body = json.loads(b"".join(resp.streaming_content) if resp.streaming else resp.content)
    assert all(e is None for e in _resource_emails(body))
    assert all(e is None for e in _account_emails(body))


def test_program_export_endpoint_includes_email_for_workspace_admin(
    program: Program, owner: Any
) -> None:
    _make_workspace_admin(owner)
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/export/")
    assert resp.status_code == 200, resp.content
    import json

    body = json.loads(b"".join(resp.streaming_content) if resp.streaming else resp.content)
    assert "alex@example.com" in _resource_emails(body)
    assert "alex@example.com" in _account_emails(body)


# ---------------------------------------------------------------------------
# Round-trip: a redacted export must still re-import (issue constraint)
# ---------------------------------------------------------------------------


def test_redacted_export_round_trips_through_import(project: Project, owner: Any) -> None:
    """Account identity resolves by `username` and generic-import Resources are
    always freshly created (never matched by email, #1004) — so a redacted
    export must re-import cleanly with no email available."""
    doc = export_project(project, requesting_user=owner)  # redacted: owner, no workspace role
    assert all(e is None for e in _resource_emails(doc))

    new_program = import_seed(doc, owner=owner, create_users=False)
    new_project = new_program.projects.get()
    assert new_project.name == project.name
    # Tasks materialized despite the withheld resource/account email.
    assert new_project.tasks.exists()

    from trueppm_api.apps.resources.models import Resource

    new_resource = Resource.objects.get(
        name="Alex Rivera", project_memberships__project=new_project
    )
    # The redacted seed never carried an email; the re-created resource reflects that.
    assert new_resource.email == ""


def test_redacted_program_export_round_trips_via_api(program: Program, owner: Any) -> None:
    """End-to-end: the sync GET response body (as a self-granted Owner would
    receive it) re-imports through POST /api/v1/programs/import/."""
    import json

    from django.core.files.uploadedfile import SimpleUploadedFile

    original_project_count = program.projects.count()
    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/export/")
    assert resp.status_code == 200, resp.content
    body = b"".join(resp.streaming_content) if resp.streaming else resp.content
    assert all(e is None for e in _resource_emails(json.loads(body)))

    # The seed's program code ("atlas") collides with the source program, which
    # `owner` already owns, so ADR-0726 requires explicit replace consent.
    upload = SimpleUploadedFile("program.json", body, content_type="application/json")
    import_resp = _client(owner).post(
        "/api/v1/programs/import/",
        data={"file": upload, "replace": "true"},
        format="multipart",
    )
    assert import_resp.status_code == 202, import_resp.content

    from trueppm_api.apps.projects.tasks import run_program_import

    run_program_import.apply(args=[str(import_resp.data["import_request_id"])], throw=True)
    new_program = Program.objects.get(pk=import_resp.data["program_id"])
    assert new_program.pk != program.pk
    assert new_program.projects.count() == original_project_count


def test_project_membership_role_does_not_grant_email_visibility(
    project: Project, owner: Any
) -> None:
    """A second account made project ADMIN (the self-grantable role the exploit
    chain relies on) still does not see email — only a workspace role does."""
    escalated = User.objects.create_user(username="escalated", email="e@example.com")
    ProjectMembership.objects.create(project=project, user=escalated, role=Role.ADMIN)
    doc = export_project(project, requesting_user=escalated)
    assert all(e is None for e in _resource_emails(doc))
