"""At most one live close request per sprint (#2996).

``POST /sprints/{id}/close/`` had no dedupe: the sprint stays ACTIVE until the
async close lands, so every repeat POST wrote a ``SprintCloseRequest`` and fired
``close_sprint.delay()``. Since #2894 each of those buys up to three attempts,
each taking ``select_for_update`` on the sprint plus a full task-outcome
snapshot — so N POSTs bought 3N heavy serialized transactions. Neither
``_DISPATCH_BUDGET`` nor ``_RETRY_DISPATCH_BUDGET`` bounds that; both bound
drain-initiated dispatch only, and the POST-time ``.delay()`` bypasses them.

The second consequence is a read defect: ``GET /sprints/{id}/close-request/``
answers with the most recent row, so a duplicate that failed made the endpoint
report FAILED for a sprint that was already COMPLETED.

The invariant pinned here is one line: **a sprint has at most one live close
request**, where live means PENDING, IN_FLIGHT, or FAILED with a non-null
``next_attempt_at`` — the same "not finished" notion ``purge_sprint_close_requests``
already applies from the other side.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
)
from trueppm_api.apps.projects.services import enqueue_sprint_close

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def project(owner: Any) -> Project:
    project = Project.objects.create(name="Proj", start_date=date(2026, 1, 1))
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    return project


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 6),
        finish_date=date(2026, 1, 20),
        state=SprintState.ACTIVE,
        committed_points=10,
    )


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# --------------------------------------------------------------------------- #
# The service layer
# --------------------------------------------------------------------------- #


def test_second_enqueue_returns_the_live_row_and_does_not_dispatch(
    sprint: Sprint,
    owner: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch("trueppm_api.apps.projects.tasks.close_sprint.delay") as delay,
        django_capture_on_commit_callbacks(execute=True),
    ):
        first, created_first = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)
        second, created_second = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)

    assert created_first is True
    assert created_second is False
    assert second.pk == first.pk
    assert SprintCloseRequest.objects.filter(sprint=sprint).count() == 1
    # The amplification this issue is about: one dispatch, not two. Captured
    # through the savepoint-safe override in conftest (#2945) because the
    # enqueue registers its on_commit inside a nested atomic().
    assert delay.call_count == 1


def test_dedupe_keeps_the_original_disposition(sprint: Sprint, owner: Any) -> None:
    """The in-flight close is not retargeted by a later POST's arguments."""
    first, _ = enqueue_sprint_close(
        sprint_id=sprint.pk,
        carry_over_to="backlog",
        pending_disposition="carry",
        requested_by=owner,
    )
    second, created = enqueue_sprint_close(
        sprint_id=sprint.pk, carry_over_to="none", pending_disposition="reject", requested_by=owner
    )

    assert created is False
    assert second.pk == first.pk
    assert second.carry_over_to == "backlog"
    assert second.pending_disposition == "carry"


@pytest.mark.parametrize(
    "status_value",
    [SprintCloseRequestStatus.PENDING, SprintCloseRequestStatus.IN_FLIGHT],
)
def test_pending_and_in_flight_are_live(sprint: Sprint, owner: Any, status_value: str) -> None:
    existing = SprintCloseRequest.objects.create(
        sprint=sprint, requested_by=owner, status=status_value
    )

    req, created = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)

    assert created is False
    assert req.pk == existing.pk


def test_failed_with_a_live_retry_clock_is_live(sprint: Sprint, owner: Any) -> None:
    existing = SprintCloseRequest.objects.create(
        sprint=sprint,
        requested_by=owner,
        status=SprintCloseRequestStatus.FAILED,
        next_attempt_at=timezone.now() + timedelta(seconds=60),
    )

    req, created = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)

    assert created is False, "a FAILED row awaiting retry will still run — do not queue a second"
    assert req.pk == existing.pk


def test_terminally_failed_does_not_block_a_new_request(sprint: Sprint, owner: Any) -> None:
    """``next_attempt_at is None`` means no further attempt (#2894), so the sprint
    is stranded ACTIVE and the user must be able to ask again."""
    terminal = SprintCloseRequest.objects.create(
        sprint=sprint,
        requested_by=owner,
        status=SprintCloseRequestStatus.FAILED,
        next_attempt_at=None,
    )

    req, created = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)

    assert created is True
    assert req.pk != terminal.pk


def test_completed_does_not_block_a_new_request(sprint: Sprint, owner: Any) -> None:
    done = SprintCloseRequest.objects.create(
        sprint=sprint, requested_by=owner, status=SprintCloseRequestStatus.COMPLETED
    )

    req, created = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)

    assert created is True
    assert req.pk != done.pk


def test_dedupe_is_scoped_to_the_sprint(project: Project, sprint: Sprint, owner: Any) -> None:
    other = Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=SprintState.ACTIVE,
    )
    first, _ = enqueue_sprint_close(sprint_id=sprint.pk, requested_by=owner)
    second, created = enqueue_sprint_close(sprint_id=other.pk, requested_by=owner)

    assert created is True
    assert second.pk != first.pk


# --------------------------------------------------------------------------- #
# The endpoint
# --------------------------------------------------------------------------- #


def test_repeat_post_returns_the_same_request_id_and_flags_it(sprint: Sprint, owner: Any) -> None:
    client = _client(owner)
    url = f"/api/v1/sprints/{sprint.pk}/close/"

    first = client.post(url, {}, format="json")
    second = client.post(url, {}, format="json")

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.data["request_id"] == first.data["request_id"]
    assert first.data.get("deduplicated") is None
    assert second.data["deduplicated"] is True
    # The caller is told which disposition the live close is actually using,
    # rather than being left to assume its own arguments took effect.
    assert second.data["carry_over_to"] == "backlog"
    assert second.data["pending_disposition"] == "carry"
    assert SprintCloseRequest.objects.filter(sprint=sprint).count() == 1


def test_close_request_read_route_reports_the_single_live_row(sprint: Sprint, owner: Any) -> None:
    """The misreport in the issue: with one live row there is nothing ambiguous
    for the read route to pick between."""
    client = _client(owner)
    client.post(f"/api/v1/sprints/{sprint.pk}/close/", {}, format="json")
    client.post(f"/api/v1/sprints/{sprint.pk}/close/", {}, format="json")

    resp = client.get(f"/api/v1/sprints/{sprint.pk}/close-request/")

    assert resp.status_code == 200
    assert SprintCloseRequest.objects.filter(sprint=sprint).count() == 1
    assert resp.data["status"] == SprintCloseRequestStatus.PENDING
