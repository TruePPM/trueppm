"""``bulk_soft_delete_tasks`` — the set-based twin of ``Task.soft_delete`` (#2765).

Two things are asserted and both matter: the bulk path leaves every row in the state
the per-row path would (versions, tombstone marker, sync cursor, edge and subtree
cascade, ``edited_at`` untouched), and its query count does not grow with N — the
reason it exists. A count test with no parity test would pass on a path that skips
the cascade; a parity test with no count test would pass on the old loop.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from trueppm_api.apps.projects.models import (
    BacklogItem,
    BacklogItemStatus,
    Calendar,
    Dependency,
    Program,
    Project,
    ProjectTemplate,
    RetroActionItem,
    Sprint,
    SprintRetro,
    Task,
    TemplateApplication,
    TemplateApplicationStatus,
    bulk_soft_delete_tasks,
    cascade_task_children_restore,
)
from trueppm_api.apps.projects.template_services import undo_template_application


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 9, 1), calendar=cal)


@pytest.fixture
def other_project(project: Project) -> Project:
    return Project.objects.create(name="Q", start_date=date(2026, 9, 1), calendar=project.calendar)


def _tree(project: Project) -> dict[str, Task]:
    """1 (summary) > 1.1, 1.2 ; 2 ; edges 1.1->1.2 and 1.2->2."""
    t = {
        path: Task.objects.create(project=project, name=path, duration=2, wbs_path=path)
        for path in ("1", "1.1", "1.2", "2")
    }
    Dependency.objects.create(predecessor=t["1.1"], successor=t["1.2"], dep_type="FS")
    Dependency.objects.create(predecessor=t["1.2"], successor=t["2"], dep_type="FS")
    return t


@pytest.mark.django_db
def test_matches_per_row_cascade_and_stamps(project: Project, other_project: Project) -> None:
    t = _tree(project)
    # Same-shaped path in another project must be left alone (#3010).
    bystander = Task.objects.create(project=other_project, name="x", duration=1, wbs_path="1.1")
    before = {
        pk: (v, s) for pk, v, s in Task.objects.values_list("pk", "server_version", "sync_seq")
    }
    edited = Task.objects.get(pk=t["1"].pk).edited_at
    project.refresh_from_db()
    seq_before = project.last_sync_version

    n = bulk_soft_delete_tasks([Task.objects.get(pk=t["1"].pk)])

    assert n == 3  # root + both children swept by the subtree
    for path in ("1", "1.1", "1.2"):
        row = Task.objects.get(pk=t[path].pk)
        assert row.is_deleted is True
        assert row.deleted_at is not None
        assert row.server_version == before[row.pk][0] + 1
        assert row.deleted_version == row.server_version
        assert row.sync_seq > seq_before  # tombstone is deliverable to offline clients
    assert Task.objects.get(pk=t["1"].pk).edited_at == edited  # deleting is not editing
    assert Task.objects.get(pk=t["2"].pk).is_deleted is False
    assert Task.objects.get(pk=bystander.pk).is_deleted is False
    deps = Dependency.objects.all()
    assert deps.count() == 2 and all(d.is_deleted for d in deps)  # both touch the subtree
    assert all(d.deleted_at and d.deleted_version == d.server_version for d in deps)
    assert all(d.sync_seq > seq_before for d in deps)


@pytest.mark.django_db
def test_already_deleted_rows_are_not_bumped_twice(project: Project) -> None:
    t = _tree(project)
    root = Task.objects.get(pk=t["1"].pk)
    bulk_soft_delete_tasks([root])
    version = Task.objects.get(pk=t["1.1"].pk).server_version

    # A stale instance for a child the parent's cascade already swept.
    assert bulk_soft_delete_tasks([t["1.1"], root]) == 0
    assert Task.objects.get(pk=t["1.1"].pk).server_version == version


@pytest.mark.django_db
def test_empty_input_is_a_no_op() -> None:
    assert bulk_soft_delete_tasks([]) == 0


def _applied(project: Project, n: int) -> TemplateApplication:
    """n untouched (edited_at NULL) rows chained by edges, as a template apply leaves them."""
    rows = Task.objects.bulk_create(
        [
            Task(
                project=project,
                name=f"t{i}",
                duration=1,
                wbs_path=str(i + 1),
                short_id=f"T-{i + 1}",
                server_version=1,
            )
            for i in range(n)
        ]
    )
    Dependency.objects.bulk_create(
        [
            Dependency(predecessor=rows[i], successor=rows[i + 1], dep_type="FS", server_version=1)
            for i in range(n - 1)
        ]
    )
    template = ProjectTemplate.objects.create(name="T", structure={})
    return TemplateApplication.objects.create(
        template=template,
        project=project,
        status=TemplateApplicationStatus.SUCCESS,
        created_task_ids=[r.pk for r in rows],
    )


def _undo_queries(project: Project, n: int) -> int:
    application = _applied(project, n)
    with CaptureQueriesContext(connection) as ctx:
        summary = undo_template_application(application)
    assert summary == {"deleted": n, "kept": 0}
    assert not Task.objects.filter(project=project, is_deleted=False).exists()
    return len(ctx)


@pytest.mark.django_db
def test_undo_query_count_is_independent_of_n(project: Project, other_project: Any) -> None:
    small = _undo_queries(project, 3)
    large = _undo_queries(other_project, 40)
    assert large == small


def _summary_with_child(project: Project, tag: str) -> tuple[Task, Task]:
    """Untouched (edited_at NULL) rows, as a template apply leaves them."""
    root, child = Task.objects.bulk_create(
        [
            Task(
                project=project,
                name=f"{n}{tag}",
                duration=1,
                wbs_path=path,
                short_id=sid,
                server_version=1,
            )
            for n, path, sid in (("root", "1", "T-1"), ("kid", "1.1", "T-2"))
        ]
    )
    return root, child


def _undo_of(project: Project, root: Task) -> TemplateApplication:
    template = ProjectTemplate.objects.create(name="T", structure={})
    return TemplateApplication.objects.create(
        template=template,
        project=project,
        status=TemplateApplicationStatus.SUCCESS,
        created_task_ids=[root.pk],  # the child is swept as a WBS descendant
    )


@pytest.mark.django_db
def test_undo_resets_a_backlog_item_pulled_into_a_swept_child(project: Project) -> None:
    """ADR-0069: a descendant the cascade sweeps must free its pulled BacklogItem."""
    root, child = _summary_with_child(project, "")
    program = Program.objects.create(name="Prog")
    item = BacklogItem.objects.create(
        program=program,
        title="pulled",
        status=BacklogItemStatus.PULLED,
        pulled_task=child,
    )

    undo_template_application(_undo_of(project, root))

    assert Task.objects.get(pk=child.pk).is_deleted is True
    item.refresh_from_db()
    assert item.status == BacklogItemStatus.PROPOSED
    assert item.pulled_task_id is None and item.pulled_at is None


@pytest.mark.django_db
def test_undo_clears_the_promoted_task_of_a_retro_action_item(project: Project) -> None:
    """ADR-0071: a descendant the cascade sweeps must free its retro action item."""
    root, child = _summary_with_child(project, "")
    sprint = Sprint.objects.create(
        project=project,
        short_id="S1",
        name="S1",
        start_date=date(2026, 9, 1),
        finish_date=date(2026, 9, 14),
    )
    retro = SprintRetro.objects.create(sprint=sprint)
    action = RetroActionItem.objects.create(retro=retro, text="x", promoted_task_id=child.pk)

    undo_template_application(_undo_of(project, root))

    action.refresh_from_db()
    assert action.promoted_task_id is None


def _snapshot(tasks: dict[str, Task], edges: list[Dependency], item: BacklogItem) -> dict[str, Any]:
    """Everything the two paths must agree on, keyed by stable names (not pks)."""
    out: dict[str, Any] = {}
    for name, t in tasks.items():
        r = Task.objects.get(pk=t.pk)
        out[f"task:{name}"] = (
            r.is_deleted,
            r.deleted_version,
            r.server_version,
            r.deleted_at is not None,
        )
    for i, e in enumerate(edges):
        r2 = Dependency.objects.get(pk=e.pk)
        out[f"edge:{i}"] = (
            r2.is_deleted,
            r2.deleted_version,
            r2.server_version,
            r2.deleted_at is not None,
        )
    item.refresh_from_db()
    out["item"] = (item.status, item.pulled_task_id is None, item.server_version)
    return out


def _parity_fixture(
    project: Project, other: Project, tag: str
) -> tuple[Task, dict[str, Task], list[Dependency], BacklogItem]:
    root, child = _summary_with_child(project, tag)
    tail = Task.objects.create(project=project, name=f"tail{tag}", duration=1, wbs_path="2")
    foreign = Task.objects.create(project=other, name=f"far{tag}", duration=1, wbs_path="1")
    edges = [
        Dependency.objects.create(predecessor=child, successor=tail, dep_type="FS"),
        Dependency.objects.create(predecessor=foreign, successor=child, dep_type="FS"),
    ]
    program = Program.objects.create(name=f"Prog{tag}")
    item = BacklogItem.objects.create(
        program=program, title="p", status=BacklogItemStatus.PULLED, pulled_task=child
    )
    return root, {"root": root, "child": child, "tail": tail, "foreign": foreign}, edges, item


@pytest.mark.django_db
def test_bulk_matches_the_per_row_loop_row_for_row(
    project: Project, other_project: Project
) -> None:
    """Run the old per-row path on one fixture and the bulk path on a twin."""
    root_a, tasks_a, edges_a, item_a = _parity_fixture(project, other_project, "A")
    # A twin in its own project pair, so the live-row wbs_path constraint cannot collide.
    project_b = Project.objects.create(
        name="PB", start_date=date(2026, 9, 1), calendar=project.calendar
    )
    other_b = Project.objects.create(
        name="QB", start_date=date(2026, 9, 1), calendar=project.calendar
    )
    root_b, tasks_b, edges_b, item_b = _parity_fixture(project_b, other_b, "B")

    Task.objects.get(pk=root_a.pk).soft_delete()  # the old loop, one root
    bulk_soft_delete_tasks([Task.objects.get(pk=root_b.pk)])

    assert _snapshot(tasks_a, edges_a, item_a) == _snapshot(tasks_b, edges_b, item_b)


@pytest.mark.django_db
def test_cross_project_edge_tombstone_is_deliverable_in_the_predecessors_project(
    project: Project, other_project: Project
) -> None:
    root, child = _summary_with_child(project, "")
    foreign = Task.objects.create(project=other_project, name="far", duration=1, wbs_path="1")
    edge = Dependency.objects.create(predecessor=foreign, successor=child, dep_type="FS")
    other_project.refresh_from_db()
    prior = other_project.last_sync_version

    bulk_soft_delete_tasks([root])

    other_project.refresh_from_db()
    edge.refresh_from_db()
    assert edge.is_deleted is True
    assert prior < edge.sync_seq <= other_project.last_sync_version


@pytest.mark.django_db
def test_restore_round_trip_after_bulk_delete(project: Project, other_project: Project) -> None:
    root, child = _summary_with_child(project, "")
    foreign = Task.objects.create(project=other_project, name="far", duration=1, wbs_path="1")
    edge = Dependency.objects.create(predecessor=foreign, successor=child, dep_type="FS")

    bulk_soft_delete_tasks([root])
    root = Task.objects.get(pk=root.pk)
    root.restore(on_conflict="repath")
    cascade_task_children_restore(root)

    assert Task.objects.get(pk=root.pk).is_deleted is False
    assert Task.objects.get(pk=child.pk).is_deleted is False
    assert Dependency.objects.get(pk=edge.pk).is_deleted is False


def test_task_post_save_receiver_set_is_pinned() -> None:
    """``bulk_soft_delete_tasks`` writes with ``update()``, which skips ``post_save``, so
    it mirrors the soft-delete-relevant receivers by hand. Pin the set by qualified name
    so a new receiver cannot land without someone deciding whether the bulk path needs it.
    """
    from django.db.models.signals import post_save

    receivers = post_save._live_receivers(Task)[0]
    names = {f"{r.__module__}.{r.__qualname__}" for r in receivers}
    recv = "trueppm_api.apps.projects.receivers"
    assert names == {
        "simple_history.models.HistoricalRecords.post_save",
        f"{recv}._register_task_soft_delete_receiver.<locals>._on_task_save_reset_promoted",
        f"{recv}._register_milestone_rollup_receiver.<locals>._on_task_save_recompute_rollup",
        f"{recv}._register_backlog_pull_rollback_receiver.<locals>._on_task_soft_delete_reset_backlog_item",
    }, "a new Task post_save receiver was added; revisit bulk_soft_delete_tasks"
