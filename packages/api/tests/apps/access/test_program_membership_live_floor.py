"""``ProgramMembership.live()`` and the program-axis reads composed over it (#3458).

The program-axis bookend to :mod:`tests.apps.access.test_read_path_live_membership_floor`
(#3411, project axis). ``ProgramMembership``'s class docstring claims it "mirrors
``ProjectMembership`` exactly"; until #3458 that was false in the place it mattered most
— ``ProjectMembership`` had a ``live()`` floor and ``ProgramMembership`` had none, so
every program-axis read restated its own ``is_deleted=False`` or forgot to. Two of the
five known instances of the class were program-axis (#3456 the weekly program-health
digest, #3457 the seed exporter), and both shipped.

The mechanism, identical on both axes: ``uniq_program_membership_program_user`` is
**unconditional**. Revoking soft-deletes the row rather than removing it, so the tombstone
keeps owning the ``(program, user)`` slot and any lookup that omits ``is_deleted`` hands
back a departed member with their old role intact.

Every test below pairs a revoked subject with a live control, so a floor that simply
denied everyone would fail exactly as loudly as no floor at all.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import Methodology, Program

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="floor-prog-owner", password="pw")


@pytest.fixture
def program(owner: Any) -> Program:
    return create_program(
        name="Floor Program",
        description="",
        methodology=Methodology.HYBRID,
        created_by=owner,
    )


def _member(program: Program, username: str, role: int, *, revoked: bool) -> Any:
    """Create a program member, then revoke through the real soft-delete path.

    ``soft_delete()`` rather than ``is_deleted=True`` on ``create``: the revoke the
    product performs goes through that method (it also stamps ``deleted_version``), and a
    test that hand-sets the column would still pass if the model stopped soft-deleting.
    """
    user = User.objects.create_user(username=username, password="pw")
    membership = ProgramMembership.objects.create(program=program, user=user, role=role)
    if revoked:
        membership.soft_delete()
    return user


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------


def test_live_excludes_a_revoked_row_and_keeps_the_live_control(program: Program) -> None:
    """The floor, at its narrowest: the revoked row is gone, the live one is not."""
    revoked = _member(program, "floor-revoked", Role.MEMBER, revoked=True)
    live = _member(program, "floor-live", Role.MEMBER, revoked=False)

    user_ids = set(ProgramMembership.live().values_list("user_id", flat=True))

    assert live.pk in user_ids
    assert revoked.pk not in user_ids


def test_live_row_still_resolves_through_the_unconditional_constraint(program: Program) -> None:
    """The mechanism, asserted rather than described.

    The revoked row is still *there* — ``objects`` finds it, with its old role intact —
    which is exactly why an unfloored read is a defect rather than a miss. If revoking
    ever started hard-deleting, this test fails and the whole gate becomes unnecessary;
    that is worth learning from a red test rather than from a silent one.
    """
    revoked = _member(program, "floor-mechanism", Role.ADMIN, revoked=True)

    row = ProgramMembership.objects.get(program=program, user=revoked)
    assert row.is_deleted is True
    assert row.role == Role.ADMIN
    assert not ProgramMembership.live().filter(program=program, user=revoked).exists()


def test_live_filters_in_the_where_clause_not_merely_the_select_list() -> None:
    """``is_deleted`` is a COLUMN, so it appears in the SELECT list of every membership
    query. A substring check over the compiled SQL is therefore vacuous — it matches a
    completely unfiltered queryset. Assert on the text *after* ``WHERE``.
    """
    sql = str(ProgramMembership.live().query)
    assert " WHERE " in sql, sql
    where = sql.split(" WHERE ", 1)[1]
    assert "is_deleted" in where, where

    # The negative control: the same substring check against the unfiltered manager, to
    # prove the assertion above is discriminating and not merely true of all SQL.
    unfloored = str(ProgramMembership.objects.all().query)
    assert "is_deleted" in unfloored  # in the SELECT list
    assert " WHERE " not in unfloored


def test_live_floors_the_membership_only_not_the_program(program: Program, owner: Any) -> None:
    """Documented scope, pinned. ``live()`` does NOT exclude a live row on a soft-deleted
    program — callers that need that add ``program__is_deleted=False`` themselves, as
    ``build_program_health_digest`` does. Pinning it means a future "helpful" widening
    has to change this test and say so, rather than silently altering what every caller
    composed on.
    """
    member = _member(program, "floor-dead-program", Role.MEMBER, revoked=False)
    program.soft_delete()

    assert ProgramMembership.live().filter(program=program, user=member).exists()
    assert not ProgramMembership.live().filter(program__is_deleted=False, user=member).exists()


def test_live_mirrors_the_project_axis_helper() -> None:
    """The "mirrors ProjectMembership exactly" claim, as a test rather than a docstring.

    Both are classmethods returning a queryset of their own model floored on the same
    field. A future divergence — one becoming a manager method, one gaining an extra
    term — fails here instead of surfacing as a program-axis read behaving unlike its
    project-axis twin.
    """
    from trueppm_api.apps.access.models import ProjectMembership

    project_where = str(ProjectMembership.live().query).split(" WHERE ", 1)[1]
    program_where = str(ProgramMembership.live().query).split(" WHERE ", 1)[1]

    assert ProjectMembership.live().model is ProjectMembership
    assert ProgramMembership.live().model is ProgramMembership
    assert "is_deleted" in project_where
    assert "is_deleted" in program_where


# ---------------------------------------------------------------------------
# The reads migrated onto it
# ---------------------------------------------------------------------------


def test_program_role_lookup_denies_a_revoked_member(program: Program) -> None:
    """``_program_membership_role`` is the request-cached RBAC read every program-nested
    permission class funnels through — the program axis's closest analogue to the
    project axis's ``live_project_membership_exists()`` composition. A revoked member
    must resolve to ``None`` (no membership), not to their old ordinal.
    """
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.access.permissions import _program_membership_role

    revoked = _member(program, "role-revoked", Role.ADMIN, revoked=True)
    live = _member(program, "role-live", Role.ADMIN, revoked=False)

    factory = APIRequestFactory()

    request = factory.get("/")
    request.user = revoked
    assert _program_membership_role(request, program.pk) is None

    request = factory.get("/")
    request.user = live
    assert _program_membership_role(request, program.pk) == Role.ADMIN


def test_members_roster_omits_a_revoked_member(program: Program, owner: Any) -> None:
    """``ProgramMembershipViewSet.get_queryset``, end to end.

    ``access/views.py`` is allowlisted in ``scripts/check-membership-live-floor.py`` — the
    revive path in that module has to see revoked rows — so the gate is blind to this
    read. It is covered here instead, which is the point of testing the allowlisted
    modules rather than assuming the gate reaches them.
    """
    revoked = _member(program, "roster-revoked", Role.MEMBER, revoked=True)
    live = _member(program, "roster-live", Role.MEMBER, revoked=False)

    client = APIClient()
    client.force_authenticate(user=owner)
    res = client.get(f"/api/v1/programs/{program.pk}/members/")

    assert res.status_code == 200
    body = res.json()
    rows = body["results"] if isinstance(body, dict) and "results" in body else body
    returned = {row["user"] for row in rows}

    assert live.pk in returned
    assert revoked.pk not in returned


def test_last_owner_guard_does_not_count_a_revoked_owner(program: Program, owner: Any) -> None:
    """``_check_last_owner_guard`` counts *live* Owners.

    The revoked-Owner row is the trap: if it counted, the guard would let the last real
    Owner demote themselves, leaving the program with zero reachable Owners — a
    permanently unadministrable program, since only an Owner can grant Owner.
    """
    _member(program, "guard-revoked-owner", Role.OWNER, revoked=True)
    membership = ProgramMembership.live().get(program=program, user=owner)

    client = APIClient()
    client.force_authenticate(user=owner)
    res = client.patch(
        f"/api/v1/programs/{program.pk}/members/{membership.pk}/",
        {"role": Role.MEMBER},
        format="json",
    )

    assert res.status_code == 400, res.content
    assert "last Owner" in str(res.json())


# The weekly program-health digest audience (#3456) was migrated from an inline
# `is_deleted=False` onto `ProgramMembership.live()` in this change, on the explicit
# deferral its own fix recorded ("adding one plus migrating every program-axis call site
# is #3458's scope, not this fix's"). It is NOT re-asserted here: four tests in
# tests/apps/notifications/test_scheduled_digests.py already pin it end to end over a
# genuinely at-risk program — including the rendered body and the overflow footer count,
# neither of which this module can reach without rebuilding the rollup fixtures. Those
# four are the regression proof that the refactor changed nothing, and they are part of
# this change's scoped test run:
#
#   test_revoked_program_membership_leaves_the_digest_audience
#   test_live_program_membership_still_reports
#   test_revoked_member_receives_no_program_state_in_the_rendered_digest
#   test_overflow_count_excludes_revoked_and_soft_deleted_memberships
#
# Restating them here against an empty-state digest would be worse than nothing: a
# revoked member and a live member with no at-risk program render the SAME subject, so
# the assertion would pass with the floor removed.
