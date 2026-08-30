"""A bulk sprint write is an injection like every other one (#3152, ADR-0102).

`_apply_create` recorded a mid-sprint injection; `_apply_update` and
`_apply_recreate_as_edit` did not. So moving a batch of already-scheduled tasks
into a RUNNING sprint through `POST /projects/{pk}/tasks/bulk/` landed them
straight in the commitment: no `SprintScopeChange` to accept or reject, no
`sprint_pending` flag, and the burndown moved on its own.

The invariant these tests hold is not "the bulk view calls a helper" — it is
that **every write path agrees on what an injection is**. So the ACTIVE case
asserts the row and the flag, and the PLANNED/no-op cases assert the helper's
own guards still hold on this path rather than being re-implemented beside it.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    ScopeChangeStatus,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
)

URL = "/api/v1/projects/{pk}/tasks/bulk/"


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Sprint batch", start_date=date(2026, 1, 1), calendar=calendar
    )


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    user = get_user_model().objects.create_user(username="sprint_owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _sprint(project: Project, state: str, name: str) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        goal="",
        start_date=date(2026, 1, 5),
        finish_date=date(2026, 1, 16),
        state=state,
    )


def _task(project: Project, name: str, **kwargs: object) -> Task:
    return Task.objects.create(project=project, name=name, duration=3, **kwargs)


def _post(client: APIClient, project: Project, operations: list[dict[str, object]]) -> object:
    # The CPM enqueue is not what these tests are about, and leaving it live
    # makes every one of them depend on a broker.
    with patch("trueppm_api.apps.projects.views._enqueue_recalculate"):
        return client.post(URL.format(pk=project.pk), {"operations": operations}, format="json")


@pytest.mark.django_db
def test_bulk_update_into_active_sprint_records_the_injection(
    owner_client: APIClient, project: Project
) -> None:
    """The defect itself: a batch into a RUNNING sprint must be held pending."""
    sprint = _sprint(project, SprintState.ACTIVE, "Sprint 7")
    a = _task(project, "Survey the site")
    b = _task(project, "Pour foundations")

    res = _post(
        owner_client,
        project,
        [
            {"op": "update", "id": str(a.pk), "data": {"sprint": str(sprint.pk)}},
            {"op": "update", "id": str(b.pk), "data": {"sprint": str(sprint.pk)}},
        ],
    )
    assert res.status_code in (200, 207), res.data

    a.refresh_from_db()
    b.refresh_from_db()
    assert a.sprint_id == sprint.pk
    assert b.sprint_id == sprint.pk
    # Visible in the sprint, excluded from the commitment until accepted.
    assert a.sprint_pending is True
    assert b.sprint_pending is True

    changes = SprintScopeChange.objects.filter(sprint=sprint)
    assert changes.count() == 2
    assert set(changes.values_list("task_id", flat=True)) == {a.pk, b.pk}
    assert {c.status for c in changes} == {ScopeChangeStatus.PENDING}


@pytest.mark.django_db
def test_bulk_update_into_a_planned_sprint_is_not_an_injection(
    owner_client: APIClient, project: Project
) -> None:
    """Only a RUNNING sprint has a commitment to protect.

    Asserted on THIS path rather than trusted from the helper's own tests,
    because the bug being fixed was a call site that never ran — a guard that
    only holds where it is not reached is not a guard.
    """
    sprint = _sprint(project, SprintState.PLANNED, "Sprint 8")
    task = _task(project, "Frame the walls")

    res = _post(
        owner_client,
        project,
        [{"op": "update", "id": str(task.pk), "data": {"sprint": str(sprint.pk)}}],
    )
    assert res.status_code in (200, 207), res.data

    task.refresh_from_db()
    assert task.sprint_id == sprint.pk
    assert task.sprint_pending is False
    assert not SprintScopeChange.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_a_bulk_write_that_does_not_move_the_sprint_records_nothing(
    owner_client: APIClient, project: Project
) -> None:
    """A duration edit on a task already in the active sprint is not an injection.

    The call is unconditional on the bulk path, so this is the assertion that the
    helper's no-op guard is what keeps it from flagging every unrelated edit.
    """
    sprint = _sprint(project, SprintState.ACTIVE, "Sprint 7")
    task = _task(project, "Already committed", sprint=sprint)

    res = _post(
        owner_client, project, [{"op": "update", "id": str(task.pk), "data": {"duration": 8}}]
    )
    assert res.status_code in (200, 207), res.data

    task.refresh_from_db()
    assert task.duration == 8
    assert task.sprint_pending is False
    assert not SprintScopeChange.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_taking_a_batch_out_of_a_sprint_records_nothing(
    owner_client: APIClient, project: Project
) -> None:
    """`sprint: null` is a removal, and a removal is not an injection."""
    sprint = _sprint(project, SprintState.ACTIVE, "Sprint 7")
    task = _task(project, "Pulled out", sprint=sprint)

    res = _post(
        owner_client, project, [{"op": "update", "id": str(task.pk), "data": {"sprint": None}}]
    )
    assert res.status_code in (200, 207), res.data

    task.refresh_from_db()
    assert task.sprint_id is None
    assert task.sprint_pending is False
    assert not SprintScopeChange.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_bulk_percent_and_duration_still_write_on_the_same_batch(
    owner_client: APIClient, project: Project
) -> None:
    """The three fields #3152 adds to the sheet are writable through this endpoint.

    The client change rests on this: `duration`, `percent_complete` and `sprint`
    are ordinary serializer fields here, so the sheet needs no new endpoint. That
    premise is worth one assertion rather than a comment.
    """
    sprint = _sprint(project, SprintState.PLANNED, "Sprint 8")
    task = _task(project, "Re-planned")

    res = _post(
        owner_client,
        project,
        [
            {
                "op": "update",
                "id": str(task.pk),
                "data": {"duration": 9, "percent_complete": 40, "sprint": str(sprint.pk)},
            }
        ],
    )
    assert res.status_code in (200, 207), res.data

    task.refresh_from_db()
    assert task.duration == 9
    assert task.percent_complete == 40
    assert task.sprint_id == sprint.pk

