"""Writes that leave a graph the recalculation refuses are refused (#4828, #5046).

``DependencySerializer`` asks the engine about an edge when the edge is written
(#4456). These tests cover the writers that change the graph without writing an edge:
indent, outdent and reparent change which tasks are summaries (#4828), and a status or
type change moves a task into or out of the committed set the CPM feed reads (#5046).
Each refusal asserts nothing moved; each has an allowed neighbor so the guard is not
simply refusing every move.
"""

from __future__ import annotations

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from trueppm_scheduler import InvalidScheduleInput

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.msproject.dataclasses import PredecessorLinkData, ProjectData, TaskData
from trueppm_api.apps.msproject.importer import build_children_map, expansion_refusal
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.projects.project_templates import (
    TemplateStructureError,
    _validate_dependency_graph,
)
from trueppm_api.apps.projects.summary_link_guard import (
    UNSCHEDULABLE_CHANGE_CODE,
    recalc_transition_block,
)
from trueppm_api.apps.projects.task_grouping import (
    GroupingRejected,
    assert_graph_feasible,
    capture_graph_state,
)
from trueppm_api.apps.scheduling.graph_guard import recalc_refusal, validate_graph_transition

User = get_user_model()

INDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/indent/"
OUTDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/outdent/"
REPARENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/reparent/"


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Guard", start_date=date(2026, 1, 5), calendar=cal)


@pytest.fixture
def owner_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="owner", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _task(project: Project, name: str, path: str, **extra: Any) -> Task:
    return Task.objects.create(project=project, name=name, duration=2, wbs_path=path, **extra)


def _link(pred: Task, succ: Task, dep_type: str) -> Dependency:
    return Dependency.objects.create(predecessor=pred, successor=succ, dep_type=dep_type)


def _send(client: APIClient, method: str, url: str, body: Any = None) -> tuple[Any, Any]:
    with (
        patch("django.db.transaction.on_commit", side_effect=lambda fn, *a, **kw: fn()),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
    ):
        response = getattr(client, method)(url, body if body is not None else {}, format="json")
    return response, broadcast


def _outline(project: Project) -> dict[str, str]:
    return {
        name: str(path)
        for name, path in Task.objects.filter(project=project, is_deleted=False).values_list(
            "name", "wbs_path"
        )
    }


# ---------------------------------------------------------------------------
# The pure differential
# ---------------------------------------------------------------------------


def test_recalc_refusal_sees_a_mixed_type_leaf_pair_collision() -> None:
    children = {"S": ["A", "B"]}
    assert recalc_refusal([("S", "C", "FS"), ("B", "C", "FS")], children) is None
    failure = recalc_refusal([("S", "C", "FS"), ("B", "C", "FF")], children)
    assert isinstance(failure, InvalidScheduleInput)
    assert "different types" in str(failure)


def test_transition_is_refused_only_when_it_introduces_the_failure() -> None:
    edges = [("S", "C", "FS"), ("B", "C", "FF")]
    with pytest.raises(InvalidScheduleInput):
        validate_graph_transition((edges, {"S": ["A"]}), (edges, {"S": ["A", "B"]}))
    # Already broken before the write: the repair path stays open.
    validate_graph_transition((edges, {"S": ["A", "B"]}), (edges, {"S": ["A", "B"]}))


def _move(task: Task, path: str) -> None:
    """Write a restructure the way the grouping/undo paths do: wbs_path only."""
    Task.objects.filter(pk=task.pk).update(wbs_path=path)


@pytest.mark.django_db
@pytest.mark.parametrize(("leaf_type", "refused"), [("FS", False), ("FF", True)])
def test_undo_and_grouping_guard_is_type_aware(
    project: Project, leaf_type: str, refused: bool
) -> None:
    """Structural undo restores edges through this guard; pairs alone passed it (#4828)."""
    tasks = _reparent_setup(project, leaf_type)
    before = capture_graph_state(project.pk)
    _move(tasks["B"], "1.2")
    if refused:
        with pytest.raises(GroupingRejected):
            assert_graph_feasible(project.pk, before)
    else:
        assert_graph_feasible(project.pk, before)


@pytest.mark.django_db
def test_grouping_guard_ignores_a_backlog_leaf_the_engine_does_not_schedule(
    project: Project,
) -> None:
    """``Phase -FS-> X`` and backlog ``B1 -FF-> X``: B1 is no child of Phase to the CPM.

    Expanding over every row refused moving B1 under Phase; the recalculation accepts it.
    """
    phase = _task(project, "Phase", "1")
    _task(project, "A", "1.1")
    b1 = _task(project, "B1", "2", status=TaskStatus.BACKLOG)
    x = _task(project, "X", "3")
    _link(phase, x, "FS")
    _link(b1, x, "FF")
    before = capture_graph_state(project.pk)
    _move(b1, "1.2")
    assert_graph_feasible(project.pk, before)


@pytest.mark.django_db
def test_a_pre_state_failing_only_on_a_backlog_leaf_does_not_switch_the_guard_off(
    project: Project,
) -> None:
    """Expanded over every row this project already "fails" (backlog B1 under Phase),
    which disabled the differential; to the engine it is clean, so C's collision is new.
    """
    phase = _task(project, "Phase", "1")
    _task(project, "A", "1.1")
    b1 = _task(project, "B1", "1.2", status=TaskStatus.BACKLOG)
    c = _task(project, "C", "2")
    x = _task(project, "X", "3")
    _link(phase, x, "FS")
    _link(b1, x, "FF")
    _link(c, x, "FF")
    before = capture_graph_state(project.pk)
    _move(c, "1.3")
    with pytest.raises(GroupingRejected):
        assert_graph_feasible(project.pk, before)


# ---------------------------------------------------------------------------
# Indent / outdent / reparent (#4828)
# ---------------------------------------------------------------------------


def _reparent_setup(project: Project, leaf_type: str) -> dict[str, Task]:
    """``S{A} -FS-> C`` and ``B -<leaf_type>-> C``; moving B under S joins the pairs."""
    tasks = {
        "S": _task(project, "S", "1"),
        "A": _task(project, "A", "1.1"),
        "B": _task(project, "B", "2"),
        "C": _task(project, "C", "3"),
    }
    _link(tasks["S"], tasks["C"], "FS")
    _link(tasks["B"], tasks["C"], leaf_type)
    return tasks


@pytest.mark.django_db
def test_reparent_that_creates_a_mixed_type_collision_is_refused(
    project: Project, owner_client: APIClient
) -> None:
    t = _reparent_setup(project, "FF")
    before = _outline(project)
    response, broadcast = _send(
        owner_client,
        "post",
        REPARENT_URL.format(pk=project.pk, task_id=t["B"].pk),
        {"new_parent_id": str(t["S"].pk)},
    )
    assert response.status_code == 400, response.content
    assert response.data["code"] == UNSCHEDULABLE_CHANGE_CODE
    assert "“B”" in response.data["detail"] and "“C”" in response.data["detail"]
    assert _outline(project) == before
    broadcast.assert_not_called()


@pytest.mark.django_db
def test_reparent_with_same_typed_links_is_allowed(
    project: Project, owner_client: APIClient
) -> None:
    t = _reparent_setup(project, "FS")
    response, _ = _send(
        owner_client,
        "post",
        REPARENT_URL.format(pk=project.pk, task_id=t["B"].pk),
        {"new_parent_id": str(t["S"].pk)},
    )
    assert response.status_code == 200, response.content
    assert _outline(project)["B"].startswith("1.")


@pytest.mark.django_db
def test_indent_that_creates_a_mixed_type_collision_is_refused(
    project: Project, owner_client: APIClient
) -> None:
    t = _reparent_setup(project, "SS")
    before = _outline(project)
    response, broadcast = _send(
        owner_client, "post", INDENT_URL.format(pk=project.pk, task_id=t["B"].pk)
    )
    assert response.status_code == 400, response.content
    assert response.data["code"] == UNSCHEDULABLE_CHANGE_CODE
    assert _outline(project) == before
    broadcast.assert_not_called()


@pytest.mark.django_db
def test_indent_with_same_typed_links_is_allowed(project: Project, owner_client: APIClient) -> None:
    t = _reparent_setup(project, "FS")
    response, _ = _send(owner_client, "post", INDENT_URL.format(pk=project.pk, task_id=t["B"].pk))
    assert response.status_code == 200, response.content


def _outdent_setup(project: Project, follower_type: str) -> dict[str, Task]:
    """Outdenting T adopts its follower F: ``T{F} -FS-> C`` beside ``F -<type>-> C``."""
    tasks = {
        "P": _task(project, "P", "1"),
        "T": _task(project, "T", "1.1"),
        "F": _task(project, "F", "1.2"),
        "C": _task(project, "C", "2"),
    }
    _link(tasks["T"], tasks["C"], "FS")
    _link(tasks["F"], tasks["C"], follower_type)
    return tasks


@pytest.mark.django_db
def test_outdent_that_creates_a_mixed_type_collision_is_refused(
    project: Project, owner_client: APIClient
) -> None:
    t = _outdent_setup(project, "FF")
    before = _outline(project)
    response, broadcast = _send(
        owner_client, "post", OUTDENT_URL.format(pk=project.pk, task_id=t["T"].pk)
    )
    assert response.status_code == 400, response.content
    assert response.data["code"] == UNSCHEDULABLE_CHANGE_CODE
    assert _outline(project) == before
    broadcast.assert_not_called()


@pytest.mark.django_db
def test_outdent_with_same_typed_links_is_allowed(
    project: Project, owner_client: APIClient
) -> None:
    t = _outdent_setup(project, "FS")
    response, _ = _send(owner_client, "post", OUTDENT_URL.format(pk=project.pk, task_id=t["T"].pk))
    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_a_move_in_an_already_broken_project_is_not_refused(project: Project) -> None:
    """Differential: S{A,B} already collides, so moving an unrelated task stays possible."""
    t = _reparent_setup(project, "FF")
    t["B"].wbs_path = "1.2"
    t["B"].save(update_fields=["wbs_path"])
    other = _task(project, "Other", "4")
    assert recalc_transition_block(project.pk, reparent={other.pk: "1"}) is None


# ---------------------------------------------------------------------------
# Committed-set transitions (#5046)
# ---------------------------------------------------------------------------


def _backlog_child_setup(project: Project, inbound_type: str, parent_status: str) -> Task:
    """``X -<inbound_type>-> P`` where P's only child is a backlog row."""
    parent = _task(project, "P", "1", status=parent_status)
    child = _task(project, "Child", "1.1", status=TaskStatus.BACKLOG)
    x = _task(project, "X", "2")
    _link(x, parent, inbound_type)
    return child


@pytest.mark.django_db
@pytest.mark.parametrize(
    "parent_status",
    # NOT_STARTED: the next recalc sees P as a summary. BACKLOG: what the phase rollup
    # stores for an all-backlog phase — P re-enters the feed only after the rollup
    # commits it, so only the follow-up recalc would raise.
    [TaskStatus.NOT_STARTED, TaskStatus.BACKLOG],
)
@pytest.mark.parametrize("inbound_type", ["FF", "SF"])
def test_committing_a_backlog_child_under_an_ff_target_is_refused(
    project: Project, owner_client: APIClient, inbound_type: str, parent_status: str
) -> None:
    child = _backlog_child_setup(project, inbound_type, parent_status)
    response, broadcast = _send(
        owner_client, "patch", f"/api/v1/tasks/{child.pk}/", {"status": "NOT_STARTED"}
    )
    assert response.status_code == 400, response.content
    assert "cannot be recalculated" in str(response.data["status"])
    child.refresh_from_db()
    assert child.status == TaskStatus.BACKLOG
    broadcast.assert_not_called()


@pytest.mark.django_db
def test_committing_a_backlog_child_under_an_fs_target_is_allowed(
    project: Project, owner_client: APIClient
) -> None:
    child = _backlog_child_setup(project, "FS", TaskStatus.NOT_STARTED)
    response, _ = _send(
        owner_client, "patch", f"/api/v1/tasks/{child.pk}/", {"status": "NOT_STARTED"}
    )
    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_un_epic_of_the_only_child_is_refused(project: Project, owner_client: APIClient) -> None:
    parent = _task(project, "P", "1")
    child = _task(project, "Child", "1.1", type=TaskType.EPIC)
    _link(_task(project, "X", "2"), parent, "FF")
    response, _ = _send(
        owner_client, "patch", f"/api/v1/tasks/{child.pk}/", {"type": TaskType.TASK}
    )
    assert response.status_code == 400, response.content
    assert "type" in response.data


@pytest.mark.django_db
def test_a_status_move_between_committed_states_is_not_checked(
    project: Project, owner_client: APIClient
) -> None:
    """Only an eligibility flip pays the project read; this one reads no graph."""
    task = _task(project, "T", "1")
    with patch("trueppm_api.apps.projects.summary_link_guard.recalc_transition_block") as guard:
        response, _ = _send(
            owner_client, "patch", f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}
        )
    assert response.status_code == 200, response.content
    guard.assert_not_called()


# ---------------------------------------------------------------------------
# Importers and templates (#4828)
# ---------------------------------------------------------------------------


def _mixed_type_file(leaf_type: str) -> ProjectData:
    return ProjectData(
        tasks=[
            TaskData(uid=1, name="Phase", outline_number="1", outline_level=1),
            TaskData(uid=2, name="Alpha", outline_number="1.1", outline_level=2),
            TaskData(uid=3, name="Beta", outline_number="1.2", outline_level=2),
            TaskData(
                uid=4,
                name="Close",
                outline_number="2",
                outline_level=1,
                predecessor_links=[
                    PredecessorLinkData(predecessor_uid=1, dep_type="FS"),
                    PredecessorLinkData(predecessor_uid=3, dep_type=leaf_type),
                ],
            ),
        ]
    )


def test_import_with_a_mixed_type_collision_is_described_by_name() -> None:
    data = _mixed_type_file("FF")
    detail = expansion_refusal(data, build_children_map(data))
    assert detail is not None
    assert "“Beta”" in detail and "“Close”" in detail


def test_import_with_same_typed_links_passes() -> None:
    data = _mixed_type_file("FS")
    assert expansion_refusal(data, build_children_map(data)) is None


def test_template_with_a_mixed_type_collision_is_refused() -> None:
    document = {
        "tasks": [
            {"ref": "s", "wbs_path": "1"},
            {"ref": "a", "wbs_path": "1.1"},
            {"ref": "b", "wbs_path": "1.2"},
            {"ref": "c", "wbs_path": "2"},
        ],
        "dependencies": [
            {"predecessor": "s", "successor": "c", "dep_type": "FS"},
            {"predecessor": "b", "successor": "c", "dep_type": "FF"},
        ],
    }
    with pytest.raises(TemplateStructureError, match="different types"):
        _validate_dependency_graph(document)
    document["dependencies"][1]["dep_type"] = "FS"
    _validate_dependency_graph(document)


# ---------------------------------------------------------------------------
# Every other writer of the committed set (#5046 fix round)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(("inbound_type", "refused"), [("FF", True), ("FS", False)])
def test_detaching_a_recurrence_rule_is_guarded(
    project: Project, owner_client: APIClient, inbound_type: str, refused: bool
) -> None:
    """The template rejoins the CPM feed: as P's only child it makes P a summary."""
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    parent = _task(project, "P", "1")
    template = _task(project, "Standup", "1.1", is_recurring=True)
    _link(_task(project, "X", "2"), parent, inbound_type)
    rule = TaskRecurrenceRule.objects.create(task=template, frequency="DAILY", end_type="NEVER")
    response, _ = _send(owner_client, "delete", f"/api/v1/recurrence-rules/{rule.pk}/")
    rule.refresh_from_db()
    template.refresh_from_db()
    if refused:
        assert response.status_code == 400, response.content
        assert response.data["code"] == UNSCHEDULABLE_CHANGE_CODE
        assert "cannot be recalculated" in response.data["detail"]
        assert rule.is_deleted is False
        assert template.is_recurring is True
    else:
        assert response.status_code == 204, response.content
        assert rule.is_deleted is True
        assert template.is_recurring is False


@pytest.mark.django_db
def test_attaching_a_recurrence_rule_runs_the_guard_before_writing(
    project: Project, owner_client: APIClient
) -> None:
    """A refusal writes neither the rule nor the template's flag."""
    from trueppm_api.apps.projects.models import TaskRecurrenceRule
    from trueppm_api.apps.projects.summary_link_guard import SummaryStartLinkBlock

    template = _task(project, "Standup", "1")
    body = {"task": str(template.pk), "frequency": "DAILY", "end_type": "NEVER"}
    block = SummaryStartLinkBlock(detail="refused", code=UNSCHEDULABLE_CHANGE_CODE)
    with patch(
        "trueppm_api.apps.projects.views.recalc_transition_block", return_value=block
    ) as guard:
        response, _ = _send(owner_client, "post", "/api/v1/recurrence-rules/", body)
    assert response.status_code == 400, response.content
    assert response.data == {"code": UNSCHEDULABLE_CHANGE_CODE, "detail": "refused"}
    guard.assert_called_once_with(
        template.project_id, changes={template.pk: {"is_recurring": True}}
    )
    assert not TaskRecurrenceRule.objects.filter(task=template).exists()
    template.refresh_from_db()
    assert template.is_recurring is False


@pytest.mark.django_db
def test_attaching_a_recurrence_rule_with_the_real_guard_is_allowed(
    project: Project, owner_client: APIClient
) -> None:
    parent = _task(project, "P", "1")
    template = _task(project, "Standup", "1.1")
    _task(project, "Build", "1.2")
    _link(_task(project, "X", "2"), parent, "FF")
    body = {"task": str(template.pk), "frequency": "DAILY", "end_type": "NEVER"}
    response, _ = _send(owner_client, "post", "/api/v1/recurrence-rules/", body)
    assert response.status_code == 201, response.content
    template.refresh_from_db()
    assert template.is_recurring is True


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("inbound_type", "new_status", "refused"),
    [("FF", None, True), ("FS", None, False), ("FF", TaskStatus.BACKLOG, False)],
)
def test_creating_the_first_committed_child_of_a_backlog_only_parent_is_guarded(
    project: Project,
    owner_client: APIClient,
    inbound_type: str,
    new_status: str | None,
    refused: bool,
) -> None:
    """P already "has children" — but only a backlog one, so the CPM sees a leaf."""
    child = _backlog_child_setup(project, inbound_type, TaskStatus.NOT_STARTED)
    parent = Task.objects.get(project=project, wbs_path="1")
    body: dict[str, Any] = {"project": str(project.pk), "name": "New", "parent_id": str(parent.pk)}
    if new_status:
        body["status"] = new_status
    response, _ = _send(owner_client, "post", "/api/v1/tasks/", body)
    created = Task.objects.filter(project=project, name="New")
    if refused:
        assert response.status_code == 400, response.content
        assert "cannot be recalculated" in str(response.data["parent_id"])
        assert not created.exists()
    else:
        assert response.status_code == 201, response.content
        assert created.get().wbs_path == "1.2"
    assert child.pk


@pytest.mark.django_db
@pytest.mark.parametrize(("inbound_type", "refused"), [("FF", True), ("FS", False)])
def test_restoring_a_committed_child_under_a_backlog_only_parent_is_guarded(
    project: Project, owner_client: APIClient, inbound_type: str, refused: bool
) -> None:
    _backlog_child_setup(project, inbound_type, TaskStatus.NOT_STARTED)
    trashed = _task(project, "Trashed", "1.2")
    trashed.soft_delete()
    response, _ = _send(owner_client, "post", f"/api/v1/tasks/{trashed.pk}/restore/")
    trashed.refresh_from_db()
    if refused:
        assert response.status_code == 400, response.content
        assert response.data["code"] == UNSCHEDULABLE_CHANGE_CODE
        assert trashed.is_deleted is True
    else:
        assert response.status_code == 200, response.content
        assert trashed.is_deleted is False


@pytest.mark.django_db
def test_bulk_row_patch_refusal_is_per_row(project: Project, owner_client: APIClient) -> None:
    child = _backlog_child_setup(project, "FF", TaskStatus.NOT_STARTED)
    other = _task(project, "Other", "3")
    operations = [
        {"op": "update", "id": str(child.pk), "data": {"status": "NOT_STARTED"}},
        {"op": "update", "id": str(other.pk), "data": {"name": "Other renamed"}},
    ]
    response, _ = _send(
        owner_client,
        "post",
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": operations},
    )
    assert response.status_code == 207, response.content
    assert [row["index"] for row in response.data["rejected"]] == [0]
    assert "cannot be recalculated" in str(response.data["rejected"][0])
    assert len(response.data["applied"]) == 1
    child.refresh_from_db()
    other.refresh_from_db()
    assert child.status == TaskStatus.BACKLOG
    assert other.name == "Other renamed"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("first_status", "refused_indexes"),
    # The placement cache used to check only the first row under a parent, so a
    # committed row after a backlog one slipped through (#5046).
    [(TaskStatus.BACKLOG, [1]), (TaskStatus.NOT_STARTED, [0, 1])],
)
def test_bulk_create_checks_every_row_under_a_backlog_only_parent(
    project: Project, owner_client: APIClient, first_status: str, refused_indexes: list[int]
) -> None:
    _backlog_child_setup(project, "FF", TaskStatus.NOT_STARTED)
    parent = Task.objects.get(project=project, wbs_path="1")
    operations = [
        {
            "op": "create",
            "data": {"name": "First", "parent_id": str(parent.pk), "status": first_status},
        },
        {"op": "create", "data": {"name": "Second", "parent_id": str(parent.pk)}},
    ]
    response, _ = _send(
        owner_client,
        "post",
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": operations},
    )
    assert response.status_code == 207, response.content
    assert [row["index"] for row in response.data["rejected"]] == refused_indexes
    assert "cannot be recalculated" in str(response.data["rejected"][0])
    created = set(
        Task.objects.filter(project=project, name__in=["First", "Second"]).values_list(
            "name", flat=True
        )
    )
    assert created == ({"First"} if refused_indexes == [1] else set())


@pytest.mark.django_db
def test_sync_upload_refusal_is_a_conflict_and_the_batch_commits(
    project: Project, owner_client: APIClient
) -> None:
    import uuid

    child = _backlog_child_setup(project, "FF", TaskStatus.NOT_STARTED)
    other = _task(project, "Other", "3")
    payload = {
        "client_batch_id": str(uuid.uuid4()),
        "changes": {
            "tasks": {
                "created": [],
                "updated": [
                    {"id": str(child.pk), "status": "NOT_STARTED"},
                    {"id": str(other.pk), "name": "Other renamed"},
                ],
                "deleted": [],
            }
        },
    }
    response, _ = _send(owner_client, "post", f"/api/v1/projects/{project.pk}/sync/", payload)
    assert response.status_code == 200, response.content
    body = response.json()
    conflicts = body["conflicts"]["tasks"]
    assert [c["id"] for c in conflicts] == [str(child.pk)]
    assert conflicts[0]["code"] == UNSCHEDULABLE_CHANGE_CODE
    assert conflicts[0]["fields"] == ["status"]
    assert [row["id"] for row in body["applied"]["tasks"]["updated"]] == [str(other.pk)]
    child.refresh_from_db()
    other.refresh_from_db()
    assert child.status == TaskStatus.BACKLOG
    assert other.name == "Other renamed"


_MIXED_TYPE_CSV = b"""\
ID,Name,Duration,Predecessors
1,Phase,1,
2,  Alpha,3,
3,  Beta,3,
4,Close,1,"1,3FF"
"""


@pytest.mark.django_db
def test_csv_import_with_a_mixed_type_collision_ends_dead_and_writes_nothing(
    project: Project,
) -> None:
    import base64

    from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
    from trueppm_api.apps.csvimport.tasks import import_csv

    content = base64.b64encode(_MIXED_TYPE_CSV).decode("ascii")
    req = CsvImportRequest.objects.create(
        project=project,
        filename="plan.csv",
        file_content_b64=content,
        status=CsvImportStatus.DISPATCHED,
    )
    result = import_csv.apply(
        kwargs={
            "project_id": str(project.pk),
            "file_content_b64": content,
            "filename": "plan.csv",
            "import_request_id": str(req.pk),
        },
        throw=False,
    )
    req.refresh_from_db()
    assert result.failed()
    assert req.status == CsvImportStatus.DEAD
    assert "different types" in req.result_summary["error"]
    assert "Beta" in req.result_summary["error"] and "Close" in req.result_summary["error"]
    assert not Task.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_msproject_import_with_a_mixed_type_collision_ends_dead_and_writes_nothing(
    project: Project,
) -> None:
    import base64
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    from tests.apps.msproject.test_import_graph_guard import _build_xml
    from tests.apps.msproject.test_import_graph_guard import _task as _msp_task
    from trueppm_api.apps.msproject.models import ImportRequest, ImportRequestStatus
    from trueppm_api.apps.msproject.tasks import import_msproject

    close = _msp_task(4, "Close", "2")
    # MSPDI link types: 1 = FS, 0 = FF.
    close["PredecessorLinks"] = [
        {"PredecessorUID": 1, "Type": 1},
        {"PredecessorUID": 3, "Type": 0},
    ]
    xml = _build_xml(
        [
            _msp_task(1, "Phase", "1"),
            _msp_task(2, "Alpha", "1.1"),
            _msp_task(3, "Beta", "1.2"),
            close,
        ]
    )

    @contextmanager
    def _stub_tracker(*_a: object, **_kw: object) -> Any:
        yield MagicMock()

    req = ImportRequest.objects.create(
        project=project,
        filename="plan.xml",
        file_content_b64=base64.b64encode(xml).decode("ascii"),
        creates_project=True,
        status=ImportRequestStatus.DISPATCHED,
    )
    with patch("trueppm_api.apps.msproject.tasks._get_tracker", _stub_tracker):
        result = import_msproject.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": req.file_content_b64,
                "filename": "plan.xml",
                "import_request_id": str(req.id),
                "creates_project": True,
            },
            throw=False,
        )
    req.refresh_from_db()
    assert result.failed()
    assert req.status == ImportRequestStatus.DEAD
    assert "different types" in req.result_summary["error"]
    assert "Beta" in req.result_summary["error"] and "Close" in req.result_summary["error"]
    assert not Task.objects.filter(project=project).exists()
