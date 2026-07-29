"""``GET /programs/{id}/mention-reach/`` — the two-arm reach counter (#2529, ADR-0697).

Covers the contract that makes the settings-page strip trustworthy: the counted
internal arm must equal what ``resolve_group_members(..., "program-stakeholders")``
actually fans out to, the counted external arm must equal
``resolve_external_stakeholders``, the two arms are never summed into a total, and
the endpoint is gated at program Admin+.

The distinct-user case is the one that matters most: a person who is a Viewer on two
projects in the program is **one** recipient, and a naive ``.count()`` on membership
rows would over-report — failing in precisely the way #2529 exists to prevent.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.groups import (
    count_program_stakeholder_reach,
    resolve_external_stakeholders,
    resolve_group_members,
)
from trueppm_api.apps.access.models import (
    ExternalStakeholder,
    ProgramMembership,
    ProjectMembership,
    Role,
)
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Methodology, Project

User = get_user_model()


@pytest.fixture
def program(db: object) -> object:
    owner = User.objects.create_user(username="mr_owner", password="pw")
    prog = create_program(
        name="Reach", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    prog._owner = owner  # type: ignore[attr-defined]
    return prog


@pytest.fixture
def proj_a(program: object) -> Project:
    return Project.objects.create(name="A", start_date=date(2026, 1, 1), program=program)


@pytest.fixture
def proj_b(program: object) -> Project:
    return Project.objects.create(name="B", start_date=date(2026, 1, 1), program=program)


@pytest.fixture
def admin_user(program: object) -> object:
    user = User.objects.create_user(username="mr_admin", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
    return user


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: object) -> str:
    return f"/api/v1/programs/{program.id}/mention-reach/"


def _viewer_on(project: Project, username: str) -> object:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)
    return user


# ---------------------------------------------------------------------------
# Counts
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_counts_both_arms_separately(
    program: object, proj_a: Project, proj_b: Project, admin_user: object
) -> None:
    _viewer_on(proj_a, "mr_v1")
    _viewer_on(proj_b, "mr_v2")
    ExternalStakeholder.objects.create(program=program, name="Dana", email="dana@client.com")
    ExternalStakeholder.objects.create(program=program, name="Sam", email="sam@client.com")
    ExternalStakeholder.objects.create(program=program, name="Kit", email="kit@client.com")

    resp = _client(admin_user).get(_url(program))

    assert resp.status_code == 200
    assert resp.data["group_key"] == "program-stakeholders"
    assert resp.data["viewer_member_count"] == 2
    assert resp.data["external_stakeholder_count"] == 3


@pytest.mark.django_db
def test_response_carries_no_total(program: object, proj_a: Project, admin_user: object) -> None:
    """ADR-0697 §1a: a combined number would re-assert the union #1675 removed."""
    _viewer_on(proj_a, "mr_v_total")
    ExternalStakeholder.objects.create(program=program, name="Dana", email="dana@client.com")

    resp = _client(admin_user).get(_url(program))

    assert set(resp.data) == {"group_key", "viewer_member_count", "external_stakeholder_count"}
    assert "total" not in resp.data


@pytest.mark.django_db
def test_viewer_on_two_projects_counts_once(
    program: object, proj_a: Project, proj_b: Project, admin_user: object
) -> None:
    """The resolver returns distinct users; the counter must too."""
    dual = _viewer_on(proj_a, "mr_dual")
    ProjectMembership.objects.create(project=proj_b, user=dual, role=Role.VIEWER)

    resp = _client(admin_user).get(_url(program))

    assert ProjectMembership.objects.filter(user=dual, role=Role.VIEWER).count() == 2
    assert resp.data["viewer_member_count"] == 1


@pytest.mark.django_db
def test_non_viewer_roles_are_excluded(
    program: object, proj_a: Project, admin_user: object
) -> None:
    """Exact Viewer, not the ``role__gte`` floor — otherwise everyone qualifies."""
    for name, role in (
        ("mr_m", Role.MEMBER),
        ("mr_s", Role.SCHEDULER),
        ("mr_a", Role.ADMIN),
        ("mr_o", Role.OWNER),
    ):
        user = User.objects.create_user(username=name, password="pw")
        ProjectMembership.objects.create(project=proj_a, user=user, role=role)

    resp = _client(admin_user).get(_url(program))

    assert resp.data["viewer_member_count"] == 0


@pytest.mark.django_db
def test_soft_deleted_rows_are_excluded(
    program: object, proj_a: Project, proj_b: Project, admin_user: object
) -> None:
    live = _viewer_on(proj_a, "mr_live")
    gone = _viewer_on(proj_a, "mr_gone")
    ProjectMembership.objects.filter(user=gone).update(is_deleted=True)
    # A Viewer on a soft-deleted sibling project is not reachable either.
    _viewer_on(proj_b, "mr_dead_project")
    Project.objects.filter(pk=proj_b.pk).update(is_deleted=True)

    stale = ExternalStakeholder.objects.create(program=program, name="Old", email="old@client.com")
    stale.is_deleted = True
    stale.save(update_fields=["is_deleted"])
    ExternalStakeholder.objects.create(program=program, name="Dana", email="dana@client.com")

    resp = _client(admin_user).get(_url(program))

    assert resp.data["viewer_member_count"] == 1
    assert resp.data["external_stakeholder_count"] == 1
    assert ProjectMembership.objects.get(user=live, is_deleted=False)


@pytest.mark.django_db
def test_empty_program_reaches_nobody(program: object, admin_user: object) -> None:
    resp = _client(admin_user).get(_url(program))

    assert resp.data["viewer_member_count"] == 0
    assert resp.data["external_stakeholder_count"] == 0


# ---------------------------------------------------------------------------
# Contract — the counter and the resolver must never disagree
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_counts_match_the_resolvers(program: object, proj_a: Project, proj_b: Project) -> None:
    """The whole point of the endpoint: the shown number is the fan-out number."""
    dual = _viewer_on(proj_a, "mr_c_dual")
    ProjectMembership.objects.create(project=proj_b, user=dual, role=Role.VIEWER)
    _viewer_on(proj_b, "mr_c_solo")
    member = User.objects.create_user(username="mr_c_member", password="pw")
    ProjectMembership.objects.create(project=proj_a, user=member, role=Role.MEMBER)
    ExternalStakeholder.objects.create(program=program, name="Dana", email="dana@client.com")

    reach = count_program_stakeholder_reach(program.pk)

    assert reach.viewer_member_count == len(
        resolve_group_members(proj_a.pk, "program-stakeholders")
    )
    assert reach.external_stakeholder_count == len(resolve_external_stakeholders(proj_a.pk))


# ---------------------------------------------------------------------------
# RBAC + IDOR
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER])
def test_below_admin_is_forbidden(program: object, role: int) -> None:
    user = User.objects.create_user(username=f"mr_role_{role}", password="pw")
    ProgramMembership.objects.create(program=program, user=user, role=role)

    assert _client(user).get(_url(program)).status_code == 403


@pytest.mark.django_db
def test_owner_is_allowed(program: object) -> None:
    assert _client(program._owner).get(_url(program)).status_code == 200


@pytest.mark.django_db
def test_anonymous_is_rejected(program: object) -> None:
    assert APIClient().get(_url(program)).status_code in (401, 403)


@pytest.mark.django_db
def test_non_member_cannot_read_another_programs_reach(program: object, db: object) -> None:
    """404, not 403 — ``get_queryset`` scopes to the caller's programs, so a
    non-member cannot even confirm the program id exists (no enumeration oracle)."""
    outsider = User.objects.create_user(username="mr_outsider", password="pw")

    assert _client(outsider).get(_url(program)).status_code == 404


@pytest.mark.django_db
def test_write_methods_are_not_routed(program: object, admin_user: object) -> None:
    assert _client(admin_user).post(_url(program), {}).status_code == 405
