"""Milestone signal coupling (#1773).

``is_milestone``, ``delivery_mode='milestone'``, and ``duration=0`` were three
independently-writable encodings of the same fact, so a task could carry one
without the others — and different consumers keyed off different signals. These
tests lock in the canonical coupled state enforced by ``TaskSerializer.validate``
and the MSP importer, plus the structural guards that keep a milestone childless
and prevent a sprint-targeted milestone from being silently un-flagged.
"""

from __future__ import annotations

import json
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    DeliveryMode,
    Project,
    Sprint,
    SprintState,
    Task,
)

User = get_user_model()

TASKS_URL = "/api/v1/tasks/"


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="po", password="pw")


@pytest.fixture
def project(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(name="Artemis", start_date=date(2026, 1, 1), calendar=cal)
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    return p


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _task(project: Project, wbs_path: str = "1", **kwargs: object) -> Task:
    return Task.objects.create(project=project, name="T", wbs_path=wbs_path, **kwargs)


# ---------------------------------------------------------------------------
# Serializer coupling — whichever signal is sent drives the others
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_setting_is_milestone_couples_delivery_mode_and_zeros_duration(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=5)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"is_milestone": True}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.delivery_mode == DeliveryMode.MILESTONE
    assert t.duration == 0


@pytest.mark.django_db
def test_setting_delivery_mode_milestone_couples_is_milestone_and_zeros_duration(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=5)
    r = client.patch(
        f"{TASKS_URL}{t.pk}/", {"delivery_mode": DeliveryMode.MILESTONE}, format="json"
    )
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.delivery_mode == DeliveryMode.MILESTONE
    assert t.duration == 0


@pytest.mark.django_db
def test_unflagging_milestone_resets_delivery_mode_to_waterfall(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is False
    assert t.delivery_mode == DeliveryMode.WATERFALL


@pytest.mark.django_db
def test_conflicting_signals_are_rejected(client: APIClient, project: Project) -> None:
    t = _task(project, duration=5)
    r = client.patch(
        f"{TASKS_URL}{t.pk}/",
        {"is_milestone": True, "delivery_mode": DeliveryMode.SCRUM},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_signal_conflict"


@pytest.mark.django_db
def test_editing_duration_on_existing_milestone_is_reclamped_to_zero(
    client: APIClient, project: Project
) -> None:
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)
    r = client.patch(f"{TASKS_URL}{t.pk}/", {"duration": 7}, format="json")
    assert r.status_code == 200
    t.refresh_from_db()
    assert t.duration == 0


# ---------------------------------------------------------------------------
# Un-flagging a sprint-targeted milestone is blocked
# ---------------------------------------------------------------------------


def _sprint_targeting(project: Project, milestone: Task) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        goal="Ship",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.PLANNED,
        target_milestone=milestone,
    )


@pytest.mark.django_db
def test_cannot_unflag_milestone_targeted_by_live_sprint(
    client: APIClient, project: Project
) -> None:
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    _sprint_targeting(project, m)
    r = client.patch(f"{TASKS_URL}{m.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_targeted_by_sprint"
    m.refresh_from_db()
    assert m.is_milestone is True


@pytest.mark.django_db
def test_unflag_via_delivery_mode_is_also_blocked_when_targeted(
    client: APIClient, project: Project
) -> None:
    # Flipping delivery_mode off 'milestone' un-milestones the task through the
    # coupling — the sprint-target guard must catch that path too.
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    _sprint_targeting(project, m)
    r = client.patch(
        f"{TASKS_URL}{m.pk}/", {"delivery_mode": DeliveryMode.WATERFALL}, format="json"
    )
    assert r.status_code == 400
    assert r.data["is_milestone"][0].code == "milestone_targeted_by_sprint"


@pytest.mark.django_db
def test_unflag_allowed_after_sprint_unlinked(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="9", duration=0, is_milestone=True)
    sprint = _sprint_targeting(project, m)
    sprint.target_milestone = None
    sprint.save(update_fields=["target_milestone"])
    r = client.patch(f"{TASKS_URL}{m.pk}/", {"is_milestone": False}, format="json")
    assert r.status_code == 200
    m.refresh_from_db()
    assert m.is_milestone is False


# ---------------------------------------------------------------------------
# A milestone cannot acquire children (create / indent / reparent)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cannot_create_child_under_milestone(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="1", duration=0, is_milestone=True)
    r = client.post(
        TASKS_URL,
        {"project": str(project.pk), "name": "Child", "duration": 1, "parent_id": str(m.pk)},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["parent_id"][0].code == "child_of_milestone"


@pytest.mark.django_db
def test_cannot_indent_under_milestone(client: APIClient, project: Project) -> None:
    _task(project, wbs_path="1", duration=0, is_milestone=True)
    t2 = _task(project, wbs_path="2", duration=3)
    r = client.post(f"/api/v1/projects/{project.id}/tasks/{t2.id}/indent/")
    assert r.status_code == 400
    assert r.data["code"] == "child_of_milestone"
    t2.refresh_from_db()
    assert t2.wbs_path == "2"


@pytest.mark.django_db
def test_cannot_reparent_under_milestone(client: APIClient, project: Project) -> None:
    m = _task(project, wbs_path="1", duration=0, is_milestone=True)
    stray = _task(project, wbs_path="2", duration=5)
    r = client.post(
        f"/api/v1/projects/{project.id}/tasks/{stray.id}/reparent/",
        {"new_parent_id": str(m.id)},
        format="json",
    )
    assert r.status_code == 400
    assert r.data["code"] == "child_of_milestone"
    stray.refresh_from_db()
    assert stray.wbs_path == "2"


# ---------------------------------------------------------------------------
# The invariant, closed upward (#3265)
#
# ADR-0325 claims "the DB can only hold the coupled state", but its normalization
# ran one way only: the two FLAGS were reconciled against each other and the
# milestone state then forced duration=0. Nothing inferred the flags from a bare
# duration, so `PATCH {"duration": 0}` on a work row landed precisely the state
# the ADR says cannot exist — and every consumer keying on `is_milestone` read it
# as work with no duration.
# ---------------------------------------------------------------------------


def test_bare_zero_duration_on_a_work_row_is_refused(client: APIClient, project: Project) -> None:
    """The hole: a bare ``duration: 0`` used to land is_milestone=False, duration=0."""
    t = _task(project, duration=5)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"duration": 0}, format="json")

    assert res.status_code == 400
    # A stable code, not a bare 400 string — this surface is reachable by MCP write
    # tools and API integrators, which need to branch on it.
    #
    # Asserted on the DECODED RESPONSE BODY, not on `res.data[f][0].code`. A
    # field-level `ErrorDetail`'s code is readable in-process and **dropped from the
    # JSON**: an HTTP client of the first draft of this fix saw only
    # `{"duration": ["<message>"]}`, which is precisely the bare 400 string the
    # refusal was not allowed to be. `res.data[...].code` would have passed against
    # that draft.
    body = json.loads(res.content.decode())
    assert body["code"] == "zero_duration_not_milestone"
    assert body["suggested_action"] == "set_is_milestone"
    t.refresh_from_db()
    assert t.duration == 5
    assert t.is_milestone is False


def test_refusal_names_the_payload_that_does_work(client: APIClient, project: Project) -> None:
    """Refusing is only defensible if the message says what to send instead."""
    t = _task(project, duration=5)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"duration": 0}, format="json")

    assert "is_milestone=true" in json.loads(res.content.decode())["detail"]


def test_is_milestone_true_still_zeroes_the_duration(client: APIClient, project: Project) -> None:
    """The downward direction is untouched — the guard must not shadow it."""
    t = _task(project, duration=5)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"is_milestone": True}, format="json")

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.delivery_mode == DeliveryMode.MILESTONE
    assert t.duration == 0


def test_delivery_mode_milestone_with_explicit_zero_is_accepted(
    client: APIClient, project: Project
) -> None:
    """A caller who sent BOTH is coherent — the zero is the milestone's own."""
    t = _task(project, duration=5)

    res = client.patch(
        f"{TASKS_URL}{t.id}/",
        {"delivery_mode": DeliveryMode.MILESTONE, "duration": 0},
        format="json",
    )

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is True
    assert t.duration == 0


def test_editing_a_milestone_without_touching_duration_is_unaffected(
    client: APIClient, project: Project
) -> None:
    """A milestone's stored 0 must not trip the guard on an unrelated edit."""
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"name": "Permit issued"}, format="json")

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.duration == 0
    assert t.is_milestone is True


def test_a_legacy_zero_duration_work_row_stays_editable(
    client: APIClient, project: Project
) -> None:
    """Serializer-level, not a DB constraint — existing bad rows are not bricked.

    ``AddConstraint`` validates against every existing row and migrations run on
    container start, so a constraint here would turn one legacy row into an
    upgrade crash-loop. This guard fires only when a caller *writes* a zero.
    """
    t = _task(project, duration=0)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"name": "Legacy row"}, format="json")

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.name == "Legacy row"
    assert t.duration == 0


def test_unflagging_a_milestone_without_a_duration_lands_a_legal_row(
    client: APIClient, project: Project
) -> None:
    """The back door: un-flagging leaves the gate's 0 behind unless something replaces it.

    Defaulted rather than refused — the caller asserted "no longer a milestone" and
    asserted nothing about the estimate, so refusing would make un-flagging
    impossible without guessing a number.
    """
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"is_milestone": False}, format="json")

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is False
    assert t.delivery_mode == DeliveryMode.WATERFALL
    assert t.duration == 1


def test_unflagging_with_an_explicit_duration_keeps_the_callers_number(
    client: APIClient, project: Project
) -> None:
    """The client's convert-back-with-a-stashed-estimate path (#3256)."""
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"is_milestone": False, "duration": 5}, format="json")

    assert res.status_code == 200
    t.refresh_from_db()
    assert t.is_milestone is False
    assert t.duration == 5


def test_unflagging_with_an_explicit_zero_lands_an_unestimated_row(
    client: APIClient, project: Project
) -> None:
    """Allowed, and deliberately so — nothing was destroyed.

    The row's stored duration was already 0 (it was a gate), so this write takes no
    estimate away. The result is an unestimated work row, which is the same legal
    state the Board's backlog intake mints. The guard is scoped to writes that
    *remove* an estimate, not to every zero — see the docstring on
    ``_enforce_zero_duration_is_a_milestone``.

    The un-flag default in the sibling test does not apply here: it fires only when
    the caller sends no duration at all, and this caller sent one.
    """
    t = _task(project, duration=0, is_milestone=True, delivery_mode=DeliveryMode.MILESTONE)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"is_milestone": False, "duration": 0}, format="json")

    assert res.status_code == 200, res.content.decode()
    t.refresh_from_db()
    assert t.is_milestone is False
    assert t.duration == 0


def test_creating_a_zero_duration_row_is_allowed(client: APIClient, project: Project) -> None:
    """A create destroys no estimate, and the product mints these deliberately.

    ``BoardView.handleQuickCaptureBacklog`` mints an intake idea at ``duration: 0``
    ("not scheduled work yet") and ``handleAddPhase`` mints a container at 0 (a
    phase's duration rolls up from its children). Refusing every zero 400s both —
    verified against a live request. The invariant consumers actually depend on is
    narrower than ADR-0325's wording: a write must not take an estimate *away*
    without saying what the row became.
    """
    res = client.post(
        TASKS_URL,
        {"project": str(project.id), "name": "Idea", "duration": 0, "status": "BACKLOG"},
        format="json",
    )

    assert res.status_code == 201, res.content.decode()
    assert Task.objects.filter(project=project, name="Idea", duration=0).exists()


def test_editing_a_row_already_at_zero_is_allowed(client: APIClient, project: Project) -> None:
    """Re-asserting an existing zero destroys nothing, so it is not the failure."""
    t = _task(project, duration=0)

    res = client.patch(f"{TASKS_URL}{t.id}/", {"duration": 0, "name": "Idea"}, format="json")

    assert res.status_code == 200, res.content.decode()
    t.refresh_from_db()
    assert t.duration == 0
    assert t.name == "Idea"


def test_bulk_create_and_update_inherit_the_guard(client: APIClient, project: Project) -> None:
    """``tasks/bulk/`` routes both ops through ``TaskSerializer`` (#3030, #3036).

    The bulk endpoint has been a repeat site for exactly this class, so assert it
    rather than reasoning that it must be covered. Rows apply independently, so
    the refusal lands in ``rejected`` and the legal row still applies.
    """
    zeroed = _task(project, wbs_path="9", duration=4)
    # A second row, because the envelope rejects a duplicate id across operations —
    # so the "still applies" half needs a target of its own.
    untouched = _task(project, wbs_path="10", duration=3)

    res = client.post(
        f"/api/v1/projects/{project.id}/tasks/bulk/",
        {
            "operations": [
                # A create at zero is legal (intake), so this row applies.
                {"op": "create", "data": {"name": "Idea", "duration": 0}},
                # This one destroys a 4-day estimate without saying what the row
                # became — the #3256 shape, and the one that must be rejected.
                {"op": "update", "id": str(zeroed.id), "data": {"duration": 0}},
                {"op": "update", "id": str(untouched.id), "data": {"name": "Still fine"}},
            ]
        },
        format="json",
    )

    assert res.status_code == 207, res.data
    assert {row["index"] for row in res.data["rejected"]} == {1}
    assert {row["index"] for row in res.data["applied"]} == {0, 2}
    zeroed.refresh_from_db()
    untouched.refresh_from_db()
    assert zeroed.duration == 4
    assert untouched.name == "Still fine"
    assert Task.objects.filter(project=project, name="Idea", duration=0).exists()
