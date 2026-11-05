"""SS/SF links out of a summary cannot reach the database by any writer (#4830, ADR-0370).

``DependencySerializer`` refuses an SS/SF link from a summary when the *link* is
written. These tests cover the writers that never read a link's type: the structural
edits that turn a leaf into a summary (refused with a 400 naming the links) and the
importers that bulk-create edges (the link is skipped and reported, the rest of the
import succeeds). Each structural test asserts the outline is unchanged after the
refusal — a 400 that had already moved rows would be the bug in a different shape.
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
from trueppm_api.apps.msproject.dataclasses import PredecessorLinkData, ProjectData, TaskData
from trueppm_api.apps.msproject.importer import import_project
from trueppm_api.apps.projects.models import Calendar, Dependency, Project, ProjectTemplate, Task
from trueppm_api.apps.projects.project_templates import STRUCTURE_VERSION, materialize_structure
from trueppm_api.apps.projects.summary_link_guard import (
    split_summary_start_links,
    summary_ids_from_paths,
)
from trueppm_api.apps.scheduling.graph_guard import find_summary_start_links

User = get_user_model()

INDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/indent/"
OUTDENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/outdent/"
REPARENT_URL = "/api/v1/projects/{pk}/tasks/{task_id}/reparent/"
UNGROUP_URL = "/api/v1/projects/{pk}/tasks/ungroup/"
UNDO_URL = "/api/v1/structural-operations/{pk}/undo/"
BULK_URL = "/api/v1/projects/{pk}/tasks/bulk/"


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


def _task(project: Project, name: str, path: str) -> Task:
    return Task.objects.create(project=project, name=name, duration=2, wbs_path=path)


def _post(client: APIClient, url: str, body: Any = None) -> Any:
    with (
        patch("django.db.transaction.on_commit", side_effect=lambda fn, *a, **kw: fn()),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
    ):
        return client.post(url, body if body is not None else {}, format="json")


def _outline(project: Project) -> dict[str, str]:
    return {
        name: str(path)
        for name, path in Task.objects.filter(project=project, is_deleted=False).values_list(
            "name", "wbs_path"
        )
    }


# ---------------------------------------------------------------------------
# The rule itself
# ---------------------------------------------------------------------------


def test_only_ss_and_sf_out_of_a_summary_are_reported() -> None:
    edges = [
        ("S", "X", "SS"),
        ("S", "X", "SF"),
        ("S", "X", "FS"),
        ("S", "X", "FF"),
        ("L", "X", "SS"),  # a leaf may drive SS
        ("X", "S", "SS"),  # INTO a summary is not the forbidden direction
    ]
    assert find_summary_start_links(edges, {"S"}) == [("S", "X", "SS"), ("S", "X", "SF")]


def test_summary_ids_use_direct_parent_semantics() -> None:
    """Same notion of 'summary' as the CPM's children map: a row whose path parents another."""
    rows = [("a", "1"), ("b", "1.1"), ("c", "2"), ("d", "3.1.1"), ("e", None)]
    # "3.1.1"'s parent path "3.1" is absent, so no row is its summary.
    assert summary_ids_from_paths(rows) == {"a"}


def test_split_keeps_order_and_partitions() -> None:
    class Edge:
        def __init__(self, p: str, s: str, t: str) -> None:
            self.predecessor_id, self.successor_id, self.dep_type = p, s, t

    fs, ss, leaf_ss = Edge("S", "X", "FS"), Edge("S", "X", "SS"), Edge("L", "X", "SS")
    kept, skipped = split_summary_start_links([fs, ss, leaf_ss], {"S"})
    assert kept == [fs, leaf_ss]
    assert skipped == [ss]


# ---------------------------------------------------------------------------
# Structural edits — refused with a 400 that names the link
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIndent:
    def test_indent_under_a_leaf_that_drives_ss_is_refused(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """The issue's own repro: A (leaf, SS to C), sibling B; indent B under A."""
        a = _task(project, "A", "1")
        b = _task(project, "B", "2")
        c = _task(project, "C", "3")
        link = Dependency.objects.create(predecessor=a, successor=c, dep_type="SS")
        before = _outline(project)

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=b.pk))

        assert response.status_code == 400, response.data
        body = response.json()
        assert body["code"] == "summary_start_link"
        assert "“A”" in body["detail"]
        assert "“C” (SS)" in body["detail"]
        assert body["blocking_dependencies"] == [
            {"id": str(link.pk), "dep_type": "SS", "successor_id": str(c.pk)}
        ]
        assert _outline(project) == before, "a refusal must not have moved any row"

    def test_indent_under_a_leaf_that_drives_only_fs_and_ff_is_allowed(
        self, project: Project, owner_client: APIClient
    ) -> None:
        a = _task(project, "A", "1")
        b = _task(project, "B", "2")
        c = _task(project, "C", "3")
        Dependency.objects.create(predecessor=a, successor=c, dep_type="FS")
        Dependency.objects.create(predecessor=a, successor=b, dep_type="FF")

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=b.pk))

        assert response.status_code == 200, response.data
        assert _outline(project)["B"] == "1.1"

    def test_a_summary_that_already_holds_the_link_is_not_this_indent_s_to_refuse(
        self, project: Project, owner_client: APIClient
    ) -> None:
        """Differential: refusing every edit of an already-broken plan blocks its repair."""
        a = _task(project, "A", "1")
        _task(project, "A1", "1.1")
        b = _task(project, "B", "2")
        c = _task(project, "C", "3")
        Dependency.objects.create(predecessor=a, successor=c, dep_type="SS")

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=b.pk))

        assert response.status_code == 200, response.data

    def test_a_successor_in_another_project_is_not_named(
        self, project: Project, owner_client: APIClient
    ) -> None:
        a = _task(project, "A", "1")
        b = _task(project, "B", "2")
        elsewhere = Project.objects.create(
            name="Elsewhere", start_date=date(2026, 1, 5), calendar=project.calendar
        )
        secret = _task(elsewhere, "Secret launch", "1")
        Dependency.objects.create(predecessor=a, successor=secret, dep_type="SF")

        response = _post(owner_client, INDENT_URL.format(pk=project.pk, task_id=b.pk))

        assert response.status_code == 400
        body = response.json()
        assert "Secret launch" not in body["detail"]
        assert "a task in another project (SF)" in body["detail"]
        assert body["blocking_dependencies"][0]["successor_id"] is None


@pytest.mark.django_db
def test_outdent_that_makes_the_task_adopt_followers_is_refused(
    project: Project, owner_client: APIClient
) -> None:
    """Outdent adopts the following siblings, so the outdented leaf becomes a summary."""
    _task(project, "P", "1")
    t = _task(project, "T", "1.1")
    _task(project, "F", "1.2")
    c = _task(project, "C", "2")
    Dependency.objects.create(predecessor=t, successor=c, dep_type="SS")
    before = _outline(project)

    response = _post(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=t.pk))

    assert response.status_code == 400, response.data
    assert response.json()["code"] == "summary_start_link"
    assert _outline(project) == before


@pytest.mark.django_db
def test_outdent_with_no_followers_to_adopt_is_allowed(
    project: Project, owner_client: APIClient
) -> None:
    _task(project, "P", "1")
    _task(project, "E", "1.1")
    t = _task(project, "T", "1.2")
    c = _task(project, "C", "2")
    Dependency.objects.create(predecessor=t, successor=c, dep_type="SS")

    response = _post(owner_client, OUTDENT_URL.format(pk=project.pk, task_id=t.pk))

    assert response.status_code == 200, response.data


@pytest.mark.django_db
def test_reparent_under_a_leaf_that_drives_sf_is_refused(
    project: Project, owner_client: APIClient
) -> None:
    target = _task(project, "Target", "1")
    mover = _task(project, "Mover", "2")
    c = _task(project, "C", "3")
    Dependency.objects.create(predecessor=target, successor=c, dep_type="SF")
    before = _outline(project)

    response = _post(
        owner_client,
        REPARENT_URL.format(pk=project.pk, task_id=mover.pk),
        {"new_parent_id": str(target.pk)},
    )

    assert response.status_code == 400, response.data
    assert response.json()["code"] == "summary_start_link"
    assert _outline(project) == before


@pytest.mark.django_db
def test_reparent_to_root_is_unaffected(project: Project, owner_client: APIClient) -> None:
    _task(project, "P", "1")
    mover = _task(project, "Mover", "1.1")
    c = _task(project, "C", "2")
    Dependency.objects.create(predecessor=mover, successor=c, dep_type="SS")

    response = _post(
        owner_client,
        REPARENT_URL.format(pk=project.pk, task_id=mover.pk),
        {"new_parent_id": None},
    )

    assert response.status_code == 200, response.data


@pytest.mark.django_db
@pytest.mark.parametrize("is_subtask", [False, True])
def test_create_with_parent_id_under_a_leaf_that_drives_ss_is_refused(
    project: Project, owner_client: APIClient, is_subtask: bool
) -> None:
    """A drawer subtask counts too: the CPM children map includes every child."""
    parent = _task(project, "Parent", "1")
    c = _task(project, "C", "2")
    Dependency.objects.create(predecessor=parent, successor=c, dep_type="SS")

    response = _post(
        owner_client,
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "Child",
            "duration": 1,
            "parent_id": str(parent.pk),
            "is_subtask": is_subtask,
        },
    )

    assert response.status_code == 400, response.data
    assert "cannot become a summary task" in str(response.data["parent_id"][0])
    assert not Task.objects.filter(project=project, name="Child").exists()


@pytest.mark.django_db
def test_bulk_create_under_such_a_leaf_rejects_only_that_row(
    project: Project, owner_client: APIClient
) -> None:
    parent = _task(project, "Parent", "1")
    c = _task(project, "C", "2")
    Dependency.objects.create(predecessor=parent, successor=c, dep_type="SS")

    response = _post(
        owner_client,
        BULK_URL.format(pk=project.pk),
        {
            "operations": [
                {
                    "op": "create",
                    "data": {"name": "Child", "duration": 1, "parent_id": str(parent.pk)},
                },
                {"op": "create", "data": {"name": "Root", "duration": 1}},
            ]
        },
    )

    assert response.status_code == 207, response.data
    assert [e["index"] for e in response.data["rejected"]] == [0]
    assert "cannot become a summary task" in response.data["rejected"][0]["message"]
    assert Task.objects.filter(project=project, name="Root").exists()
    assert not Task.objects.filter(project=project, name="Child").exists()


# ---------------------------------------------------------------------------
# The typed graph guard and structural undo
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTypedGraphGuard:
    def test_a_post_state_with_a_summary_start_link_is_refused(self, project: Project) -> None:
        from trueppm_api.apps.projects.task_grouping import (
            GroupingRejected,
            assert_graph_feasible,
            capture_graph_state,
        )

        a = _task(project, "A", "1")
        c = _task(project, "C", "2")
        Dependency.objects.create(predecessor=a, successor=c, dep_type="SS")
        healthy = capture_graph_state(str(project.pk))
        _task(project, "A1", "1.1")  # A becomes a summary

        with pytest.raises(GroupingRejected) as caught:
            assert_graph_feasible(str(project.pk), healthy)
        assert caught.value.code == "summary_start_link"
        assert caught.value.body["offending"] == [str(a.pk)]

    def test_an_already_broken_pre_state_is_not_refused(self, project: Project) -> None:
        from trueppm_api.apps.projects.task_grouping import (
            assert_graph_feasible,
            capture_graph_state,
        )

        a = _task(project, "A", "1")
        _task(project, "A1", "1.1")
        c = _task(project, "C", "2")
        Dependency.objects.create(predecessor=a, successor=c, dep_type="SF")
        broken = capture_graph_state(str(project.pk))

        assert_graph_feasible(str(project.pk), broken)  # does not raise


@pytest.mark.django_db
def test_undoing_an_ungroup_does_not_revive_a_containers_ss_link(
    project: Project, owner_client: APIClient
) -> None:
    """The ungroup removed a link ADR-0370 already forbade; the undo must not bring it back.

    The undo still completes — the shape returns — and the dropped link is counted in
    ``dependencies_skipped``, the field that already means "re-draw these by hand".
    """
    container = _task(project, "Phase", "1")
    _task(project, "Inner", "1.1")
    after = _task(project, "After", "2")
    ss = Dependency.objects.create(predecessor=container, successor=after, dep_type="SS")
    fs = Dependency.objects.create(predecessor=container, successor=after, dep_type="FS")

    ungrouped = _post(
        owner_client, UNGROUP_URL.format(pk=project.pk), {"task_id": str(container.pk)}
    )
    assert ungrouped.status_code == 200, ungrouped.data

    undone = _post(owner_client, UNDO_URL.format(pk=ungrouped.json()["operation_id"]))

    assert undone.status_code == 200, undone.data
    ss.refresh_from_db()
    fs.refresh_from_db()
    assert ss.is_deleted is True
    assert fs.is_deleted is False
    assert undone.json()["undo"]["dependencies_restored"] == 1
    assert undone.json()["undo"]["dependencies_skipped"] == 1
    assert _outline(project) == {"Phase": "1", "Inner": "1.1", "After": "2"}


# ---------------------------------------------------------------------------
# Importers — the link is skipped and reported; the rest of the import lands
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_ms_project_import_skips_a_summary_ss_link_and_warns(project: Project) -> None:
    """Also the CSV/Excel and Jira importers' path: both persist through ``import_project``."""
    data = ProjectData(
        tasks=[
            TaskData(uid=1, name="Phase", outline_number="1", outline_level=1),
            TaskData(uid=2, name="Work", outline_number="1.1", outline_level=2),
            TaskData(
                uid=3,
                name="Follow-up",
                outline_number="2",
                outline_level=1,
                predecessor_links=[
                    PredecessorLinkData(predecessor_uid=1, dep_type="SS"),
                    PredecessorLinkData(predecessor_uid=1, dep_type="FS"),
                    PredecessorLinkData(predecessor_uid=2, dep_type="SS"),
                ],
            ),
        ]
    )

    summary = import_project(str(project.pk), data)

    kept = sorted(
        (d.predecessor.name, d.dep_type)
        for d in Dependency.objects.filter(predecessor__project=project)
    )
    assert kept == [("Phase", "FS"), ("Work", "SS")]
    assert summary["dependencies_created"] == 2
    assert any(
        "'Phase'" in w and "SS link to 'Follow-up' skipped" in w for w in summary["warnings"]
    ), summary["warnings"]


@pytest.mark.django_db
def test_template_apply_skips_a_summary_ss_link_and_reports_it(project: Project) -> None:
    template = ProjectTemplate.objects.create(
        name="Broken source",
        structure={
            "version": STRUCTURE_VERSION,
            "tasks": [
                {"ref": "p", "name": "Phase", "wbs_path": "1"},
                {"ref": "w", "name": "Work", "wbs_path": "1.1"},
                {"ref": "n", "name": "Next", "wbs_path": "2"},
            ],
            "dependencies": [
                {"predecessor": "p", "successor": "n", "dep_type": "SF"},
                {"predecessor": "w", "successor": "n", "dep_type": "SS"},
            ],
        },
    )

    result = materialize_structure(template, project)

    assert result.dependencies_created == 1
    assert [d.dep_type for d in Dependency.objects.filter(predecessor__project=project)] == ["SS"]
    assert len(result.warnings) == 1
    assert "'Phase': SF link to 'Next' skipped" in result.warnings[0]


@pytest.mark.django_db
def test_seed_link_dependencies_skips_a_summary_ss_link(project: Project) -> None:
    from trueppm_api.apps.projects.seed.importer import _SeedImporter

    phase = _task(project, "Phase", "1")
    work = _task(project, "Work", "1.1")
    nxt = _task(project, "Next", "2")
    importer = _SeedImporter.__new__(_SeedImporter)
    importer.tasks = {("p", "1"): phase, ("p", "1.1"): work, ("p", "2"): nxt}
    inserted: list[Dependency] = []

    def _capture(_model: Any, rows: list[Dependency], **_kw: Any) -> None:
        inserted.extend(rows)

    importer._bulk_insert = _capture  # type: ignore[method-assign]
    importer._link_dependencies(
        project,
        {
            "slug": "p",
            "dependencies": [
                {"predecessor": "1", "successor": "2", "dep_type": "SS"},
                {"predecessor": "1.1", "successor": "2", "dep_type": "SS"},
            ],
        },
    )

    assert [(d.predecessor_id, d.dep_type) for d in inserted] == [(work.pk, "SS")]


def test_uuid_ids_and_string_ids_agree() -> None:
    """Importers hand pks as UUIDs or strings; the partition compares them as strings."""
    pk = uuid.uuid4()

    class Edge:
        predecessor_id = pk
        successor_id = uuid.uuid4()
        dep_type = "SS"

    kept, skipped = split_summary_start_links([Edge()], {str(pk)})
    assert kept == []
    assert len(skipped) == 1


@pytest.mark.django_db
def test_csv_import_skips_a_summary_ss_predecessor_and_keeps_the_warning(project: Project) -> None:
    """End to end through the CSV task: the skip warning must survive ``_finalize_summary``.

    That step used to *assign* the parser's warnings over the summary's, discarding every
    warning the shared persistence step recorded — this one included.
    """
    import base64

    from trueppm_api.apps.csvimport.tasks import import_csv

    csv = b"""\
Task ID,WBS,Task,Days,Depends On
1,1,Phase,,
2,1.1,Work,3,
3,2,Next,2,1SS
4,3,Later,2,1FS
"""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.services.enqueue_recalculate"),
    ):
        summary = import_csv.apply(
            kwargs={
                "project_id": str(project.pk),
                "file_content_b64": base64.b64encode(csv).decode("ascii"),
                "filename": "plan.csv",
            },
            throw=True,
        ).get()

    kept = sorted(
        (d.predecessor.name, d.successor.name, d.dep_type)
        for d in Dependency.objects.filter(predecessor__project=project)
    )
    assert kept == [("Phase", "Later", "FS")]
    assert any("SS link to 'Next' skipped" in w for w in summary["warnings"]), summary["warnings"]
