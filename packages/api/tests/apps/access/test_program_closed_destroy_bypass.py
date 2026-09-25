"""#4014 — IsProgramNotClosed's destroy bypass is scoped to ProgramViewSet.

Before the fix the bypass matched the action *name* ``destroy``, which every
ModelViewSet mints, so nested program resources were deletable from a closed program.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.permissions import IsProgramNotClosed
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    BacklogItem,
    CeremonyCadenceType,
    CeremonyTemplate,
    Methodology,
    Program,
)

User = get_user_model()


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner4014", password="pw")


@pytest.fixture
def program(owner: object) -> Program:
    return create_program(
        name="Closed soon", description="", methodology=Methodology.HYBRID, created_by=owner
    )


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _close(program: Program) -> None:
    program.is_closed = True
    program.save(update_fields=["is_closed"])


@pytest.mark.django_db
def test_bypass_is_scoped_to_the_program_viewset() -> None:
    from trueppm_api.apps.projects.backlog_views import BacklogItemViewSet
    from trueppm_api.apps.projects.program_views import ProgramViewSet

    other = BacklogItemViewSet()
    for action in sorted(IsProgramNotClosed._CLOSE_BYPASS_ACTIONS):
        other.action = action
        assert not IsProgramNotClosed._bypasses_close_check(other)  # type: ignore[arg-type]
        lifecycle = ProgramViewSet()
        lifecycle.action = action
        assert IsProgramNotClosed._bypasses_close_check(lifecycle)  # type: ignore[arg-type]
    lifecycle.action = "partial_update"
    assert not IsProgramNotClosed._bypasses_close_check(lifecycle)  # type: ignore[arg-type]


@pytest.mark.django_db
def test_backlog_item_destroy_blocked_on_closed_program(program: Program, owner: object) -> None:
    item = BacklogItem.objects.create(program=program, title="x", created_by=owner)
    _close(program)
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/backlog-items/{item.pk}/")
    assert resp.status_code == 403
    item.refresh_from_db()
    assert item.is_deleted is False


@pytest.mark.django_db
def test_ceremony_template_destroy_blocked_on_closed_program(
    program: Program, owner: object
) -> None:
    row = CeremonyTemplate.objects.create(
        program=program, name="Sync", cadence_type=CeremonyCadenceType.ON_MILESTONE
    )
    _close(program)
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/ceremonies/{row.pk}/")
    assert resp.status_code == 403
    assert CeremonyTemplate.objects.filter(pk=row.pk).exists()


@pytest.mark.django_db
def test_program_membership_destroy_blocked_on_closed_program(
    program: Program, owner: object
) -> None:
    peer = User.objects.create_user(username="peer4014", password="pw")
    m = ProgramMembership.objects.create(program=program, user=peer, role=Role.MEMBER)
    _close(program)
    resp = _client(owner).delete(f"/api/v1/programs/{program.pk}/members/{m.pk}/")
    assert resp.status_code == 403
    m.refresh_from_db()
    assert m.is_deleted is False


@pytest.mark.django_db
def test_reopen_close_and_destroy_of_the_program_itself_still_work(
    program: Program, owner: object
) -> None:
    c = _client(owner)
    assert c.post(f"/api/v1/programs/{program.pk}/close/").status_code in (200, 202, 204)
    program.refresh_from_db()
    assert program.is_closed is True
    assert c.post(f"/api/v1/programs/{program.pk}/reopen/").status_code in (200, 202, 204)
    program.refresh_from_db()
    assert program.is_closed is False
    _close(program)
    assert c.delete(f"/api/v1/programs/{program.pk}/").status_code == 204
