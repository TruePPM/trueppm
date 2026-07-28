"""The ``Role`` ordinal contract (ADR-0072 + Amendment 1, #2489).

The ordinals are a public API surface — they ship in membership payloads, invite
responses, and MCP reads — and they are also the substrate every ``role >= Role.X``
permission gate compares against. A silent drift in either the values or the band
spacing changes who can write, so the contract is pinned here rather than left to
the enum definition alone.

These assertions deliberately name the literal integers. That is the one place in
the codebase where doing so is correct: everywhere else must use the symbolic name
(the enum docstring says so), which is exactly why the literals need a test that
would fail if someone changed them without meaning to.
"""

from __future__ import annotations

from itertools import pairwise

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Project

User = get_user_model()

LADDER = [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER]


def test_ordinals_are_the_five_documented_values() -> None:
    assert Role.VIEWER == 1
    assert Role.MEMBER == 100
    assert Role.SCHEDULER == 200
    assert Role.ADMIN == 300
    assert Role.OWNER == 400


def test_ordinals_strictly_increase() -> None:
    assert sorted(LADDER) == LADDER
    assert len(set(LADDER)) == len(LADDER)


def test_each_band_leaves_at_least_98_free_slots() -> None:
    """The gaps are reserved Enterprise slots, not arbitrary numbering.

    Viewer→Member is the narrow band at 98 free ordinals because VIEWER sits at 1
    rather than 0; every other band has 99. An Auditor (read-augmented, above
    Viewer, below Member) registers at any ordinal in 2–99.
    """
    for lower, upper in pairwise(LADDER):
        free_slots = upper - lower - 1
        assert free_slots >= 98, f"band {lower}-{upper} has only {free_slots} free slots"


def test_zero_is_not_a_role() -> None:
    """``0`` is permanently unassigned (#2489).

    It is not a "no membership" sentinel — that is ``None``, a distinct type — and no
    custom role may claim it. Keeping it empty is what makes every ordinal truthy,
    which is what stops a JavaScript consumer's ``role || DEFAULT`` from reading a
    Viewer as absent and silently promoting them.
    """
    with pytest.raises(ValueError):
        Role(0)


def test_every_ordinal_is_truthy() -> None:
    """The invariant that the falsy-zero class of bug depends on. See #2489."""
    assert all(bool(role.value) for role in Role)


@pytest.mark.django_db
def test_a_viewer_membership_resolves_as_viewer_not_as_absent() -> None:
    """End-to-end: a stored Viewer round-trips as a *role*, never as "no role".

    This is the regression the renumber exists to make structurally impossible. The
    role reaches consumers as an integer; absence reaches them as ``None``. Asserting
    both halves keeps the two states distinguishable at the source.
    """
    user = User.objects.create_user(username="viewer", email="viewer@example.com")
    stranger = User.objects.create_user(username="stranger", email="stranger@example.com")
    project = Project.objects.create(name="Ordinal Contract", start_date="2026-01-01")
    ProjectMembership.objects.create(project=project, user=user, role=Role.VIEWER)

    stored = ProjectMembership.objects.get(project=project, user=user).role
    assert stored == Role.VIEWER
    assert stored is not None
    assert bool(stored) is True

    absent = ProjectMembership.objects.filter(project=project, user=stranger).first()
    assert absent is None


@pytest.mark.django_db
def test_write_gates_exclude_viewer_and_the_read_augmented_band() -> None:
    """``role >= Role.MEMBER`` is the write threshold — the band contract in action.

    An Enterprise custom role in the 2–99 band (the Auditor example) must stay on the
    read-only side of every Member-gated write, purely by arithmetic and without the
    OSS gate knowing the role exists.
    """
    auditor_ordinal = 50  # any value in the reserved 2–99 read-augmented band

    assert Role.VIEWER < Role.MEMBER
    assert auditor_ordinal < Role.MEMBER  # the Auditor stays read-only...
    assert auditor_ordinal > Role.VIEWER  # ...while outranking a plain Viewer
    # And the band is real space, not a boundary the Auditor has to share.
    assert Role.VIEWER + 1 <= auditor_ordinal <= Role.MEMBER - 1
