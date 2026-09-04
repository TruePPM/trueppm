"""General structural undo for the schedule outline (ADR-0880, #2974, #3006).

The assertion shape throughout is **outcome, not call**: every test reads the resulting
``wbs_path`` set back off the database and compares it to what it was before the act. A
test that only checked "a ledger row exists" would pass on an undo that reverses nothing,
which is precisely the failure mode #2974 says is worse than having no undo at all.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    StructuralOperation,
    StructuralOperationKind,
    SyncBatchOperationStatus,
    Task,
)
from trueppm_api.apps.projects.structural_operation_services import (
    STRUCTURAL_OPERATION_MAX_REGION,
    reduce_region_roots,
)

User = get_user_model()

UNDO_URL = "/api/v1/structural-operations/{pk}/undo/"
LIST_URL = "/api/v1/structural-operations/"
INDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/indent/"
OUTDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/outdent/"
REPARENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/reparent/"
REORDER_URL = "/api/v1/projects/{pk}/tasks/reorder/"
GROUP_URL = "/api/v1/projects/{pk}/tasks/group/"
UNGROUP_URL = "/api/v1/projects/{pk}/tasks/ungroup/"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Undo", start_date=date(2026, 1, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> APIClient:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    return _member(project, "owner", Role.OWNER)


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    return _member(project, "admin", Role.ADMIN)


@pytest.fixture
def member_client(project: Project) -> APIClient:
    return _member(project, "member", Role.MEMBER)


@pytest.fixture
def scheduler_client(project: Project) -> APIClient:
    return _member(project, "scheduler", Role.SCHEDULER)


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    return _member(project, "viewer", Role.VIEWER)


@pytest.fixture
def outsider_client(db: object) -> APIClient:
    user = User.objects.create_user(username="outsider", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _immediate_on_commit() -> Any:
    return patch("django.db.transaction.on_commit", side_effect=lambda fn, *a, **kw: fn())


def make_tasks(project: Project, paths: list[str]) -> dict[str, Task]:
    """Create one live task per WBS path, named after the path."""
    out: dict[str, Task] = {}
    for path in paths:
        out[path] = Task.objects.create(project=project, name=f"T{path}", duration=1, wbs_path=path)
    return out


def shape(project: Project) -> dict[str, str]:
    """The whole live outline as ``{task name: wbs_path}`` — the thing under test."""
    return {
        name: str(path)
        for name, path in Task.objects.filter(project=project, is_deleted=False).values_list(
            "name", "wbs_path"
        )
    }


def undo(client: APIClient, operation_id: str) -> Any:
    with (
        _immediate_on_commit(),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        return client.post(UNDO_URL.format(pk=operation_id), {}, format="json")


def act(client: APIClient, url: str, body: Any = None) -> Any:
    with (
        _immediate_on_commit(),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        return client.post(url, body if body is not None else {}, format="json")


# ---------------------------------------------------------------------------
# Round-trip: every covered act and its inverse
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_indent_round_trips_to_the_same_shape(project: Project, owner_client: APIClient) -> None:
    tasks = make_tasks(project, ["1", "2", "3"])
    before = shape(project)

    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert response.status_code == 200
    assert shape(project) != before, "the indent must actually have moved something"
    operation_id = response.json()["operation_id"]

    assert undo(owner_client, operation_id).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_outdent_round_trips_including_the_siblings_it_adopts(
    project: Project, owner_client: APIClient
) -> None:
    # MS-Project convention: outdenting 1.1 adopts 1.2 and 1.3 as its children, so the
    # inverse has to put three rows back, not one.
    make_tasks(project, ["1", "1.1", "1.2", "1.3", "2"])
    target = Task.objects.get(project=project, wbs_path="1.1")
    before = shape(project)

    response = act(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=target.pk))
    assert response.status_code == 200
    assert shape(project) != before
    assert undo(owner_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_reparent_round_trips_across_levels(project: Project, owner_client: APIClient) -> None:
    make_tasks(project, ["1", "1.1", "2", "2.1"])
    moved = Task.objects.get(project=project, wbs_path="1.1")
    new_parent = Task.objects.get(project=project, wbs_path="2")
    before = shape(project)

    response = act(
        owner_client,
        REPARENT_URL.format(pk=project.pk, task_id=moved.pk),
        {"new_parent_id": str(new_parent.pk)},
    )
    assert response.status_code == 200
    assert shape(project) != before
    assert undo(owner_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_reorder_round_trips(project: Project, owner_client: APIClient) -> None:
    tasks = make_tasks(project, ["1", "2", "3"])
    before = shape(project)

    response = act(
        owner_client,
        REORDER_URL.format(pk=project.pk),
        {
            "parent_path": "",
            "ordered_ids": [str(tasks["3"].pk), str(tasks["1"].pk), str(tasks["2"].pk)],
        },
    )
    assert response.status_code == 200
    assert shape(project) != before
    assert undo(owner_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_group_round_trips_and_the_container_goes_away(
    project: Project, owner_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2", "3"])
    before = shape(project)

    response = act(
        owner_client,
        GROUP_URL.format(pk=project.pk),
        {"task_ids": [str(tasks["1"].pk), str(tasks["2"].pk)], "name": "Discovery"},
    )
    assert response.status_code == 200
    container_id = response.json()["container"]["id"]

    assert undo(owner_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before
    # The phase the group minted must be gone, not left as an empty wrapper.
    assert Task.objects.get(pk=container_id).is_deleted is True


@pytest.mark.django_db
def test_ungroup_undo_restores_the_wrapper_with_its_identity_intact(
    project: Project, owner_client: APIClient
) -> None:
    """#3006: this is the asymmetry the issue was filed for.

    Re-grouping the lifted rows mints a *new* container id and loses the wrapper's name
    and notes. Undo restores the soft-deleted row itself, so the id, name and notes come
    back unchanged — which is why nothing about the wrapper needed snapshotting.
    """
    container = Task.objects.create(
        project=project,
        name="Discovery",
        duration=1,
        wbs_path="1",
        notes="why this phase exists",
    )
    make_tasks(project, ["1.1", "1.2", "2"])
    before = shape(project)

    response = act(owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)})
    assert response.status_code == 200
    container.refresh_from_db()
    assert container.is_deleted is True

    assert undo(owner_client, response.json()["operation_id"]).status_code == 200

    container.refresh_from_db()
    assert container.is_deleted is False
    assert container.name == "Discovery"
    assert container.notes == "why this phase exists"
    assert shape(project) == before


@pytest.mark.django_db
def test_ungroup_undo_restores_the_wrappers_own_dependency_edges(
    project: Project, owner_client: APIClient
) -> None:
    container = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    make_tasks(project, ["1.1"])
    other = Task.objects.create(project=project, name="After", duration=1, wbs_path="2")
    edge = Dependency.objects.create(predecessor=container, successor=other, dep_type="FS")

    response = act(owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)})
    assert response.status_code == 200
    edge.refresh_from_db()
    assert edge.is_deleted is True
    assert str(edge.pk) in response.json()["removed_dependency_ids"]

    body = undo(owner_client, response.json()["operation_id"]).json()
    edge.refresh_from_db()
    assert edge.is_deleted is False
    assert body["undo"]["dependencies_restored"] == 1


@pytest.mark.django_db
def test_ungroup_undo_skips_an_edge_whose_other_end_has_since_been_deleted(
    project: Project, owner_client: APIClient
) -> None:
    """A restored edge pointing at a tombstone is invisible to the graph guard.

    ``capture_graph_state`` builds its edge list from live tasks only, so it structurally
    cannot catch a dangling edge. The per-edge guard is the control; this pins it.

    The far endpoint sits **outside** the ungrouped level's region on purpose. Deleting a
    row *inside* the region trips the shape precondition first and never reaches the edge
    guard — which is correct, and is why this case needs a task the region does not cover.
    """
    make_tasks(project, ["1"])
    container = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1.1")
    make_tasks(project, ["1.1.1"])
    other = Task.objects.create(project=project, name="After", duration=1, wbs_path="2")
    edge = Dependency.objects.create(predecessor=container, successor=other, dep_type="FS")

    response = act(owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)})
    assert response.status_code == 200
    operation_id = response.json()["operation_id"]
    other.soft_delete()

    body = undo(owner_client, operation_id).json()
    edge.refresh_from_db()
    assert edge.is_deleted is True, "must not resurrect an edge pointing at a tombstone"
    assert body["undo"]["dependencies_skipped"] == 1
    assert body["undo"]["dependencies_restored"] == 0


@pytest.mark.django_db
def test_ungroup_undo_does_not_resurrect_a_separately_deleted_subtask(
    project: Project, owner_client: APIClient
) -> None:
    """`cascade_task_children_restore` would un-delete this. Undo must not.

    Reversing a *grouping* is not the same act as clicking Restore on a row you deleted,
    and a container carrying tombstones ungroups cleanly.
    """
    container = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    make_tasks(project, ["1.1"])
    doomed = Task.objects.create(
        project=project, name="Doomed", duration=1, wbs_path="1.2", is_subtask=True
    )
    doomed.soft_delete()

    response = act(owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)})
    assert response.status_code == 200
    assert undo(owner_client, response.json()["operation_id"]).status_code == 200

    doomed.refresh_from_db()
    assert doomed.is_deleted is True


# ---------------------------------------------------------------------------
# The precondition: someone else built on it
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_undo_refuses_when_someone_moved_a_row_in_the_region(
    project: Project, owner_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2", "3"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    operation_id = response.json()["operation_id"]

    # A collaborator restructures the same level.
    Task.objects.filter(pk=tasks["3"].pk).update(wbs_path="9")
    after_their_edit = shape(project)

    refusal = undo(owner_client, operation_id)
    assert refusal.status_code == 409
    assert refusal.json()["code"] == "shape_changed"
    assert refusal.json()["changed"], "the refusal must name what changed"
    # Refusing means refusing: nothing partial may have been written.
    assert shape(project) == after_their_edit
    assert StructuralOperation.objects.get(pk=operation_id).status == (
        SyncBatchOperationStatus.ACTIVE
    )


@pytest.mark.django_db
def test_undo_refuses_when_someone_added_a_row_into_the_region(
    project: Project, owner_client: APIClient
) -> None:
    """A per-row version check cannot see this — an added row is in no snapshot.

    It is also the case that produces an orphan: restoring the surrounding paths would
    leave the new row's parent path pointing at nothing, and it would silently render at
    the project root.
    """
    tasks = make_tasks(project, ["1", "2", "3"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    operation_id = response.json()["operation_id"]

    Task.objects.create(project=project, name="Newcomer", duration=1, wbs_path="1.1.1")

    refusal = undo(owner_client, operation_id)
    assert refusal.status_code == 409
    assert refusal.json()["code"] == "shape_changed"
    assert any(entry["change"] == "added" for entry in refusal.json()["changed"])


@pytest.mark.django_db
def test_undo_refuses_when_the_minted_container_has_been_renamed(
    project: Project, owner_client: APIClient
) -> None:
    """Undo deletes the container, so an edit to it must block rather than be swallowed.

    Renaming a phase is the obvious next thing to do after grouping, and this is the
    dimension the shape comparison alone cannot see.
    """
    tasks = make_tasks(project, ["1", "2"])
    response = act(
        owner_client,
        GROUP_URL.format(pk=project.pk),
        {"task_ids": [str(tasks["1"].pk), str(tasks["2"].pk)], "name": None},
    )
    container = Task.objects.get(pk=response.json()["container"]["id"])
    container.name = "Discovery"
    container.save()

    refusal = undo(owner_client, response.json()["operation_id"])
    assert refusal.status_code == 409
    assert refusal.json()["code"] == "shape_changed"
    assert any(entry["change"] == "edited" for entry in refusal.json()["changed"])


@pytest.mark.django_db
def test_undo_refuses_when_the_deleted_wrapper_was_restored_by_another_route(
    project: Project, owner_client: APIClient
) -> None:
    container = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="1")
    make_tasks(project, ["1.1"])
    response = act(owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)})
    container.refresh_from_db()
    # Stands in for "another route" reviving the wrapper without going through undo.
    # `on_conflict="repath"` because the ungroup lifted the child onto "1", so the
    # wrapper's own position is taken; re-pathing is what the cascade and the structural
    # undo themselves do in that situation (#3071). Before that guard existed this line
    # was a bare `.restore()`, which put two live rows on "1" — a genuinely corrupted
    # state the test then had to soft-delete again so the DEFERRED constraint would not
    # fire at teardown. The state under test is "the wrapper is live again", which does
    # not need the corruption to express.
    container.restore(on_conflict="repath")

    refusal = undo(owner_client, response.json()["operation_id"])
    assert refusal.status_code == 409
    assert any(entry["change"] == "restored_elsewhere" for entry in refusal.json()["changed"])


# ---------------------------------------------------------------------------
# Stack discipline and idempotency
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_undoing_twice_is_a_no_op_not_an_error(project: Project, owner_client: APIClient) -> None:
    tasks = make_tasks(project, ["1", "2", "3"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    operation_id = response.json()["operation_id"]

    first = undo(owner_client, operation_id)
    assert first.status_code == 200
    settled = shape(project)

    second = undo(owner_client, operation_id)
    assert second.status_code == 200, "a double ⌘Z is a no-op, not a 400"
    assert second.json()["undo"] == first.json()["undo"]
    assert shape(project) == settled


@pytest.mark.django_db
def test_an_older_operation_cannot_be_undone_before_a_newer_one(
    project: Project, owner_client: APIClient
) -> None:
    """Enforced on the server, not by which button the popover renders.

    The two acts below touch disjoint regions, so the shape precondition passes for the
    older one — this is exactly the case where "the shape check enforces it by
    construction" is false and a headless client would undo out of order.
    """
    make_tasks(project, ["1", "1.1", "1.2", "2", "2.1", "2.2"])
    first = act(
        owner_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="1.2").pk),
    )
    second = act(
        owner_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="2.2").pk),
    )

    refusal = undo(owner_client, first.json()["operation_id"])
    assert refusal.status_code == 409
    assert refusal.json()["code"] == "not_top_of_stack"
    assert refusal.json()["blocking_operation_id"] == second.json()["operation_id"]

    # Undoing the newer one first unblocks the older — deep undo by iteration.
    assert undo(owner_client, second.json()["operation_id"]).status_code == 200
    assert undo(owner_client, first.json()["operation_id"]).status_code == 200


@pytest.mark.django_db
def test_a_collaborators_act_does_not_block_your_undo(
    project: Project, owner_client: APIClient, admin_client: APIClient
) -> None:
    """The stack is per actor, so ⌘Z means "undo *your* last structural act"."""
    make_tasks(project, ["1", "1.1", "1.2", "2", "2.1", "2.2"])
    mine = act(
        owner_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="1.2").pk),
    )
    act(
        admin_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="2.2").pk),
    )

    assert undo(owner_client, mine.json()["operation_id"]).status_code == 200


# ---------------------------------------------------------------------------
# RBAC — all five roles
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_member_can_undo_their_own_indent(project: Project, member_client: APIClient) -> None:
    """The asymmetry this design exists to remove: a Member may indent, so may un-indent.

    ADR-0773 lets a Member restructure their own assigned rows; ADR-0810's Admin-only
    undo bar would have let them make the change and not reverse it.
    """
    member = User.objects.get(username="member")
    tasks = make_tasks(project, ["1", "2"])
    for task in tasks.values():
        task.assignee = member
        task.save()

    response = act(member_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert response.status_code == 200
    assert undo(member_client, response.json()["operation_id"]).status_code == 200


@pytest.mark.django_db
def test_a_member_may_not_undo_someone_elses_act(
    project: Project, owner_client: APIClient, member_client: APIClient
) -> None:
    """404, not 403 — and the distinction is the point.

    The list queryset scopes to *your own* acts plus anything where you are Admin+, so a
    Member never sees a colleague's operation at all. Asserting the exact status stops
    this from silently becoming a test of the wrong mechanism: if the queryset were ever
    widened to the ADR-0810 siblings' membership-only scope, this would flip to 403 and
    say so, instead of passing either way behind an `in (403, 404)`.
    """
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert undo(member_client, response.json()["operation_id"]).status_code == 404


@pytest.mark.django_db
def test_require_structural_undo_authority_refuses_a_non_admin_third_party(
    project: Project, owner_client: APIClient, member_client: APIClient
) -> None:
    """Pin the guard directly — the endpoint's queryset 404s before it is reached.

    `require_structural_undo_authority` is defense-in-depth today: nothing routes a
    non-Admin to an operation they did not perform. That makes it exactly the kind of
    check that rots unnoticed, so it is exercised against the function rather than
    through the endpoint that currently shadows it.
    """
    from rest_framework.exceptions import PermissionDenied
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.projects.structural_operation_services import (
        may_undo,
        require_structural_undo_authority,
    )

    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    operation = StructuralOperation.objects.get(pk=response.json()["operation_id"])

    request = APIRequestFactory().post("/")
    request.user = User.objects.get(username="member")
    with pytest.raises(PermissionDenied):
        require_structural_undo_authority(request, operation)
    assert may_undo(request, operation) is False

    request.user = User.objects.get(username="owner")
    require_structural_undo_authority(request, operation)  # the actor: no raise
    assert may_undo(request, operation) is True


@pytest.mark.django_db
def test_a_member_can_undo_their_own_group(project: Project, member_client: APIClient) -> None:
    """The group container is minted unassigned, and undo deletes it.

    Gating that deletion at DELETE grade would deny a Member the reversal of their own
    group — `can_user_edit_task(..., "DELETE")` fails on an unassigned row for a Member —
    which is the very asymmetry ADR-0880 §4 removes, reappearing one layer down. Undo
    gates minted rows at the authority the *mint* required instead.
    """
    member = User.objects.get(username="member")
    tasks = make_tasks(project, ["1", "2"])
    for task in tasks.values():
        task.assignee = member
        task.save()
    before = shape(project)

    response = act(
        member_client,
        GROUP_URL.format(pk=project.pk),
        {"task_ids": [str(tasks["1"].pk), str(tasks["2"].pk)], "name": "Discovery"},
    )
    assert response.status_code == 200
    assert undo(member_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_a_member_cannot_undo_once_their_anchor_row_is_reassigned(
    project: Project, member_client: APIClient
) -> None:
    """Undo re-checks authority against the row's CURRENT state, not the act's."""
    member = User.objects.get(username="member")
    tasks = make_tasks(project, ["1", "2"])
    for task in tasks.values():
        task.assignee = member
        task.save()
    response = act(member_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert response.status_code == 200

    other = User.objects.create_user(username="reassigned-to", password="pw")
    Task.objects.filter(pk=tasks["2"].pk).update(assignee=other)

    assert undo(member_client, response.json()["operation_id"]).status_code == 403


@pytest.mark.django_db
def test_undo_is_refused_on_an_archived_project(project: Project, owner_client: APIClient) -> None:
    """`IsProjectNotArchived` is the load-bearing gate on this route.

    Without it, a Member who indented before archival could still rewrite an
    archived plan's WBS — a write no role can otherwise make. (It is not the *only*
    place `is_archived` is enforced, as this docstring used to claim: most write
    routes carry the class, and since #3354 `undo_structural_operation` repeats the
    check at the service layer too.)
    """
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    after_act = shape(project)

    Project.objects.filter(pk=project.pk).update(is_archived=True)

    assert undo(owner_client, response.json()["operation_id"]).status_code == 403
    assert shape(project) == after_act


@pytest.mark.django_db
def test_an_admin_may_undo_someone_elses_act(
    project: Project, owner_client: APIClient, admin_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2"])
    before = shape(project)
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))

    assert undo(admin_client, response.json()["operation_id"]).status_code == 200
    assert shape(project) == before


@pytest.mark.django_db
def test_a_scheduler_is_excluded_from_plan_authoring_and_from_its_undo(
    project: Project, owner_client: APIClient, scheduler_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    # 404: the queryset scopes a non-actor, non-Admin out before any permission class
    # runs. The plan-author bar is asserted on an operation they DO own, below.
    assert undo(scheduler_client, response.json()["operation_id"]).status_code == 404


@pytest.mark.django_db
def test_a_viewer_may_not_undo(
    project: Project, owner_client: APIClient, viewer_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert undo(viewer_client, response.json()["operation_id"]).status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("username", "role"), [("scheduler", Role.SCHEDULER), ("viewer", Role.VIEWER)]
)
def test_a_non_authoring_role_is_refused_even_on_its_own_operation(
    project: Project, username: str, role: int
) -> None:
    """Exercises the permission classes, not the queryset that usually shadows them.

    Neither role can perform a structural act, so an operation attributed to one can
    only be constructed directly — which is the point: it puts the caller past the
    `applied_by` scope and onto `IsProjectMemberWrite` / `IsProjectPlanAuthor`, the
    layer the endpoint-level role tests never reach.
    """
    client = _member(project, username, role)
    make_tasks(project, ["1", "2"])
    operation = StructuralOperation.objects.create(
        project=project,
        applied_by=User.objects.get(username=username),
        kind=StructuralOperationKind.INDENT,
    )
    assert undo(client, str(operation.pk)).status_code == 403


@pytest.mark.django_db
def test_an_outsider_cannot_see_or_undo_an_operation(
    project: Project, owner_client: APIClient, outsider_client: APIClient
) -> None:
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert undo(outsider_client, response.json()["operation_id"]).status_code == 404
    assert outsider_client.get(LIST_URL).json()["results"] == []


@pytest.mark.django_db
def test_a_viewer_cannot_read_the_structural_history(
    project: Project, owner_client: APIClient, viewer_client: APIClient
) -> None:
    """Tighter than the ADR-0810 siblings, which scope on membership with no role floor.

    The ledger is a historical record — it preserves how the plan was organized before a
    reorg the live tree no longer shows, and names tombstoned rows.
    """
    tasks = make_tasks(project, ["1", "2"])
    act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert viewer_client.get(LIST_URL).json()["results"] == []


@pytest.mark.django_db
def test_undo_records_who_reversed_it(
    project: Project, owner_client: APIClient, admin_client: APIClient
) -> None:
    """Cross-actor undo without an actor record is the repudiation gap."""
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    undo(admin_client, response.json()["operation_id"])

    operation = StructuralOperation.objects.get(pk=response.json()["operation_id"])
    assert operation.applied_by.username == "owner"
    assert operation.undone_by.username == "admin"


# ---------------------------------------------------------------------------
# Undoability as a server fact
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_the_serializer_reports_undoability_and_why_not(
    project: Project, owner_client: APIClient
) -> None:
    """A client must not have to derive this — ``status`` reads ``active`` either way."""
    make_tasks(project, ["1", "1.1", "1.2", "2", "2.1", "2.2"])
    older = act(
        owner_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="1.2").pk),
    )
    newer = act(
        owner_client,
        INDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="2.2").pk),
    )

    rows = {row["id"]: row for row in owner_client.get(LIST_URL).json()["results"]}
    assert rows[older.json()["operation_id"]]["status"] == "active"
    assert rows[older.json()["operation_id"]]["is_undoable"] is False
    assert rows[older.json()["operation_id"]]["undo_blocked_reason"] == "not_top_of_stack"
    assert rows[newer.json()["operation_id"]]["is_undoable"] is True
    assert rows[newer.json()["operation_id"]]["undo_blocked_reason"] == ""


@pytest.mark.django_db
def test_an_oversized_region_records_itself_non_undoable_and_the_act_still_succeeds(
    project: Project, owner_client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The act must not fail just because it is too big to reverse."""
    monkeypatch.setattr(
        "trueppm_api.apps.projects.structural_operation_services.STRUCTURAL_OPERATION_MAX_REGION",
        1,
    )
    tasks = make_tasks(project, ["1", "2", "3"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    assert response.status_code == 200

    operation = StructuralOperation.objects.get(pk=response.json()["operation_id"])
    assert operation.undoable is False
    assert operation.shape_before == {}

    refusal = undo(owner_client, response.json()["operation_id"])
    assert refusal.status_code == 409
    assert refusal.json()["code"] == "too_large"


# ---------------------------------------------------------------------------
# Unit-level invariants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        ({"1", "1.2"}, ["1"]),
        ({"1.2", "2.3"}, ["1.2", "2.3"]),
        ({"", "1.2"}, [""]),
        ({"1", "10"}, ["1", "10"]),  # "10" is not under "1" — prefix must respect the dot
    ],
)
def test_reduce_region_roots(paths: set[str], expected: list[str]) -> None:
    assert reduce_region_roots(paths) == expected


@pytest.mark.django_db
def test_every_kind_reverses_through_the_same_code_path(
    project: Project, owner_client: APIClient
) -> None:
    """`kind` is descriptive. If undo ever branches on it, this is the test that says so.

    Each gesture below is recorded under a different kind and reversed by the same
    ``undo_structural_operation`` call the viewset makes, with no per-kind handling.
    """
    seen: set[str] = set()

    tasks = make_tasks(project, ["1", "2", "3"])
    before = shape(project)
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    seen.add(StructuralOperation.objects.get(pk=response.json()["operation_id"]).kind)
    undo(owner_client, response.json()["operation_id"])
    assert shape(project) == before

    target = Task.objects.get(project=project, wbs_path="2")
    act(owner_client, INDENT_URL.format(pk=project.pk, task_id=target.pk))
    before = shape(project)
    response = act(
        owner_client,
        OUTDENT_URL.format(pk=project.pk, task_id=Task.objects.get(wbs_path="1.1").pk),
    )
    seen.add(StructuralOperation.objects.get(pk=response.json()["operation_id"]).kind)
    undo(owner_client, response.json()["operation_id"])
    assert shape(project) == before

    assert seen == {StructuralOperationKind.INDENT, StructuralOperationKind.OUTDENT}


@pytest.mark.django_db
def test_a_no_op_reparent_mints_no_ledger_row(project: Project, owner_client: APIClient) -> None:
    """Offering Undo on a request that changed nothing is a control that does nothing."""
    make_tasks(project, ["1", "1.1"])
    child = Task.objects.get(project=project, wbs_path="1.1")
    parent = Task.objects.get(project=project, wbs_path="1")

    response = act(
        owner_client,
        REPARENT_URL.format(pk=project.pk, task_id=child.pk),
        {"new_parent_id": str(parent.pk)},
    )
    assert response.status_code == 200
    assert response.json()["operation_id"] is None
    assert StructuralOperation.objects.count() == 0


@pytest.mark.django_db
def test_the_purge_uses_the_structural_retention_window(
    project: Project, owner_client: APIClient, settings: Any
) -> None:
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.apps.projects.tasks import _do_purge_expired_batch_operations

    settings.TRUEPPM_STRUCTURAL_OPERATION_RETENTION_DAYS = 7
    tasks = make_tasks(project, ["1", "2"])
    response = act(owner_client, INDENT_URL.format(pk=project.pk, task_id=tasks["2"].pk))
    operation_id = response.json()["operation_id"]

    StructuralOperation.objects.filter(pk=operation_id).update(
        created_at=timezone.now() - timedelta(days=8)
    )
    _do_purge_expired_batch_operations()
    assert not StructuralOperation.objects.filter(pk=operation_id).exists()


def test_max_region_is_a_real_bound() -> None:
    assert isinstance(STRUCTURAL_OPERATION_MAX_REGION, int)
    assert STRUCTURAL_OPERATION_MAX_REGION > 0


@pytest.mark.django_db
def test_undo_of_an_unknown_operation_is_404(project: Project, owner_client: APIClient) -> None:
    assert undo(owner_client, str(uuid.uuid4())).status_code == 404


# ---------------------------------------------------------------------------
# Archived-project floor at the service layer (#3354)
#
# `StructuralOperationViewSet` has carried `IsProjectNotArchived` since it shipped,
# so unlike the four paths #3354 fixed there was never an open hole here, and the
# endpoint case is already covered by `test_undo_is_refused_on_an_archived_project`
# above. What is new is that `undo_structural_operation` repeats the check itself,
# so the floor is uniform across the family and holds for a caller DRF never sees.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_undo_structural_service_refuses_an_archived_project(project: Project) -> None:
    from rest_framework.exceptions import PermissionDenied

    from trueppm_api.apps.projects.structural_operation_services import (
        undo_structural_operation,
    )

    make_tasks(project, ["1", "2"])
    operation = StructuralOperation.objects.create(
        project=project, kind=StructuralOperationKind.INDENT
    )
    project.is_archived = True
    project.save(update_fields=["is_archived"])

    before = shape(project)

    with pytest.raises(PermissionDenied):
        undo_structural_operation(operation)

    # Inert, not merely refused — the other three service tests assert this and
    # this one is the weakest of the four without it.
    assert shape(project) == before
