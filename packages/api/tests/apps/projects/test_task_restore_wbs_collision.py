"""Restoring a tombstoned task can no longer land two live rows on one wbs_path (#3071).

Two defects, one failure. ``_next_root_wbs_path`` returned ``count(live roots) + 1``,
which reissues a tombstone's number the instant it is deleted; and ``Task.restore``
never looked at ``wbs_path`` at all, in any of its three callers. Delete root ``3``,
create a task (allocated ``3``), restore the deleted one — ``IntegrityError`` at COMMIT,
surfacing as a 500 with a constraint name and no row attribution.

**Every test needs ``transaction=True``.** ``unique_task_wbs_path_per_project_live`` is
``DEFERRABLE INITIALLY DEFERRED``, so under the default non-committing fixture the check
never runs and an unguarded restore looks fine.

The two policies under test are deliberately different, and each test says which it is
asserting: the single-row endpoint **refuses** with a 409 that names the occupant,
because a person asked for that row back at that position; the cascade and the
structural undo **re-path**, because abandoning a multi-row operation part-way leaves
the caller with neither the old state nor the new one.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    WbsPathOccupied,
    cascade_task_children_restore,
)


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Restore", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    User = get_user_model()
    user = User.objects.create_user(username="owner_3071", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ---------------------------------------------------------------------------
# Allocation — the tombstone's number must not be handed out again
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_deleting_the_last_root_does_not_free_its_number(project: Project) -> None:
    """The reported sequence, at its source: the number is never reissued."""
    from trueppm_api.apps.projects.views import _next_root_wbs_path

    for i in (1, 2, 3):
        Task.objects.create(project=project, name=f"Root {i}", duration=1, wbs_path=str(i))
    with transaction.atomic():
        Task.objects.get(project=project, wbs_path="3").soft_delete()

    with transaction.atomic():
        assert _next_root_wbs_path(project) == "4"


@pytest.mark.django_db(transaction=True)
def test_a_gap_in_the_live_roots_is_not_allocated_over(project: Project) -> None:
    """Counting live roots also misfires with no tombstone in sight.

    Roots ``1`` and ``3`` are two rows, so the old count handed out ``3`` — onto a live
    task. Non-contiguous roots arise from template adoption and import offsetting, so
    this is the more common half of the same arithmetic error.
    """
    from trueppm_api.apps.projects.views import _next_root_wbs_path

    Task.objects.create(project=project, name="One", duration=1, wbs_path="1")
    Task.objects.create(project=project, name="Three", duration=1, wbs_path="3")

    with transaction.atomic():
        assert _next_root_wbs_path(project) == "4"


@pytest.mark.django_db(transaction=True)
def test_delete_create_restore_round_trip_no_longer_conflicts(
    owner_client: APIClient, project: Project
) -> None:
    """The issue's exact sequence, end to end through the API."""
    for i in (1, 2, 3):
        Task.objects.create(project=project, name=f"Root {i}", duration=1, wbs_path=str(i))
    third = Task.objects.get(project=project, wbs_path="3")
    with transaction.atomic():
        third.soft_delete()

    created = owner_client.post(
        "/api/v1/tasks/",
        {"project": str(project.pk), "name": "New root", "duration": 1},
        format="json",
    )
    assert created.status_code == 201, created.data
    assert Task.objects.get(pk=created.data["id"]).wbs_path == "4"

    restored = owner_client.post(f"/api/v1/tasks/{third.pk}/restore/")
    assert restored.status_code == 200, restored.data
    third.refresh_from_db()
    assert third.is_deleted is False
    assert str(third.wbs_path) == "3"


# ---------------------------------------------------------------------------
# Caller 1 — the restore endpoint refuses, and names the occupant
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_the_endpoint_refuses_with_409_when_the_position_is_taken(
    owner_client: APIClient, project: Project
) -> None:
    """A path taken by any means (not only reallocation) still has to refuse cleanly.

    The occupant is written directly onto the freed path, because with the allocation
    fixed the API can no longer produce this state on its own — and the guard has to
    hold for a collision from a concurrent writer or a repair script too, which no
    allocation fix can prevent.
    """
    gone = Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1")
    with transaction.atomic():
        gone.soft_delete()
    Task.objects.create(project=project, name="Squatter", duration=1, wbs_path="1")

    r = owner_client.post(f"/api/v1/tasks/{gone.pk}/restore/")

    assert r.status_code == 409, r.data
    assert r.data["code"] == "wbs_path_occupied"
    assert "Squatter" in r.data["detail"]
    gone.refresh_from_db()
    assert gone.is_deleted is True


@pytest.mark.django_db(transaction=True)
def test_a_refused_restore_leaves_the_occupant_untouched(
    owner_client: APIClient, project: Project
) -> None:
    """The refusal must not be a partial write — DRF's handler rolls back on an
    APIException, but this path returns a Response, so nothing rolls it back for us."""
    gone = Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1")
    with transaction.atomic():
        gone.soft_delete()
    squatter = Task.objects.create(project=project, name="Squatter", duration=1, wbs_path="1")
    before = squatter.server_version

    owner_client.post(f"/api/v1/tasks/{gone.pk}/restore/")

    squatter.refresh_from_db()
    assert str(squatter.wbs_path) == "1"
    assert squatter.is_deleted is False
    assert squatter.server_version == before


@pytest.mark.django_db(transaction=True)
def test_restore_raises_rather_than_writing_when_it_refuses(project: Project) -> None:
    """The model-level contract the endpoint is built on."""
    gone = Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1")
    with transaction.atomic():
        gone.soft_delete()
    squatter = Task.objects.create(project=project, name="Squatter", duration=1, wbs_path="1")

    with pytest.raises(WbsPathOccupied) as exc, transaction.atomic():
        gone.restore()

    assert exc.value.occupant.pk == squatter.pk
    gone.refresh_from_db()
    assert gone.is_deleted is True


# ---------------------------------------------------------------------------
# Caller 2 — the subtree cascade re-paths
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_the_subtree_cascade_repaths_a_descendant_whose_slot_was_taken(
    project: Project,
) -> None:
    """A subtask's slot is freed the instant it is tombstoned, so the cascade must cope.

    Refusing here would abandon the restore of every *other* descendant, which is the
    outcome the re-path policy exists to avoid.
    """
    parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
    lost = Task.objects.create(
        project=project, name="Lost", duration=1, wbs_path="1.1", is_subtask=True
    )
    kept = Task.objects.create(
        project=project, name="Kept", duration=1, wbs_path="1.2", is_subtask=True
    )
    with transaction.atomic():
        parent.soft_delete()
    lost.refresh_from_db()
    kept.refresh_from_db()
    assert lost.is_deleted and kept.is_deleted

    # Somebody adds a subtask while the parent sits in the trash, taking 1.1.
    Task.objects.create(
        project=project, name="Squatter", duration=1, wbs_path="1.1", is_subtask=True
    )

    with transaction.atomic():
        parent.restore()
        cascade_task_children_restore(parent)

    lost.refresh_from_db()
    kept.refresh_from_db()
    assert lost.is_deleted is False, "the conflicted descendant still came back"
    assert kept.is_deleted is False, "an unconflicted sibling is unaffected"
    assert str(lost.wbs_path) != "1.1", "it moved off the occupied slot"
    assert str(lost.wbs_path).startswith("1."), "and stayed under the same parent"
    assert str(kept.wbs_path) == "1.2"

    live = list(
        Task.objects.filter(project=project, is_deleted=False).values_list("wbs_path", flat=True)
    )
    assert len(live) == len({str(p) for p in live}), "no two live rows share a path"


@pytest.mark.django_db(transaction=True)
def test_two_conflicted_descendants_get_different_replacements(project: Project) -> None:
    """The re-path allocator must not hand the same free slot to both.

    ``next_free_wbs_path`` reads tombstoned labels as well as live ones, and each row is
    written before the next is computed, so the second sees the first's new position.
    """
    parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
    a = Task.objects.create(project=project, name="A", duration=1, wbs_path="1.1", is_subtask=True)
    b = Task.objects.create(project=project, name="B", duration=1, wbs_path="1.2", is_subtask=True)
    with transaction.atomic():
        parent.soft_delete()

    for path in ("1.1", "1.2"):
        Task.objects.create(
            project=project, name=f"Squat {path}", duration=1, wbs_path=path, is_subtask=True
        )

    with transaction.atomic():
        parent.restore()
        cascade_task_children_restore(parent)

    a.refresh_from_db()
    b.refresh_from_db()
    assert a.is_deleted is False and b.is_deleted is False
    assert str(a.wbs_path) != str(b.wbs_path)
    live = list(
        Task.objects.filter(project=project, is_deleted=False).values_list("wbs_path", flat=True)
    )
    assert len(live) == len({str(p) for p in live})


@pytest.mark.django_db(transaction=True)
def test_an_unconflicted_cascade_keeps_every_path_exactly(project: Project) -> None:
    """The guard must be inert on the ordinary case — a restore that can come back
    where it was must still come back where it was."""
    parent = Task.objects.create(project=project, name="Parent", duration=1, wbs_path="1")
    child = Task.objects.create(
        project=project, name="Child", duration=1, wbs_path="1.1", is_subtask=True
    )
    with transaction.atomic():
        parent.soft_delete()

    with transaction.atomic():
        parent.restore()
        cascade_task_children_restore(parent)

    child.refresh_from_db()
    assert child.is_deleted is False
    assert str(child.wbs_path) == "1.1"


# ---------------------------------------------------------------------------
# Caller 3 — structural undo re-paths
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_structural_undo_repaths_rather_than_failing(project: Project) -> None:
    """Step 1 of ``undo_structural_operation`` restores exact ids with no cascade.

    Asserted against ``Task.restore(on_conflict="repath")`` directly rather than by
    driving a whole group/ungroup act: the undo's own step 3 re-asserts ``shape_before``
    immediately afterwards, which would mask whether step 1 survived at all. What step 1
    owes the operation is a row that is live and legal; where it finally lands is step
    3's business.
    """
    gone = Task.objects.create(project=project, name="Gone", duration=1, wbs_path="1")
    with transaction.atomic():
        gone.soft_delete()
    Task.objects.create(project=project, name="Squatter", duration=1, wbs_path="1")

    with transaction.atomic():
        gone.restore(on_conflict="repath")

    gone.refresh_from_db()
    assert gone.is_deleted is False
    assert str(gone.wbs_path) == "2"
    live = list(
        Task.objects.filter(project=project, is_deleted=False).values_list("wbs_path", flat=True)
    )
    assert len(live) == len({str(p) for p in live})
