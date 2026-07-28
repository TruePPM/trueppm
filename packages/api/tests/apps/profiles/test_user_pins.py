"""Per-user pins on projects and programs (#2390, ADR-0627).

The privacy contract is the load-bearing part of this feature, so it gets more
coverage than the CRUD: `test_no_cross_user_pin_leak` is named as a release gate
in ADR-0627 §D5, and the description tests pin the OpenAPI wording that keeps an
API consumer from carrying over the *shared* meaning `pinned` has on notes and
attachments.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db.utils import IntegrityError
from django.test import override_settings
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles.models import UserPin
from trueppm_api.apps.profiles.services import PinLimitReached, set_pin
from trueppm_api.apps.projects.models import Calendar, Program, Project

User = get_user_model()

PINNED_URL = "/api/v1/auth/me/pinned/"


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(db):
    return Program.objects.create(name="Apollo", code="APOL")


@pytest.fixture
def project(calendar, program):
    return Project.objects.create(
        name="Migration", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )


@pytest.fixture
def member(project):
    user = User.objects.create_user(username="pinner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    return user


@pytest.fixture
def other_member(project):
    user = User.objects.create_user(username="colleague", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


def _pin_url(project_id: str) -> str:
    return f"/api/v1/projects/{project_id}/pin/"


def _program_pin_url(program_id: str) -> str:
    return f"/api/v1/programs/{program_id}/pin/"


@pytest.fixture
def program_member(program):
    from trueppm_api.apps.access.models import ProgramMembership

    user = User.objects.create_user(username="program-pinner", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    return user


# ---------------------------------------------------------------------------
# Privacy — the reason this feature is shaped the way it is
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_no_cross_user_pin_leak(member, other_member, project):
    """Release gate (ADR-0627 §D5): a pin is invisible to everyone but its owner.

    `other_member` is an ADMIN on the same project — the highest-privilege role
    that could plausibly expect to see it — and still sees `is_pinned: false` and
    an empty `/me/pinned/`. If this test ever fails, a per-user preference has
    become an engagement metric.
    """
    assert _client(member).post(_pin_url(str(project.pk))).status_code == 200

    resp = _client(other_member).get(f"/api/v1/projects/{project.pk}/")
    assert resp.status_code == 200
    assert resp.data["is_pinned"] is False

    assert _client(other_member).get(PINNED_URL).data == []

    # And nothing anywhere reports who pinned it.
    body = str(resp.data)
    assert "pinner" not in body
    assert "pinned_by" not in body
    assert "pin_count" not in body


@pytest.mark.django_db
def test_pinned_at_never_appears_on_a_shared_payload(member, project):
    """`pinned_at` is the recency signal that would make "hasn't pinned it in
    weeks" expressible, so it is confined to the owner's own collection."""
    _client(member).post(_pin_url(str(project.pk)))

    detail = _client(member).get(f"/api/v1/projects/{project.pk}/")
    assert "is_pinned" in detail.data
    assert "pinned_at" not in detail.data

    # It IS present on the self-scoped collection.
    assert "pinned_at" in _client(member).get(PINNED_URL).data[0]


@pytest.mark.django_db
def test_pinned_requires_auth():
    assert APIClient().get(PINNED_URL).status_code == 401


# ---------------------------------------------------------------------------
# Round trip
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pin_then_unpin_a_project(member, project):
    c = _client(member)
    assert c.post(_pin_url(str(project.pk))).status_code == 200
    assert c.get(f"/api/v1/projects/{project.pk}/").data["is_pinned"] is True

    unpinned = c.delete(_pin_url(str(project.pk)))
    assert unpinned.status_code == 204
    assert c.get(f"/api/v1/projects/{project.pk}/").data["is_pinned"] is False


@pytest.mark.django_db
def test_pin_is_idempotent_in_both_directions(member, project):
    """Two of the user's own tabs racing must not surface as an error."""
    c = _client(member)
    assert c.post(_pin_url(str(project.pk))).status_code == 200
    assert c.post(_pin_url(str(project.pk))).status_code == 200
    assert UserPin.objects.filter(user=member, project=project).count() == 1

    first_unpin = c.delete(_pin_url(str(project.pk)))
    assert first_unpin.status_code == 204
    # Unpinning something already unpinned is a 204, not a 404.
    repeat_unpin = c.delete(_pin_url(str(project.pk)))
    assert repeat_unpin.status_code == 204


@pytest.mark.django_db
def test_viewer_may_pin(project, calendar):
    """A pin grants nothing and reveals nothing, so read access is enough."""
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    assert _client(viewer).post(_pin_url(str(project.pk))).status_code == 200


@pytest.mark.django_db
def test_outsider_cannot_pin(project):
    outsider = User.objects.create_user(username="outsider", password="pw")
    assert _client(outsider).post(_pin_url(str(project.pk))).status_code in (403, 404)


@pytest.mark.django_db
def test_me_pinned_merges_projects_and_programs_newest_first(member, project, program):
    from trueppm_api.apps.access.models import ProgramMembership

    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    c = _client(member)
    c.post(_pin_url(str(project.pk)))
    c.post(f"/api/v1/programs/{program.pk}/pin/")

    items = c.get(PINNED_URL).data
    assert len(items) == 2
    # Most recently pinned first.
    assert items[0]["kind"] == "program"
    assert items[1]["kind"] == "project"
    # A pinned project carries its parent program for the rail breadcrumb.
    assert items[1]["program_name"] == "Apollo"
    # A pinned program carries its code and no parent.
    assert items[0]["code"] == "APOL"
    assert items[0]["program_id"] is None


@pytest.mark.django_db
def test_pin_then_unpin_a_program(program_member, program):
    """The program endpoint is a separate action from the project one, so its
    DELETE branch needs its own exercise — a shared helper underneath does not
    make the two views the same code path."""
    c = _client(program_member)
    assert c.post(_program_pin_url(str(program.pk))).status_code == 200
    assert UserPin.objects.filter(user=program_member, program=program).count() == 1

    first_unpin = c.delete(_program_pin_url(str(program.pk)))
    assert first_unpin.status_code == 204
    assert UserPin.objects.filter(user=program_member, program=program).count() == 0
    # Unpinning something already unpinned is a 204, not a 404.
    repeat_unpin = c.delete(_program_pin_url(str(program.pk)))
    assert repeat_unpin.status_code == 204


# ---------------------------------------------------------------------------
# Cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_USER_PINS=1)
def test_pin_over_cap_returns_machine_readable_code(member, project, calendar, program):
    second = Project.objects.create(
        name="Second", start_date=date(2026, 1, 1), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=second, user=member, role=Role.MEMBER)
    c = _client(member)
    assert c.post(_pin_url(str(project.pk))).status_code == 200

    resp = c.post(_pin_url(str(second.pk)))
    assert resp.status_code == 400
    # The client must not have to string-match a human sentence to know which
    # limit was hit — the copy and the locale can both change.
    assert resp.data["code"] == "pin_limit_reached"


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_USER_PINS=1)
def test_program_pin_over_cap_returns_machine_readable_code(program_member, program):
    from trueppm_api.apps.access.models import ProgramMembership

    second = Program.objects.create(name="Gemini", code="GEM")
    ProgramMembership.objects.create(program=second, user=program_member, role=Role.MEMBER)
    c = _client(program_member)
    assert c.post(_program_pin_url(str(program.pk))).status_code == 200

    resp = c.post(_program_pin_url(str(second.pk)))
    assert resp.status_code == 400
    assert resp.data["code"] == "pin_limit_reached"
    assert "1 pinned items" in resp.data["detail"]


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_USER_PINS=3)
def test_pin_cap_detail_names_the_configured_limit(member, project, calendar, program):
    """The 400 copy names the operator's cap, and is the view's copy, not the
    service exception's string form (#2501).

    ``PinLimitReached`` carries ``.limit`` so a deployment that raised
    ``TRUEPPM_MAX_USER_PINS`` does not tell its users a stale number.
    """
    c = _client(member)
    extra = [project]
    for i in range(3):
        p = Project.objects.create(
            name=f"Filler {i}", start_date=date(2026, 1, 1), calendar=calendar, program=program
        )
        ProjectMembership.objects.create(project=p, user=member, role=Role.MEMBER)
        extra.append(p)
    for p in extra[:3]:
        assert c.post(_pin_url(str(p.pk))).status_code == 200

    resp = c.post(_pin_url(str(extra[3].pk)))
    assert resp.status_code == 400
    assert "3 pinned items" in resp.data["detail"]
    assert "Unpin one" in resp.data["detail"]


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_USER_PINS=1)
def test_at_cap_a_user_can_still_unpin_and_repin(member, project):
    """The cap is checked only when adding a row that does not already exist."""
    c = _client(member)
    assert c.post(_pin_url(str(project.pk))).status_code == 200
    # Already pinned — a repeat must not trip the cap.
    assert c.post(_pin_url(str(project.pk))).status_code == 200
    unpinned = c.delete(_pin_url(str(project.pk)))
    assert unpinned.status_code == 204
    assert c.post(_pin_url(str(project.pk))).status_code == 200


# ---------------------------------------------------------------------------
# Model invariants
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pin_requires_exactly_one_target(member, project, program):
    with pytest.raises(IntegrityError):
        UserPin.objects.create(user=member, project=project, program=program)


@pytest.mark.django_db
def test_pin_requires_at_least_one_target(member):
    with pytest.raises(IntegrityError):
        UserPin.objects.create(user=member)


@pytest.mark.django_db
def test_set_pin_rejects_ambiguous_call(member, project, program):
    with pytest.raises(ValueError, match="exactly one"):
        set_pin(member, project=project, program=program, pinned=True)


@pytest.mark.django_db
@override_settings(TRUEPPM_MAX_USER_PINS=0)
def test_set_pin_raises_pin_limit_reached(member, project):
    with pytest.raises(PinLimitReached):
        set_pin(member, project=project, pinned=True)


@pytest.mark.django_db
def test_unpin_is_a_hard_delete(member, project):
    """No tombstone — and therefore no unpin history to mine (ADR-0627 §D3)."""
    set_pin(member, project=project, pinned=True)
    set_pin(member, project=project, pinned=False)
    assert UserPin.objects.filter(user=member).count() == 0


# ---------------------------------------------------------------------------
# The OpenAPI description is the mitigation for the `pinned` name collision
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_pin_description_is_published():
    """ADR-0627 §D1.1: `pinned` means the OPPOSITE thing on notes/attachments.

    The endpoint description is the only place an API or MCP consumer is told
    which meaning applies, so a refactor must not silently drop it.
    """
    from trueppm_api.apps.projects.views import PIN_ENDPOINT_DESCRIPTION

    text = PIN_ENDPOINT_DESCRIPTION.lower()
    assert "requesting user only" in text
    assert "private" in text
    assert "idempotent" in text
    # The contrast with the shared meaning is the point of the paragraph.
    assert "tasknote.pinned" in text
    assert "shared" in text
