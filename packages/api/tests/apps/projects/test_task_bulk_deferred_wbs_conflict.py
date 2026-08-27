"""A wbs_path collision in a bulk batch reports as a 207 row, not an opaque 500 (#3070).

``unique_task_wbs_path_per_project_live`` is ``DEFERRABLE INITIALLY DEFERRED``, and
Postgres checks a deferred constraint at ``COMMIT`` — not at ``RELEASE SAVEPOINT``.
The per-row savepoint in ``apply_task_operations`` therefore released cleanly on a
colliding row, ``except DatabaseError`` never fired, the 207 body was assembled with
the offending row marked *applied*, and the violation then surfaced when
``ATOMIC_REQUESTS`` committed **after** the view had returned — outside DRF's
``exception_handler``. The client got a 500 naming a constraint, with no row attribution.

**Every test here needs ``transaction=True``.** Under the default ``django_db``
fixture the whole test runs inside a transaction that is rolled back rather than
committed, so the deferred check never runs at all and each of these assertions
would pass against the unfixed code.

The trigger used throughout is a non-contiguous sibling level. ``_resolve_create_parent``
picks a child path as ``len(children) + 1``, so a parent holding ``1.1`` and ``1.3``
hands the next create ``1.3`` — already taken. That allocation defect is real and is
tracked separately (#3061, #3069, #3071); what is under test here is the *reporting*
contract, which must hold for any collision however it arises, including one lost to
a concurrent writer that no allocation fix can prevent.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.task_bulk import _settle_wbs_path_constraint

URL = "/api/v1/projects/{pk}/tasks/bulk/"


def _no_side_effects() -> object:
    return patch("trueppm_api.apps.projects.views._enqueue_recalculate")


@pytest.fixture
def collided(db: object) -> tuple[APIClient, Project, Task]:
    """An owner client and a project whose phase already holds ``1.1`` and ``1.3``.

    Built with ``Task.objects.create`` rather than through the API so the gap is
    established without depending on whichever allocation path is current.
    """
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Deferred", start_date=date(2026, 1, 1), calendar=calendar
    )
    phase = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    Task.objects.create(project=project, name="First", duration=1, wbs_path="1.1")
    Task.objects.create(project=project, name="Third", duration=1, wbs_path="1.3")

    User = get_user_model()
    user = User.objects.create_user(username="owner_3070", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client, project, phase


@pytest.mark.django_db(transaction=True)
def test_a_colliding_row_is_reported_as_a_conflict_not_a_500(
    collided: tuple[APIClient, Project, Task],
) -> None:
    client, project, phase = collided

    with _no_side_effects():
        r = client.post(
            URL.format(pk=project.pk),
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {"name": "Collides", "duration": 1, "parent_id": str(phase.pk)},
                    }
                ]
            },
            format="json",
        )

    assert r.status_code == 207, r.data
    assert [e["index"] for e in r.data["rejected"]] == [0]
    assert r.data["rejected"][0]["code"] == "conflict"
    assert r.data["applied"] == []
    assert Task.objects.filter(project=project, name="Collides").exists() is False


@pytest.mark.django_db(transaction=True)
def test_the_conflict_message_names_the_position_not_the_constraint(
    collided: tuple[APIClient, Project, Task],
) -> None:
    """``rejected[].message`` reaches the client verbatim, so it must not be DB text.

    Postgres's exclusion-constraint message names the constraint and repeats the raw
    key — neither means anything to an API consumer, and the row attribution it lacks
    is already carried by ``index``.
    """
    client, project, phase = collided

    with _no_side_effects():
        r = client.post(
            URL.format(pk=project.pk),
            {
                "operations": [
                    {
                        "op": "create",
                        "data": {"name": "Collides", "duration": 1, "parent_id": str(phase.pk)},
                    }
                ]
            },
            format="json",
        )

    message = r.data["rejected"][0]["message"]
    assert "WBS position" in message
    assert "unique_task_wbs_path_per_project_live" not in message
    assert "conflicts with existing key" not in message


@pytest.mark.django_db(transaction=True)
def test_non_colliding_rows_in_the_same_batch_still_apply(
    collided: tuple[APIClient, Project, Task],
) -> None:
    """The whole point of the 207: one bad row must not discard the good ones.

    The good rows are placed on both sides of the collision, because the failure this
    replaces was whole-transaction — order could not matter to it, and order is
    exactly what a per-row report has to get right.
    """
    client, project, phase = collided

    with _no_side_effects():
        r = client.post(
            URL.format(pk=project.pk),
            {
                "operations": [
                    {"op": "create", "data": {"name": "Before", "duration": 1}},
                    {
                        "op": "create",
                        "data": {"name": "Collides", "duration": 1, "parent_id": str(phase.pk)},
                    },
                    {"op": "create", "data": {"name": "After", "duration": 1}},
                ]
            },
            format="json",
        )

    assert r.status_code == 207, r.data
    assert [e["index"] for e in r.data["rejected"]] == [1]
    assert [e["index"] for e in r.data["applied"]] == [0, 2]
    assert Task.objects.filter(project=project, name="Before").exists()
    assert Task.objects.filter(project=project, name="After").exists()
    assert Task.objects.filter(project=project, name="Collides").exists() is False


@pytest.mark.django_db(transaction=True)
def test_settling_leaves_the_constraint_deferred_for_the_next_writer(
    collided: tuple[APIClient, Project, Task],
) -> None:
    """Forcing the check must not re-break what deferral exists for.

    The constraint is ``DEFERRED`` because every WBS rewrite (indent/outdent/reorder/
    group/ungroup, structural undo) renumbers a sibling level one row at a time and
    necessarily passes through duplicate intermediate states. Draining its pending
    events is only safe if the mode is put back afterwards — a settle that left the
    constraint ``IMMEDIATE`` would turn the *first* write of any later swap into an
    ``IntegrityError``, in a transaction whose final state is perfectly unique.

    Asserted on the helper directly, in one transaction, because that is the only
    place the two modes are observable in sequence.
    """
    _, project, _phase = collided

    with transaction.atomic():
        _settle_wbs_path_constraint()
        first = Task.objects.get(project=project, name="First")  # 1.1
        third = Task.objects.get(project=project, name="Third")  # 1.3
        first.wbs_path = "1.3"
        first.save()  # transient duplicate with `third` — legal only while DEFERRED
        third.wbs_path = "1.1"
        third.save()  # resolved before COMMIT

    assert str(Task.objects.get(project=project, name="First").wbs_path) == "1.3"
    assert str(Task.objects.get(project=project, name="Third").wbs_path) == "1.1"
