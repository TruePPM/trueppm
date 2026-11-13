"""Group / Ungroup — the transactional restructure primitives (#2955).

The endpoints exist because the client-side composition of ``create container`` +
N × ``reparent`` is the defect filed as #2914: a partial failure leaves a half-made
phase. So the test that matters most here is not any single happy path — it is
:class:`TestNothingIsWrittenOnFailure`, which asserts that a failure reached *after*
rows have already moved leaves the plan exactly as it was.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    StructureRole,
    Task,
)
from trueppm_api.apps.resources.models import Resource, TaskResource

User = get_user_model()


# ── Fixtures ────────────────────────────────────────────────────────────────────


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def owner(project: Project) -> Any:
    user = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    return user


@pytest.fixture
def client(owner: Any) -> APIClient:
    api = APIClient()
    api.force_authenticate(user=owner)
    return api


def group_url(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/tasks/group/"


def ungroup_url(project: Project) -> str:
    return f"/api/v1/projects/{project.id}/tasks/ungroup/"


def make_task(project: Project, name: str, path: str, **kwargs: Any) -> Task:
    return Task.objects.create(project=project, name=name, wbs_path=path, **kwargs)


def paths(*tasks: Task) -> list[str]:
    for task in tasks:
        task.refresh_from_db()
    return [str(task.wbs_path) for task in tasks]


@pytest.fixture
def flat(project: Project) -> dict[str, Task]:
    """Three root rows — the flat list the whole feature exists to structure."""
    return {
        "a": make_task(project, "A", "1", duration=1),
        "b": make_task(project, "B", "2", duration=2),
        "c": make_task(project, "C", "3", duration=3),
    }


# ── Group: the happy path and the selection rules ───────────────────────────────


@pytest.mark.django_db
class TestGroup:
    def test_wraps_the_selection_at_the_first_row_s_position(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        """The phase lands where the first wrapped row was, not appended at the end.

        Appending would move the work to the bottom of the plan as a side effect of
        naming it, which is the opposite of what "wrap what I selected" means.
        """
        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["b"].id)], "name": "Discovery"},
            format="json",
        )
        assert response.status_code == 200, response.data

        container = response.data["container"]
        assert container["name"] == "Discovery"
        assert container["wbs_path"] == "1"
        assert container["parent_id"] is None
        assert response.data["left_alone"] == []
        assert response.data["grouped_ids"] == [str(flat["a"].id), str(flat["b"].id)]
        assert paths(flat["a"], flat["b"], flat["c"]) == ["1.1", "1.2", "2"]

    def test_container_is_a_declared_container_not_an_inferred_one(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        """#2950: a grouped phase is declared, so losing its last row never demotes it.

        ``auto_container`` is the discriminator. Set, the row would silently revert to
        work the moment someone moved its last task out — the retroactive identity
        change ``structure_role`` exists to remove.
        """
        response = client.post(group_url(project), {"task_ids": [str(flat["a"].id)]}, format="json")
        assert response.status_code == 200, response.data

        container = Task.objects.get(pk=response.data["container"]["id"])
        assert container.structure_role == StructureRole.CONTAINER
        assert container.auto_container is False
        assert response.data["container"]["structure_role"] == StructureRole.CONTAINER

    def test_name_is_optional_and_falls_back_to_a_placeholder(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        """The design names the phase *last*, so the request need not carry a name."""
        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["b"].id)], "name": None},
            format="json",
        )
        assert response.status_code == 200, response.data
        assert response.data["container"]["name"] == "New phase"

    def test_wrapped_rows_bring_their_own_subtrees(
        self, client: APIClient, project: Project
    ) -> None:
        """Wrapping a phase moves the work inside it, at the same relative depth."""
        outer = make_task(project, "Outer", "1")
        inner = make_task(project, "Inner", "1.1")
        deep = make_task(project, "Deep", "1.1.1")
        tail = make_task(project, "Tail", "2")

        response = client.post(group_url(project), {"task_ids": [str(outer.id)]}, format="json")
        assert response.status_code == 200, response.data
        assert paths(outer, inner, deep, tail) == ["1.1", "1.1.1", "1.1.1.1", "2"]

    def test_renumbered_siblings_carry_their_children_with_them(
        self, client: APIClient, project: Project
    ) -> None:
        """The regression this endpoint must not repeat.

        Removing rows from the middle of a level shifts every later sibling's number,
        and a sibling's descendants carry that number as a path *prefix*. Renumbering
        the sibling alone strands its subtree at the old prefix — a silently corrupt
        tree rather than a visible error.
        """
        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")
        third = make_task(project, "Third", "3")
        third_child = make_task(project, "Third child", "3.1")
        third_grandchild = make_task(project, "Third grandchild", "3.1.1")

        response = client.post(
            group_url(project),
            {"task_ids": [str(first.id), str(second.id)]},
            format="json",
        )
        assert response.status_code == 200, response.data

        assert paths(third, third_child, third_grandchild) == ["2", "2.1", "2.1.1"]

    def test_a_level_numbered_with_gaps_still_gets_a_free_staging_slot(
        self, client: APIClient, project: Project
    ) -> None:
        """``len(siblings) + 1`` is not a free position on a level with gaps.

        A level left as ``1, 3`` by an earlier delete has two rows, and position 2 is
        free while position 3 is occupied — so a staging slot derived from the count
        would collide with a live row and corrupt the prefix match that moves its
        children.
        """
        first = make_task(project, "First", "1")
        third = make_task(project, "Third", "3")
        third_child = make_task(project, "Third child", "3.1")

        response = client.post(group_url(project), {"task_ids": [str(first.id)]}, format="json")
        assert response.status_code == 200, response.data
        assert paths(first, third, third_child) == ["1.1", "2", "2.1"]

    def test_selection_spanning_two_parents_groups_on_the_majority(
        self, client: APIClient, project: Project
    ) -> None:
        """A selection spanning levels is a shift-click, not a mistake to reject.

        The majority parent is the level the user was working in; the stragglers are
        reported so the UI can say which rows it left alone.
        """
        phase = make_task(project, "Phase", "1")
        inside_one = make_task(project, "Inside one", "1.1")
        inside_two = make_task(project, "Inside two", "1.2")
        outside = make_task(project, "Outside", "2")

        response = client.post(
            group_url(project),
            {
                "task_ids": [str(inside_one.id), str(inside_two.id), str(outside.id)],
                "name": "Sub-phase",
            },
            format="json",
        )
        assert response.status_code == 200, response.data

        assert response.data["container"]["parent_id"] == str(phase.id)
        assert response.data["grouped_ids"] == [str(inside_one.id), str(inside_two.id)]
        assert response.data["left_alone"] == [
            {"id": str(outside.id), "reason": "different_parent", "ancestor_id": None}
        ]
        assert paths(outside) == ["2"]

    def test_a_row_inside_a_selected_row_is_dropped_and_named(
        self, client: APIClient, project: Project
    ) -> None:
        """You cannot wrap a phase together with the work inside it.

        The response has to *say* which rows it skipped and why — a group that quietly
        wrapped three of your five rows reads as a bug, not as a rule.
        """
        phase = make_task(project, "Phase", "1")
        inside = make_task(project, "Inside", "1.1")
        deeper = make_task(project, "Deeper", "1.1.1")
        peer = make_task(project, "Peer", "2")

        response = client.post(
            group_url(project),
            {"task_ids": [str(phase.id), str(inside.id), str(deeper.id), str(peer.id)]},
            format="json",
        )
        assert response.status_code == 200, response.data

        assert response.data["grouped_ids"] == [str(phase.id), str(peer.id)]
        left = {entry["id"]: entry for entry in response.data["left_alone"]}
        assert set(left) == {str(inside.id), str(deeper.id)}
        assert left[str(inside.id)]["reason"] == "ancestor_selected"
        assert left[str(inside.id)]["ancestor_id"] == str(phase.id)
        # The NEAREST selected ancestor, not the outermost — the row is inside `inside`,
        # and naming `phase` would point the user at the wrong phase.
        assert left[str(deeper.id)]["ancestor_id"] == str(inside.id)

    def test_selecting_only_a_phase_and_its_contents_is_rejected(
        self, client: APIClient, project: Project
    ) -> None:
        """After the drop rule there is one row left, and it is already a phase."""
        phase = make_task(project, "Phase", "1")
        inside = make_task(project, "Inside", "1.1")

        response = client.post(
            group_url(project),
            {"task_ids": [str(phase.id), str(inside.id)]},
            format="json",
        )
        # One row survives the drop rule, so this is a legal single-row wrap.
        assert response.status_code == 200, response.data
        assert response.data["grouped_ids"] == [str(phase.id)]
        assert response.data["left_alone"][0]["id"] == str(inside.id)

    def test_a_duplicated_id_is_one_row_not_two(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["a"].id)]},
            format="json",
        )
        assert response.status_code == 200, response.data
        assert response.data["grouped_ids"] == [str(flat["a"].id)]


@pytest.mark.django_db
class TestGroupRejections:
    """Every refusal is a 4xx with a machine code — never a 500, never a silent no-op."""

    @pytest.mark.parametrize(
        ("body", "code"),
        [
            ({}, "invalid_task_ids"),
            ({"task_ids": []}, "invalid_task_ids"),
            ({"task_ids": "not-a-list"}, "invalid_task_ids"),
            ({"task_ids": [None]}, "invalid_task_ids"),
            ({"task_ids": [{"id": 1}]}, "invalid_task_ids"),
            ({"task_ids": ["not-a-uuid"]}, "invalid_task_ids"),
        ],
    )
    def test_malformed_task_ids_are_400(
        self, client: APIClient, project: Project, body: dict[str, Any], code: str
    ) -> None:
        response = client.post(group_url(project), body, format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == code

    def test_a_non_object_body_is_400_not_500(self, client: APIClient, project: Project) -> None:
        """A list body has no ``.get``; reaching for one is a 500 (#2795)."""
        response = client.post(group_url(project), [1, 2], format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == "invalid_body"

    def test_a_non_string_name_is_400(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id)], "name": {"nested": "object"}},
            format="json",
        )
        assert response.status_code == 400, response.data
        assert response.data["code"] == "invalid_name"

    def test_a_task_from_another_project_is_404(
        self, client: APIClient, project: Project, calendar: Calendar
    ) -> None:
        """Not 403: the id must not confirm the row exists somewhere else (IDOR)."""
        other = Project.objects.create(name="Beta", start_date=date(2026, 3, 2), calendar=calendar)
        foreign = make_task(other, "Foreign", "1")

        response = client.post(group_url(project), {"task_ids": [str(foreign.id)]}, format="json")
        assert response.status_code == 404, response.data
        assert response.data["code"] == "unknown_task"
        assert str(foreign.id) in response.data["unknown"]

    def test_a_subtask_cannot_be_wrapped_in_a_phase(
        self, client: APIClient, project: Project
    ) -> None:
        """Phases group work; a subtask belongs to its parent task, not to a phase."""
        parent = make_task(project, "Parent", "1")
        subtask = make_task(project, "Subtask", "1.1", is_subtask=True)

        response = client.post(group_url(project), {"task_ids": [str(subtask.id)]}, format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == "cannot_group_subtasks"
        assert paths(parent, subtask) == ["1", "1.1"]

    def test_a_selection_past_the_cap_is_refused_before_anything_moves(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        from trueppm_api.apps.projects.task_grouping import MAX_GROUP_SELECTION

        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id)] * (MAX_GROUP_SELECTION + 1)},
            format="json",
        )
        assert response.status_code == 400, response.data
        assert response.data["code"] == "selection_too_large"
        assert Task.objects.filter(project=project).count() == 3


# ── Ungroup ─────────────────────────────────────────────────────────────────────


@pytest.mark.django_db
class TestUngroup:
    def test_lifts_children_in_place_and_deletes_only_the_wrapper(
        self, client: APIClient, project: Project
    ) -> None:
        phase = make_task(project, "Phase", "2")
        first = make_task(project, "First", "2.1")
        second = make_task(project, "Second", "2.2")
        before = make_task(project, "Before", "1")
        after = make_task(project, "After", "3")

        response = client.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        assert response.status_code == 200, response.data
        assert response.data["container_id"] == str(phase.id)
        assert response.data["lifted_ids"] == [str(first.id), str(second.id)]

        assert paths(before, first, second, after) == ["1", "2", "3", "4"]
        phase.refresh_from_db()
        assert phase.is_deleted is True

    def test_lifted_rows_keep_links_owners_and_estimates(
        self, client: APIClient, project: Project, owner: Any
    ) -> None:
        """ "Only the wrapper goes" — nothing about a lifted row is rewritten but its path.

        Asserted on the three things a planner would actually notice losing: the
        dependency edges between the rows, the people assigned to them, and their
        estimates.
        """
        phase = make_task(project, "Phase", "1")
        first = make_task(project, "First", "1.1", duration=5, assignee=owner)
        second = make_task(project, "Second", "1.2", duration=8)
        outside = make_task(project, "Outside", "2")

        inner_edge = Dependency.objects.create(predecessor=first, successor=second)
        crossing_edge = Dependency.objects.create(predecessor=second, successor=outside)
        resource = Resource.objects.create(name="Alice")
        TaskResource.objects.create(task=first, resource=resource, units=1.0)

        response = client.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        assert response.status_code == 200, response.data
        assert response.data["removed_dependency_ids"] == []

        inner_edge.refresh_from_db()
        crossing_edge.refresh_from_db()
        assert inner_edge.is_deleted is False
        assert crossing_edge.is_deleted is False

        first.refresh_from_db()
        second.refresh_from_db()
        assert first.duration == 5
        assert second.duration == 8
        assert first.assignee_id == owner.pk
        assert TaskResource.objects.filter(task=first, resource=resource).exists()

    def test_edges_on_the_wrapper_itself_are_reported_not_silently_dropped(
        self, client: APIClient, project: Project
    ) -> None:
        """The wrapper's own links go with the wrapper, as they do for any delete.

        Reporting them is the difference between "the phase's links were removed" and
        links that vanish with no trace for the user to notice.
        """
        phase = make_task(project, "Phase", "1")
        make_task(project, "Inside", "1.1")
        neighbor = make_task(project, "Neighbor", "2")
        wrapper_edge = Dependency.objects.create(predecessor=neighbor, successor=phase)

        response = client.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        assert response.status_code == 200, response.data
        assert response.data["removed_dependency_ids"] == [str(wrapper_edge.id)]
        wrapper_edge.refresh_from_db()
        assert wrapper_edge.is_deleted is True

    def test_dissolving_an_empty_phase_removes_just_that_row(
        self, client: APIClient, project: Project
    ) -> None:
        """A declared container with nothing in it is legal (#2950) and dissolvable."""
        empty = make_task(project, "Empty", "1", structure_role=StructureRole.CONTAINER)
        neighbor = make_task(project, "Neighbor", "2")

        response = client.post(ungroup_url(project), {"task_id": str(empty.id)}, format="json")
        assert response.status_code == 200, response.data
        assert response.data["lifted_ids"] == []
        assert paths(neighbor) == ["1"]

    def test_a_phase_carrying_subtasks_is_refused_rather_than_deleting_them(
        self, client: APIClient, project: Project
    ) -> None:
        """``Task.soft_delete`` cascades to subtasks — so dissolving would delete work.

        Refusing is the only outcome that keeps "only the wrapper goes" true.
        """
        phase = make_task(project, "Phase", "1")
        subtask = make_task(project, "Subtask", "1.1", is_subtask=True)

        response = client.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == "container_has_subtasks"

        phase.refresh_from_db()
        subtask.refresh_from_db()
        assert phase.is_deleted is False
        assert subtask.is_deleted is False

    def test_a_subtask_is_not_a_phase(self, client: APIClient, project: Project) -> None:
        make_task(project, "Parent", "1")
        subtask = make_task(project, "Subtask", "1.1", is_subtask=True)

        response = client.post(ungroup_url(project), {"task_id": str(subtask.id)}, format="json")
        assert response.status_code == 400, response.data
        assert response.data["code"] == "cannot_ungroup_subtask"

    @pytest.mark.parametrize(
        ("body", "code", "expected_status"),
        [
            ({}, "invalid_task_id", 400),
            ({"task_id": 7}, "invalid_task_id", 400),
            ({"task_id": "not-a-uuid"}, "invalid_task_id", 400),
            ({"task_id": "00000000-0000-0000-0000-000000000000"}, "unknown_task", 404),
        ],
    )
    def test_malformed_and_unknown_ids(
        self,
        client: APIClient,
        project: Project,
        body: dict[str, Any],
        code: str,
        expected_status: int,
    ) -> None:
        response = client.post(ungroup_url(project), body, format="json")
        assert response.status_code == expected_status, response.data
        assert response.data["code"] == code


@pytest.mark.django_db
class TestGroupAndUngroupAreInverses:
    def test_ungroup_restores_the_layout_group_produced_it_from(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        """The property that makes ⌘Z honest without a second ledger.

        Group's inverse is ungroup, so undoing a group is one request rather than a
        client-side replay of N moves. It is *not* lossless in the other direction —
        ungroup deletes the wrapper, so a later group mints a new row with a new id —
        which is why an undo of an ungroup still needs a recorded operation.
        """
        before = paths(flat["a"], flat["b"], flat["c"])

        grouped = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["b"].id)], "name": "Phase"},
            format="json",
        )
        assert grouped.status_code == 200, grouped.data

        ungrouped = client.post(
            ungroup_url(project),
            {"task_id": grouped.data["container"]["id"]},
            format="json",
        )
        assert ungrouped.status_code == 200, ungrouped.data
        assert paths(flat["a"], flat["b"], flat["c"]) == before


# ── The reason the endpoint exists ──────────────────────────────────────────────


@pytest.mark.django_db
class TestNothingIsWrittenOnFailure:
    """A failure reached after rows have moved must leave the plan untouched.

    This is the whole argument for a server endpoint over N client calls (#2914). Both
    tests fail the operation at the *last* step — after the container is minted, after
    every row has been reparented, after the level has been renumbered — which is the
    exact window in which a client-side composition strands a half-made phase.
    """

    def test_a_rejection_after_the_writes_rolls_all_of_them_back(
        self, client: APIClient, project: Project, flat: dict[str, Task], monkeypatch: Any
    ) -> None:
        from trueppm_api.apps.projects import task_grouping

        def reject(*_args: Any, **_kwargs: Any) -> None:
            raise task_grouping.GroupingRejected("cyclic_dependency", "nope")

        monkeypatch.setattr(task_grouping, "assert_graph_feasible", reject)

        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["b"].id)], "name": "Doomed"},
            format="json",
        )
        assert response.status_code == 400, response.data
        assert response.data["code"] == "cyclic_dependency"

        assert paths(flat["a"], flat["b"], flat["c"]) == ["1", "2", "3"]
        assert not Task.objects.filter(project=project, name="Doomed").exists()
        assert Task.objects.filter(project=project, is_deleted=False).count() == 3

    def test_an_unexpected_error_after_the_writes_rolls_all_of_them_back(
        self, client: APIClient, project: Project, flat: dict[str, Task], monkeypatch: Any
    ) -> None:
        """Not only *modeled* refusals roll back — the transaction covers a bug too."""
        from trueppm_api.apps.projects import task_grouping

        def explode(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("engine unavailable")

        monkeypatch.setattr(task_grouping, "assert_graph_feasible", explode)

        with pytest.raises(RuntimeError):
            client.post(
                group_url(project),
                {"task_ids": [str(flat["a"].id), str(flat["b"].id)], "name": "Doomed"},
                format="json",
            )

        assert paths(flat["a"], flat["b"], flat["c"]) == ["1", "2", "3"]
        assert not Task.objects.filter(project=project, name="Doomed").exists()

    def test_ungroup_rolls_back_the_lift_and_the_wrapper_delete_together(
        self, client: APIClient, project: Project, monkeypatch: Any
    ) -> None:
        """Half of an ungroup is worse than none: rows lifted, wrapper still there."""
        from trueppm_api.apps.projects import task_grouping

        phase = make_task(project, "Phase", "1")
        first = make_task(project, "First", "1.1")
        second = make_task(project, "Second", "1.2")

        def reject(*_args: Any, **_kwargs: Any) -> None:
            raise task_grouping.GroupingRejected("cyclic_dependency", "nope")

        monkeypatch.setattr(task_grouping, "assert_graph_feasible", reject)

        response = client.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        assert response.status_code == 400, response.data

        assert paths(phase, first, second) == ["1", "1.1", "1.2"]
        phase.refresh_from_db()
        assert phase.is_deleted is False


# ── The ADR-0259 graph guard ────────────────────────────────────────────────────


@pytest.mark.django_db
class TestGraphGuard:
    """The guard runs, refuses an infeasible post-state, and refuses to blame this
    operation for an infeasibility that was already there."""

    def test_an_infeasible_post_state_is_refused(self, project: Project) -> None:
        from trueppm_api.apps.projects.task_grouping import (
            GroupingRejected,
            assert_graph_feasible,
            capture_graph_state,
        )

        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")
        healthy = capture_graph_state(str(project.id))

        Dependency.objects.create(predecessor=first, successor=second)
        Dependency.objects.create(predecessor=second, successor=first)

        with pytest.raises(GroupingRejected) as caught:
            assert_graph_feasible(str(project.id), healthy)
        assert caught.value.code == "cyclic_dependency"
        assert "No rows were moved" in caught.value.detail

    def test_the_refusal_chains_the_guard_s_own_exception_as_its_cause(
        self, project: Project
    ) -> None:
        """``raise ... from`` must carry the guard's error, not ``None`` and not a lie.

        The cause is what a reader of the traceback (and Sentry) gets to explain *why*
        the graph is infeasible — ``GroupingRejected`` itself only says that it is.
        Asserted because the chaining was previously fed from a nullable return, which
        would raise ``TypeError`` at the ``raise`` if it ever came back ``None``.
        """
        from trueppm_scheduler import InvalidScheduleInput

        from trueppm_api.apps.projects.task_grouping import (
            GroupingRejected,
            assert_graph_feasible,
            capture_graph_state,
        )
        from trueppm_api.apps.scheduling.graph_guard import InfeasibleGraphError

        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")
        healthy = capture_graph_state(str(project.id))

        Dependency.objects.create(predecessor=first, successor=second)
        Dependency.objects.create(predecessor=second, successor=first)

        with pytest.raises(GroupingRejected) as caught:
            assert_graph_feasible(str(project.id), healthy)

        cause = caught.value.__cause__
        assert isinstance(cause, InfeasibleGraphError | InvalidScheduleInput)

    def test_a_pre_existing_cycle_is_not_this_operation_s_to_refuse(self, project: Project) -> None:
        """Otherwise a project that arrived cyclic could never be restructured to fix it.

        Same doctrine as ``tasks/bulk`` (ADR-0772 §4): a condition this write did not
        introduce and cannot clear by refusing itself is not grounds for refusing.
        """
        from trueppm_api.apps.projects.task_grouping import (
            assert_graph_feasible,
            capture_graph_state,
        )

        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")
        Dependency.objects.create(predecessor=first, successor=second)
        Dependency.objects.create(predecessor=second, successor=first)

        already_broken = capture_graph_state(str(project.id))
        assert_graph_feasible(str(project.id), already_broken)  # does not raise

    def test_a_project_that_is_already_cyclic_can_still_be_restructured(
        self, client: APIClient, project: Project
    ) -> None:
        """The end-to-end consequence of the rule above."""
        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")
        Dependency.objects.create(predecessor=first, successor=second)
        Dependency.objects.create(predecessor=second, successor=first)

        response = client.post(
            group_url(project),
            {"task_ids": [str(first.id), str(second.id)], "name": "Tangle"},
            format="json",
        )
        assert response.status_code == 200, response.data

    def test_grouping_preserves_every_summary_s_leaf_set(
        self, client: APIClient, project: Project
    ) -> None:
        """The property that makes the guard a tripwire rather than a gate.

        ``find_cycle`` resolves each edge endpoint to its *leaf* descendants, so a
        restructure can only change the verdict by changing some summary's leaf set.
        Group inserts a container between a parent and rows already beneath it, which
        does not. Pinned as a test so a later change to what a container may carry
        breaks here rather than silently in the scheduler.
        """
        from trueppm_scheduler.engine import _collect_leaves

        from trueppm_api.apps.projects.serializers import (
            _load_project_tasks_and_children_map,
        )

        phase = make_task(project, "Phase", "1")
        one = make_task(project, "One", "1.1")
        two = make_task(project, "Two", "1.2")
        three = make_task(project, "Three", "1.3")

        _, before_map = _load_project_tasks_and_children_map(project.id)
        leaves_before = set(_collect_leaves(str(phase.id), before_map))
        assert leaves_before == {str(one.id), str(two.id), str(three.id)}

        response = client.post(
            group_url(project),
            {"task_ids": [str(one.id), str(two.id)], "name": "Inner"},
            format="json",
        )
        assert response.status_code == 200, response.data

        _, after_map = _load_project_tasks_and_children_map(project.id)
        assert set(_collect_leaves(str(phase.id), after_map)) == leaves_before


# ── RBAC — all five roles, both endpoints ───────────────────────────────────────


ROLE_MAY_RESTRUCTURE = [
    # (role, may group/ungroup rows they do not own)
    (Role.VIEWER, False),
    (Role.MEMBER, False),
    # ADR-0773: the resource-management band is excluded from plan authoring outright,
    # rather than being allowed to restructure a plan it then cannot edit a row of.
    (Role.SCHEDULER, False),
    (Role.ADMIN, True),
    (Role.OWNER, True),
]


@pytest.mark.django_db
@pytest.mark.parametrize(("role", "allowed"), ROLE_MAY_RESTRUCTURE)
class TestRoles:
    @staticmethod
    def _client_for(project: Project, role: int) -> APIClient:
        user = User.objects.create_user(username=f"role{int(role)}", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        api = APIClient()
        api.force_authenticate(user=user)
        return api

    def test_group(self, project: Project, role: int, allowed: bool) -> None:
        api = self._client_for(project, role)
        first = make_task(project, "First", "1")
        second = make_task(project, "Second", "2")

        response = api.post(
            group_url(project),
            {"task_ids": [str(first.id), str(second.id)], "name": "Phase"},
            format="json",
        )
        if allowed:
            assert response.status_code == 200, response.data
        else:
            assert response.status_code == 403, response.data
            assert paths(first, second) == ["1", "2"]
            assert Task.objects.filter(project=project, name="Phase").count() == 0

    def test_ungroup(self, project: Project, role: int, allowed: bool) -> None:
        api = self._client_for(project, role)
        phase = make_task(project, "Phase", "1")
        inside = make_task(project, "Inside", "1.1")

        response = api.post(ungroup_url(project), {"task_id": str(phase.id)}, format="json")
        if allowed:
            assert response.status_code == 200, response.data
            assert paths(inside) == ["1"]
        else:
            assert response.status_code == 403, response.data
            phase.refresh_from_db()
            assert phase.is_deleted is False
            assert paths(inside) == ["1.1"]


@pytest.mark.django_db
class TestMemberScopedAuthority:
    """A Member restructures their own assigned rows and nobody else's (ADR-0133)."""

    @staticmethod
    def _member(project: Project) -> Any:
        user = User.objects.create_user(username="member", password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
        return user

    def test_a_member_may_wrap_their_own_rows(self, project: Project) -> None:
        member = self._member(project)
        api = APIClient()
        api.force_authenticate(user=member)
        mine = make_task(project, "Mine", "1", assignee=member)
        also_mine = make_task(project, "Also mine", "2", assignee=member)

        response = api.post(
            group_url(project),
            {"task_ids": [str(mine.id), str(also_mine.id)], "name": "Mine"},
            format="json",
        )
        assert response.status_code == 200, response.data

    def test_one_foreign_row_in_the_selection_refuses_the_whole_operation(
        self, project: Project
    ) -> None:
        """Partial application is exactly what this endpoint exists to prevent."""
        member = self._member(project)
        api = APIClient()
        api.force_authenticate(user=member)
        mine = make_task(project, "Mine", "1", assignee=member)
        theirs = make_task(project, "Theirs", "2")

        response = api.post(
            group_url(project),
            {"task_ids": [str(mine.id), str(theirs.id)], "name": "Phase"},
            format="json",
        )
        assert response.status_code == 403, response.data
        assert paths(mine, theirs) == ["1", "2"]
        assert not Task.objects.filter(project=project, name="Phase").exists()


@pytest.mark.django_db
class TestProjectScoping:
    def test_a_non_member_gets_403(self, project: Project, flat: dict[str, Task]) -> None:
        stranger = User.objects.create_user(username="stranger", password="pw")
        api = APIClient()
        api.force_authenticate(user=stranger)

        for url, body in (
            (group_url(project), {"task_ids": [str(flat["a"].id)]}),
            (ungroup_url(project), {"task_id": str(flat["a"].id)}),
        ):
            assert api.post(url, body, format="json").status_code in (403, 404)

    def test_anonymous_is_401(self, project: Project, flat: dict[str, Task]) -> None:
        api = APIClient()
        assert (
            api.post(
                group_url(project), {"task_ids": [str(flat["a"].id)]}, format="json"
            ).status_code
            == 401
        )

    def test_an_archived_project_refuses_both(
        self, client: APIClient, project: Project, flat: dict[str, Task]
    ) -> None:
        project.is_archived = True
        project.save(update_fields=["is_archived"])

        response = client.post(group_url(project), {"task_ids": [str(flat["a"].id)]}, format="json")
        assert response.status_code == 403, response.data


# ── Post-commit side effects ────────────────────────────────────────────────────


@pytest.mark.django_db(transaction=True)
class TestBroadcastAndRecalc:
    def test_group_broadcasts_and_recalculates_after_commit(
        self, client: APIClient, project: Project, flat: dict[str, Task], monkeypatch: Any
    ) -> None:
        """Deferred to ``on_commit``: a broadcast that outran its own rollback would
        tell every collaborator about a phase that does not exist."""
        from trueppm_api.apps.projects import views
        from trueppm_api.apps.sync import broadcast as broadcast_module

        events: list[tuple[str, str]] = []
        recalcs: list[str] = []
        monkeypatch.setattr(
            broadcast_module,
            "broadcast_board_event",
            lambda pid, event, _payload: events.append((str(pid), event)),
        )
        monkeypatch.setattr(
            views, "_enqueue_recalculate", lambda pid, **_kw: recalcs.append(str(pid))
        )

        response = client.post(
            group_url(project),
            {"task_ids": [str(flat["a"].id), str(flat["b"].id)]},
            format="json",
        )
        assert response.status_code == 200, response.data
        assert (str(project.id), "tasks_restructured") in events
        assert str(project.id) in recalcs
