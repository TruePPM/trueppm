"""Readers of ``ProgramMembership`` must not treat a row on a soft-deleted program as live.

Soft-deleting a program leaves its memberships live (offline sync needs them to
deliver the program tombstone), so each reader has to floor on the program itself.
"""

from __future__ import annotations

import secrets
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.services import _has_any_membership
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import ApiToken, Program, Project
from trueppm_api.apps.projects.services import soft_delete_program_subtree
from trueppm_api.apps.webhooks.dispatch import (
    _drop_program_webhooks_without_live_program_admin_owner,
)
from trueppm_api.apps.webhooks.models import Webhook

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def member() -> object:
    return User.objects.create_user(username="former-member", password="pw")


@pytest.fixture
def program(member: object) -> Program:
    program = Program.objects.create(name="Doomed")
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    return program


def test_has_any_membership_ignores_a_deleted_program(member: object, program: Program) -> None:
    assert _has_any_membership(member) is True  # control
    program.soft_delete()
    assert _has_any_membership(member) is False


def test_calendar_describer_withholds_a_deleted_programs_name(
    member: object, program: Program
) -> None:
    from trueppm_api.apps.projects.views import _calendar_reference_describer

    assert _calendar_reference_describer(member)(program).get("name") == program.name  # control
    program.soft_delete()
    program.refresh_from_db()
    assert _calendar_reference_describer(member)(program) == {
        "type": "program",
        "id": str(program.pk),
    }


def test_program_role_lookup_is_none_once_the_program_is_deleted(
    member: object, program: Program
) -> None:
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.access.permissions import _program_membership_role

    def role() -> int | None:
        request = APIRequestFactory().get("/")
        request.user = member
        return _program_membership_role(request, program.pk)  # type: ignore[arg-type]

    assert role() == Role.MEMBER  # control
    program.soft_delete()
    assert role() is None


def _program_token_world() -> tuple[object, Program, Project, str]:
    """A program token plus a project that stays live inside a deleted program.

    A project trashed *before* its program is deleted keeps its ``program`` link
    (only live children are detached), and restoring it makes it live again under
    the deleted program — the only way a token can still reach a program tombstone.
    """
    user = User.objects.create_user(username="minter", password="pw")
    program = Program.objects.create(name="Tokened")
    ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
    project = Project.objects.create(
        name="Inside", start_date=date(2026, 1, 5), code="INSIDE", program=program
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        program=program,
        name="t",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=user,
    )
    return user, program, project, raw


def _bearer(raw: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _trash_delete_program_then_restore(user: object, program: Program, project: Project) -> None:
    project.soft_delete()
    soft_delete_program_subtree(program, actor=user)
    restorer = APIClient()
    restorer.force_authenticate(user=user)
    assert restorer.post(f"/api/v1/projects/{project.pk}/restore/").status_code in (200, 204)
    project.refresh_from_db()
    assert project.is_deleted is False
    assert project.program_id == program.pk  # the precondition this class of bug needs


def test_program_token_resolve_is_empty_once_its_program_is_deleted() -> None:
    user, program, project, raw = _program_token_world()
    params = {"kind": "project", "ref": "INSIDE"}
    assert _bearer(raw).get("/api/v1/resolve/", params).status_code == 200  # control

    _trash_delete_program_then_restore(user, program, project)

    assert _bearer(raw).get("/api/v1/resolve/", params).status_code == 404


def test_program_token_write_is_refused_once_its_program_is_deleted() -> None:
    user, program, project, raw = _program_token_world()
    body = {"source": "jira", "external_id": "P-1", "name": "w"}
    url = f"/api/v1/projects/{project.pk}/task-sync/"
    assert _bearer(raw).post(url, body, format="json").status_code == 201  # control

    _trash_delete_program_then_restore(user, program, project)

    assert _bearer(raw).post(url, {**body, "external_id": "P-2"}, format="json").status_code == 401


def test_program_webhook_dispatch_drops_the_registrant_of_a_deleted_program(
    member: object, program: Program
) -> None:
    ProgramMembership.objects.filter(program=program, user=member).update(role=Role.ADMIN)
    hook = Webhook.objects.create(
        program=program,
        url="https://example.com/hook",
        secret="s",
        events=["task.created"],
        created_by=member,
    )
    kept = _drop_program_webhooks_without_live_program_admin_owner([hook], program.pk)
    assert kept == [hook]  # control

    program.soft_delete()

    assert _drop_program_webhooks_without_live_program_admin_owner([hook], program.pk) == []
