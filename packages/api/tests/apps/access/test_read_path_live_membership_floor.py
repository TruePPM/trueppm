"""Read paths must not resolve a revoked ``ProjectMembership`` as live (#3411).

The follow-up to #3386 (!2315), which floored the *write* gates on the facet and role
axes. The same defect sat on three read paths, which that MR scoped out: retro-note
visibility, ``USER`` custom-field validation, and — found by widening the sweep here —
the project overview card's owner name.

The shared mechanism is the unconditional ``uniq_project_membership_project_user``
constraint: revoking access soft-deletes the row rather than removing it, so any
``(project, user)`` lookup that omits ``is_deleted`` hands back a departed member with
their old role intact. Each test below pairs a revoked subject with a live control, so a
floor that simply denied everyone would fail just as loudly as no floor at all.
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework import serializers
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.custom_field_values import validate_custom_field_write
from trueppm_api.apps.projects.models import (
    Calendar,
    CustomFieldType,
    Project,
    ProjectCustomField,
    RetroVisibility,
    Sprint,
    SprintRetro,
    Task,
)
from trueppm_api.apps.projects.services import _retro_summary_block

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Floor Proj", start_date=datetime.date(2026, 1, 1), calendar=calendar
    )


def _member(project: Project, username: str, role: int, *, revoked: bool) -> Any:
    """A user with a membership at ``role``, soft-deleted iff ``revoked``.

    Revocation goes through a save of the existing row rather than a delete, because that
    is what the product does — and it is precisely why the unfloored reads saw the row.
    """
    user = User.objects.create_user(username=username, password="pw")
    membership = ProjectMembership.objects.create(project=project, user=user, role=role)
    if revoked:
        membership.is_deleted = True
        membership.save(update_fields=["is_deleted"])
        # Precondition: the row is still there, still carrying its role. Without this
        # the tests below could pass because the membership vanished entirely, which
        # is not the state the defect lives in.
        assert ProjectMembership.objects.filter(
            project=project, user=user, role=role, is_deleted=True
        ).exists()
    return user


class _Req:
    """Minimal request stand-in — ``_retro_summary_block`` reads only ``.user``."""

    def __init__(self, user: Any) -> None:
        self.user = user


# ---------------------------------------------------------------------------
# The seam itself
# ---------------------------------------------------------------------------


def test_live_excludes_a_revoked_row_and_keeps_a_live_one(project: Project) -> None:
    """``ProjectMembership.live()`` is the one definition the three sites share."""
    revoked = _member(project, "seam-revoked", Role.ADMIN, revoked=True)
    live = _member(project, "seam-live", Role.ADMIN, revoked=False)

    user_ids = set(
        ProjectMembership.live().filter(project=project).values_list("user_id", flat=True)
    )
    assert live.pk in user_ids
    assert revoked.pk not in user_ids
    # The unfloored queryset still sees both — i.e. the floor is doing the work, not
    # a cascade that removed the row behind our back.
    assert ProjectMembership.objects.filter(project=project).count() == 2


# ---------------------------------------------------------------------------
# Site 1 — retro-note visibility (projects/services.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def team_only_retro(project: Project) -> SprintRetro:
    """A retro whose free text is gated at TEAM_ONLY, i.e. MEMBER+ on the project."""
    sprint = Sprint.objects.create(
        project=project,
        name="S1",
        start_date=datetime.date(2026, 1, 1),
        finish_date=datetime.date(2026, 1, 14),
    )
    return SprintRetro.objects.create(
        sprint=sprint,
        notes="what the team said out loud",
        team_visibility=RetroVisibility.TEAM_ONLY,
    )


def test_retro_notes_hidden_from_a_revoked_member(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """A revoked Admin keeps the ADMIN ordinal on their soft-deleted row. Unfloored,
    that ordinal clears the ``>= Role.MEMBER`` arm and shows them the team's free text."""
    revoked = _member(project, "retro-revoked", Role.ADMIN, revoked=True)

    block = _retro_summary_block(team_only_retro.sprint, _Req(revoked))

    assert block is not None
    assert block["has_notes"] is False


def test_retro_notes_still_visible_to_a_live_member(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """The control: the floor must not hide the notes from the team they belong to."""
    live = _member(project, "retro-live", Role.MEMBER, revoked=False)

    block = _retro_summary_block(team_only_retro.sprint, _Req(live))

    assert block is not None
    assert block["has_notes"] is True


def test_retro_counts_stay_visible_to_a_revoked_member(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """ADR-0071 §3 gates only the free text. The floor must not swallow the counts —
    it narrows *who reads notes*, not whether the block renders at all."""
    revoked = _member(project, "retro-counts", Role.ADMIN, revoked=True)

    block = _retro_summary_block(team_only_retro.sprint, _Req(revoked))

    assert block is not None
    assert block["retro_id"] == str(team_only_retro.pk)
    assert block["action_item_count"] == 0


def test_project_visibility_retro_is_unaffected_by_the_floor(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """At PROJECT visibility the role arm is never consulted, so nothing changes."""
    team_only_retro.team_visibility = RetroVisibility.PROJECT
    team_only_retro.save(update_fields=["team_visibility"])
    revoked = _member(project, "retro-proj-vis", Role.VIEWER, revoked=True)

    block = _retro_summary_block(team_only_retro.sprint, _Req(revoked))

    assert block is not None
    assert block["has_notes"] is True


def test_retro_notes_hidden_from_a_user_with_no_membership_at_all(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """Distinguishes "the floor works" from "any absent membership denies".

    Every other case here pairs a revoked row against a live one, so all of them would
    still pass if the role lookup were replaced by something that resolved nobody. This
    one fixes the other end of the range.
    """
    stranger = User.objects.create_user(username="retro-stranger", password="pw")

    block = _retro_summary_block(team_only_retro.sprint, _Req(stranger))

    assert block is not None
    assert block["has_notes"] is False


def test_retro_notes_hidden_from_an_anonymous_caller(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """The unauthenticated branch: no user on the request resolves to no role."""
    block = _retro_summary_block(team_only_retro.sprint, _Req(None))

    assert block is not None
    assert block["has_notes"] is False


def test_retro_notes_hidden_from_a_live_viewer(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """The role arm still denies a live sub-MEMBER role — the floor narrowed *who* is
    resolved, it did not collapse the ``>= Role.MEMBER`` comparison into "is a member"."""
    viewer = _member(project, "retro-live-viewer", Role.VIEWER, revoked=False)

    block = _retro_summary_block(team_only_retro.sprint, _Req(viewer))

    assert block is not None
    assert block["has_notes"] is False


def test_retro_role_is_scoped_to_this_project(
    project: Project, calendar: Calendar, team_only_retro: SprintRetro
) -> None:
    """A live ADMIN on *another* project holds no role here.

    Without this, dropping the project term from the lookup would leave every other
    test in this module green — an unscoped read is equally empty when the subject is
    live nowhere else.
    """
    other = Project.objects.create(
        name="Other", start_date=datetime.date(2026, 1, 1), calendar=calendar
    )
    outsider = _member(other, "retro-elsewhere", Role.ADMIN, revoked=False)

    block = _retro_summary_block(team_only_retro.sprint, _Req(outsider))

    assert block is not None
    assert block["has_notes"] is False


def test_sprint_outcome_endpoint_refuses_a_revoked_member(
    project: Project, team_only_retro: SprintRetro
) -> None:
    """The outer gate that makes the retro fix defense-in-depth rather than a live leak.

    ``SprintViewSet.outcome`` sits behind ``IsProjectMember`` and a membership-scoped
    queryset, both of which already exclude soft-deleted rows — so a revoked caller is
    refused before ``_retro_summary_block`` runs, and the notes were never actually
    exposed over HTTP. That is worth pinning: it is the reason the changelog says
    defense-in-depth, and if ``outcome`` is ever moved off ``ProjectScopedViewSet`` the
    role floor inside the block becomes the only gate and this test goes red first.
    """
    revoked = _member(project, "outcome-revoked", Role.ADMIN, revoked=True)

    client = APIClient()
    client.force_authenticate(user=revoked)
    res = client.get(f"/api/v1/sprints/{team_only_retro.sprint.pk}/outcome/")

    assert res.status_code in (403, 404), (
        f"expected the outer membership gate to refuse, got {res.status_code}"
    )


# ---------------------------------------------------------------------------
# Site 2 — USER custom-field validation (projects/custom_field_values.py)
# ---------------------------------------------------------------------------


@pytest.fixture
def user_field(project: Project) -> ProjectCustomField:
    return ProjectCustomField.objects.create(
        project=project, name="Reviewer", field_type=CustomFieldType.USER
    )


def test_user_field_rejects_a_revoked_member(
    project: Project, user_field: ProjectCustomField
) -> None:
    """A revoked member is no longer a valid value for a person field."""
    revoked = _member(project, "cf-revoked", Role.MEMBER, revoked=True)

    with pytest.raises(serializers.ValidationError) as exc:
        validate_custom_field_write(user_field, str(revoked.pk))

    # The generic message is deliberate — the endpoint must not become an existence
    # oracle, so "revoked" and "never a member" read identically to the caller.
    assert "is not a valid member of this project" in str(exc.value)


def test_user_field_accepts_a_live_member(project: Project, user_field: ProjectCustomField) -> None:
    """The control: the floor must not reject the people the field exists for."""
    live = _member(project, "cf-live", Role.MEMBER, revoked=False)

    kwargs = validate_custom_field_write(user_field, str(live.pk))

    assert kwargs["value_user"] == live


def test_user_field_rejects_a_live_member_of_another_project(
    project: Project, calendar: Calendar, user_field: ProjectCustomField
) -> None:
    """Guards the ``project_id=field.project_id`` term, which no other test here reaches.

    Someone live on a different project must not be a valid value: drop the project term
    and this is the only test in the module that notices.
    """
    other = Project.objects.create(
        name="Other CF", start_date=datetime.date(2026, 1, 1), calendar=calendar
    )
    outsider = _member(other, "cf-elsewhere", Role.ADMIN, revoked=False)

    with pytest.raises(serializers.ValidationError):
        validate_custom_field_write(user_field, str(outsider.pk))


def test_user_field_write_endpoint_refuses_a_revoked_member_as_the_value(
    project: Project, calendar: Calendar, user_field: ProjectCustomField
) -> None:
    """The reachable production path, end to end: a **live** author naming a **revoked**
    person. The endpoint gates the writer, not the value, so unlike the retro site this
    one really was reachable over HTTP — which is why it is asserted through the API."""
    author = _member(project, "cf-author", Role.ADMIN, revoked=False)
    revoked = _member(project, "cf-http-revoked", Role.MEMBER, revoked=True)
    task = Task.objects.create(project=project, name="Review something", wbs_path="1")

    client = APIClient()
    client.force_authenticate(user=author)
    res = client.put(
        f"/api/v1/projects/{project.pk}/tasks/{task.pk}/field-values/{user_field.pk}/",
        {"value": str(revoked.pk)},
        format="json",
    )

    assert res.status_code == 400, res.content
    assert "is not a valid member of this project" in str(res.content)


def test_existing_user_field_value_pointing_at_a_revoked_member_is_left_alone(
    project: Project, user_field: ProjectCustomField
) -> None:
    """The recorded decision (#3411): stored values are **not** rewritten.

    A validator runs on write and cannot reach rows written before it shipped. Blanking
    them would destroy an author's recorded fact — "Dana reviewed this" stays true after
    Dana leaves — and would do so silently, in a migration nobody reads. So a value
    written while the member was live survives their revocation and keeps rendering.
    This test pins that as intended behavior rather than leaving it to be re-litigated
    as a bug: the write path is closed, the historical row is evidence.
    """
    live = _member(project, "cf-was-live", Role.MEMBER, revoked=False)
    kwargs = validate_custom_field_write(user_field, str(live.pk))
    assert kwargs["value_user"] == live

    membership = ProjectMembership.objects.get(project=project, user=live)
    membership.is_deleted = True
    membership.save(update_fields=["is_deleted"])

    # The stored value still resolves to the same person — nothing rewrote it.
    assert kwargs["value_user"] == live
    # …while a *new* write naming them is now refused.
    with pytest.raises(serializers.ValidationError):
        validate_custom_field_write(user_field, str(live.pk))


# ---------------------------------------------------------------------------
# Site 3 — project overview owner name (projects/views.py), found by widening the sweep
# ---------------------------------------------------------------------------


def test_overview_owner_name_skips_a_revoked_owner(project: Project) -> None:
    """With both a revoked and a live Owner present, the card must name the live one.

    The revoked row's pk is pinned to the lowest possible UUID **on purpose**. Django's
    ``.first()`` orders an unordered queryset by primary key, and the pk here is a random
    UUID — so without the pin, which of the two rows the unfixed code returns is a coin
    flip, and this test would pass on the broken build about half the time. Pinning it
    makes the unfloored query deterministically return the revoked Owner, which is what
    turns this from a hopeful assertion into a real negative control.
    """
    revoked_owner = User.objects.create_user(username="owner-revoked", password="pw")
    ProjectMembership.objects.create(
        pk=uuid.UUID(int=0),
        project=project,
        user=revoked_owner,
        role=Role.OWNER,
        is_deleted=True,
    )
    live_owner = _member(project, "owner-live", Role.OWNER, revoked=False)
    assert ProjectMembership.objects.filter(project=project).order_by("pk").first().user_id == (
        revoked_owner.pk
    ), "the revoked row must sort first, or this test cannot detect the unfixed read"

    client = APIClient()
    client.force_authenticate(user=live_owner)
    res = client.get(f"/api/v1/projects/{project.pk}/overview/")

    assert res.status_code == 200
    assert res.json()["owner_name"] == live_owner.username


def test_overview_owner_name_ignores_an_owner_of_another_project(
    project: Project, calendar: Calendar
) -> None:
    """Guards the ``project=project`` term. An Owner of a different project must not be
    named here — drop the project term and only this test notices."""
    other = Project.objects.create(
        name="Other Ov", start_date=datetime.date(2026, 1, 1), calendar=calendar
    )
    _member(other, "ov-elsewhere-owner", Role.OWNER, revoked=False)
    viewer = _member(project, "ov-viewer-x", Role.VIEWER, revoked=False)

    client = APIClient()
    client.force_authenticate(user=viewer)
    res = client.get(f"/api/v1/projects/{project.pk}/overview/")

    assert res.status_code == 200
    assert res.json()["owner_name"] is None


def test_overview_owner_name_is_none_when_every_owner_is_revoked(project: Project) -> None:
    """The floor's edge: with no live Owner the card says nothing rather than naming a
    departed one. ``owner_name`` is already ``str | None``, so no consumer breaks."""
    _member(project, "owner-all-revoked", Role.OWNER, revoked=True)
    viewer = _member(project, "owner-viewer", Role.VIEWER, revoked=False)

    client = APIClient()
    client.force_authenticate(user=viewer)
    res = client.get(f"/api/v1/projects/{project.pk}/overview/")

    assert res.status_code == 200
    assert res.json()["owner_name"] is None
