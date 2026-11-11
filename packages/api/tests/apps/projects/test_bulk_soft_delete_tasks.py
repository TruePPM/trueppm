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
    Calendar,
    Dependency,
    Project,
    ProjectTemplate,
    Task,
    TemplateApplication,
    TemplateApplicationStatus,
    bulk_soft_delete_tasks,
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
