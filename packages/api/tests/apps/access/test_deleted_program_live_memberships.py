"""Readers of ``ProgramMembership`` must not treat a row on a soft-deleted program as live.

Soft-deleting a program leaves its memberships live (offline sync needs them to
deliver the program tombstone), so each reader has to floor on the program itself.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.profiles.services import _has_any_membership
from trueppm_api.apps.projects.models import Program

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
