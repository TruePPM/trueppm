"""Perf/ordering sweep regressions (#2856) and the ltree subtree lookups (#3011)."""

from __future__ import annotations

import inspect
import re
import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.models import TASK_LINK_MAX, TaskLink
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    Risk,
    RiskComment,
    Task,
)
from trueppm_api.apps.projects.views import PHASE_MAX

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
    ):
        yield


@pytest.fixture
def project() -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Sweep", start_date=date(2026, 1, 1), calendar=cal)


@pytest.fixture
def owner(project: Project) -> object:
    u = User.objects.create_user(username="sweep-owner", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.OWNER)
    return u


@pytest.fixture
def client(owner: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner)
    return c


def _roots(project: Project, n: int) -> list[Task]:
    return [
        Task.objects.create(project=project, name=f"P{i}", duration=1, wbs_path=str(i))
        for i in range(1, n + 1)
    ]


# ---------------------------------------------------------------------------
# #3011 — ltree subtree lookups
# ---------------------------------------------------------------------------


def _where(qs: Any) -> str:
    return str(qs.query)


class TestLtreeLookups:
    def test_descendant_or_equal_compiles_to_ltree_operator(self, project: Project) -> None:
        sql = _where(Task.objects.filter(wbs_path__descendant_or_equal="1.2"))
        # Assert the operator applied to the wbs_path column, not just "<@" somewhere.
        assert re.search(r'"projects_task"\."wbs_path" <@ \(.*\)::ltree', sql), sql
        assert "LIKE" not in sql

    def test_descendant_compiles_to_ltree_operator_and_excludes_self(self) -> None:
        sql = _where(Task.objects.filter(wbs_path__descendant="1.2"))
        assert re.search(r'"projects_task"\."wbs_path" <@ \(.*\)::ltree', sql), sql
        assert re.search(r'"projects_task"\."wbs_path" <> \(.*\)::ltree', sql), sql
        assert "LIKE" not in sql

    def test_lookups_return_whole_label_subtrees(self, project: Project) -> None:
        paths = ["1", "1.1", "1.1.1", "1.2", "10", "10.1", "2"]
        for p in paths:
            Task.objects.create(project=project, name=p, duration=1, wbs_path=p)

        def got(**kw: str) -> set[str]:
            return {str(t.wbs_path) for t in Task.objects.filter(project=project, **kw)}

        assert got(wbs_path__descendant_or_equal="1") == {"1", "1.1", "1.1.1", "1.2"}
        assert got(wbs_path__descendant="1") == {"1.1", "1.1.1", "1.2"}
        assert got(wbs_path__descendant="1.1") == {"1.1.1"}
        assert got(wbs_path__descendant="3") == set()

    def test_descendant_accepts_an_outerref(self, project: Project) -> None:
        from django.db.models import Exists, OuterRef

        for p in ["1", "1.1", "2"]:
            Task.objects.create(project=project, name=p, duration=1, wbs_path=p)
        has_child = Task.objects.filter(project=project, wbs_path__descendant=OuterRef("wbs_path"))
        parents = Task.objects.filter(project=project).filter(Exists(has_child))
        assert {str(t.wbs_path) for t in parents} == {"1"}

    def test_no_startswith_left_on_wbs_path(self) -> None:
        from pathlib import Path

        import trueppm_api

        root = Path(inspect.getfile(trueppm_api)).parent
        offenders = [
            str(p.relative_to(root))
            for p in root.rglob("*.py")
            if "migrations" not in p.parts
            and p.name != "fields.py"
            and re.search(r"wbs_path__startswith\s*=", p.read_text())
        ]
        assert offenders == []

    def test_no_pure_subtree_regex_left_on_wbs_path(self) -> None:
        """A bare ``^<path>\\.`` regex on wbs_path is a subtree match the GiST index can't use."""
        from pathlib import Path

        import trueppm_api

        root = Path(inspect.getfile(trueppm_api)).parent
        pattern = re.compile(r'wbs_path__regex\s*=\s*rf?"\^\{[^}]+\}\\\."')
        offenders = [
            str(p.relative_to(root))
            for p in root.rglob("*.py")
            if "migrations" not in p.parts and pattern.search(p.read_text())
        ]
        assert offenders == []

    def test_descendant_with_empty_path_matches_nothing(self, project: Project) -> None:
        for p in ["1", "1.1", "2"]:
            Task.objects.create(project=project, name=p, duration=1, wbs_path=p)
        assert not Task.objects.filter(project=project, wbs_path__descendant="").exists()
        assert not Task.objects.filter(project=project, wbs_path__descendant="  ").exists()
        # In an OR the empty branch contributes nothing; the other branch still matches.
        from django.db.models import Q

        got = Task.objects.filter(
            Q(wbs_path__descendant="") | Q(wbs_path__descendant="1"), project=project
        )
        assert {str(t.wbs_path) for t in got} == {"1.1"}


class TestMigratedRegexSites:
    def test_cascade_scope_excludes_label_prefix_siblings(self, project: Project) -> None:
        from trueppm_api.apps.projects.task_classification import (
            ClassificationSpec,
            resolve_subtree,
        )

        by_path = {
            p: Task.objects.create(project=project, name=p, duration=1, wbs_path=p)
            for p in ["1", "1.1", "1.1.1", "10", "10.1", "2"]
        }
        spec = ClassificationSpec(
            subtree_id=by_path["1"].pk,
            cascade=True,
            governance_class=None,
            delivery_mode=None,
            preserve_governance_overrides=False,
            skip_milestones=False,
        )
        from django.db import transaction

        with transaction.atomic():
            rows = resolve_subtree(project, spec)
        assert {str(t.wbs_path) for t in rows} == {"1", "1.1", "1.1.1"}

    def test_summary_detection_ignores_label_prefix_paths(self, project: Project) -> None:
        """Task "1" with only "10.x" around it has no children, so it is not a phase."""
        from types import SimpleNamespace

        from trueppm_api.apps.projects.serializers import TaskSerializer

        lone = Task.objects.create(project=project, name="1", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="10", duration=1, wbs_path="10")
        Task.objects.create(project=project, name="10.1", duration=1, wbs_path="10.1")
        sprint = SimpleNamespace(start_date=None, finish_date=None)
        assert "summary_in_sprint" not in TaskSerializer()._evaluate_task_guardrails(lone, sprint)

        Task.objects.create(project=project, name="1.1", duration=1, wbs_path="1.1")
        from rest_framework.exceptions import ValidationError

        with pytest.raises(ValidationError):
            TaskSerializer()._evaluate_task_guardrails(lone, sprint)

    def test_parent_filter_excludes_label_prefix_subtasks(
        self, client: APIClient, project: Project
    ) -> None:
        parent = Task.objects.create(project=project, name="P", duration=1, wbs_path="1")
        mine = Task.objects.create(
            project=project, name="mine", duration=1, wbs_path="1.1", is_subtask=True
        )
        Task.objects.create(project=project, name="P10", duration=1, wbs_path="10")
        other = Task.objects.create(
            project=project, name="other", duration=1, wbs_path="10.1", is_subtask=True
        )
        resp = client.get(f"/api/v1/tasks/?parent={parent.pk}&project={project.pk}")
        assert resp.status_code == 200
        rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
        ids = {str(r["id"]) for r in rows}
        assert str(mine.pk) in ids
        assert str(other.pk) not in ids
        assert str(parent.pk) not in ids


# ---------------------------------------------------------------------------
# A1 / C3 — phases
# ---------------------------------------------------------------------------


class TestPhases:
    def test_list_is_capped_and_stays_a_bare_array(
        self, client: APIClient, project: Project
    ) -> None:
        _roots(project, 3)
        with patch("trueppm_api.apps.projects.views.PHASE_MAX", 2):
            resp = client.get(f"/api/v1/projects/{project.pk}/phases/")
        assert resp.status_code == 200
        assert isinstance(resp.data, list)
        assert len(resp.data) == 2

    def test_create_refused_at_cap(self, client: APIClient, project: Project) -> None:
        _roots(project, 2)
        with patch("trueppm_api.apps.projects.views.PHASE_MAX", 2):
            resp = client.post(
                f"/api/v1/projects/{project.pk}/phases/", {"name": "One too many"}, format="json"
            )
        assert resp.status_code == 400
        assert PHASE_MAX == 200

    def test_reorder_is_constant_queries_and_bumps_counters(
        self, client: APIClient, project: Project
    ) -> None:
        def run(n: int) -> int:
            Task.objects.filter(project=project).delete()
            tasks = _roots(project, n)
            body = {
                "phases": [
                    {"id": str(t.pk), "server_version": t.server_version} for t in reversed(tasks)
                ]
            }
            with CaptureQueriesContext(connection) as ctx:
                resp = client.patch(
                    f"/api/v1/projects/{project.pk}/phases/reorder/", body, format="json"
                )
            assert resp.status_code == 200, resp.data
            return len(ctx)

        assert run(3) == run(12)

    def test_reorder_persists_order_version_and_sync_cursor(
        self, client: APIClient, project: Project
    ) -> None:
        a, b = _roots(project, 2)
        before = {t.pk: (t.server_version, t.sync_seq) for t in (a, b)}
        resp = client.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            {
                "phases": [
                    {"id": str(b.pk), "server_version": b.server_version},
                    {"id": str(a.pk), "server_version": a.server_version},
                ]
            },
            format="json",
        )
        assert resp.status_code == 200
        a.refresh_from_db()
        b.refresh_from_db()
        assert (b.priority_rank, a.priority_rank) == (10, 20)
        for t in (a, b):
            assert t.server_version == before[t.pk][0] + 1
            # The delta pull filters sync_seq > since: a reorder must be visible to it.
            assert t.sync_seq > before[t.pk][1]
        assert a.history.count() >= 2  # bulk path still writes history

    def test_reorder_still_broadcasts_on_commit(
        self, client: APIClient, project: Project, django_capture_on_commit_callbacks: Any
    ) -> None:
        (a,) = _roots(project, 1)
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bc,
            django_capture_on_commit_callbacks(execute=True),
        ):
            client.patch(
                f"/api/v1/projects/{project.pk}/phases/reorder/",
                {"phases": [{"id": str(a.pk), "server_version": a.server_version}]},
                format="json",
            )
        assert any(c.args[1] == "phases_reordered" for c in bc.call_args_list)


# ---------------------------------------------------------------------------
# A2 — task links
# ---------------------------------------------------------------------------


def test_task_link_create_refused_at_cap(client: APIClient, project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=1, wbs_path="1")
    with patch("trueppm_api.apps.integrations.views.TASK_LINK_MAX", 2):
        for i in range(2):
            TaskLink.objects.create(task=task, url=f"https://example.com/{i}", provider="generic")
        resp = client.post(
            f"/api/v1/projects/{project.pk}/tasks/{task.pk}/links/",
            {"url": "https://example.com/extra"},
            format="json",
        )
    assert resp.status_code == 400
    assert TASK_LINK_MAX == 100


def test_unpaginated_viewsets_are_capped_or_allowlisted() -> None:
    """Every ``pagination_class = None`` viewset enforces a cap constant or is named here.

    The guard checks only the ``pagination_class = None`` shape; ``@suppress_list_pagination``
    handlers are not covered.
    """
    import importlib
    import pkgutil

    import trueppm_api.apps as apps_pkg

    allowlist = {
        # Bounded by PROJECT_CUSTOM_FIELD_MAX on create.
        "ProjectCustomFieldViewSet",
        # Per-task link count capped by TASK_LINK_MAX on create.
        "TaskLinkViewSet",
        # Stakeholder roster: bounded by the project's own stakeholder list.
        "ExternalStakeholderViewSet",
        # Known gap, tracked in #2346 (fully unpaginated relation list).
        "TaskRelationViewSet",
    }
    found: set[str] = set()
    for info in pkgutil.walk_packages(apps_pkg.__path__, "trueppm_api.apps."):
        leaf = info.name.rsplit(".", 1)[-1]
        if info.ispkg or not (leaf == "views" or leaf.endswith("_views")):
            continue
        mod = importlib.import_module(info.name)
        for name, obj in vars(mod).items():
            if (
                inspect.isclass(obj)
                and obj.__module__ == mod.__name__
                and "pagination_class" in vars(obj)
                and obj.pagination_class is None
            ):
                found.add(name)
    assert found <= allowlist, f"needs a cap or allow-list entry: {found - allowlist}"
    assert allowlist <= found, f"stale allow-list entry (no longer matches): {allowlist - found}"


# ---------------------------------------------------------------------------
# A3 — baseline snapshot order
# ---------------------------------------------------------------------------


def test_baseline_detail_tasks_are_ordered(client: APIClient, project: Project) -> None:
    baseline = Baseline.objects.create(project=project, name="B")
    names = ["delta", "alpha", "charlie", "bravo"]
    BaselineTask.objects.bulk_create(
        [
            BaselineTask(baseline=baseline, task_id=uuid.uuid4(), task_name=n, duration=1)
            for n in names
        ]
    )
    url = f"/api/v1/projects/{project.pk}/baselines/{baseline.pk}/"
    first = [t["task_name"] for t in client.get(url).data["tasks"]]
    second = [t["task_name"] for t in client.get(url).data["tasks"]]
    assert first == second == sorted(names)


# ---------------------------------------------------------------------------
# C1 / C2 — risk paths
# ---------------------------------------------------------------------------


def _risk(project: Project, owner: object, n_tasks: int = 2) -> Risk:
    risk = Risk.objects.create(
        project=project, title="R", probability=3, impact=3, created_by=owner
    )
    tasks = [
        Task.objects.create(project=project, name=f"T{i}", duration=1, wbs_path=str(i))
        for i in range(1, n_tasks + 1)
    ]
    risk.tasks.set(tasks)
    return risk


def _membership_queries(ctx: CaptureQueriesContext) -> int:
    return sum(
        1
        for q in ctx.captured_queries
        if "membership" in q["sql"].lower() and q["sql"].startswith("SELECT")
    )


def test_risk_comment_list_reuses_cached_membership(
    client: APIClient, project: Project, owner: object
) -> None:
    risk = _risk(project, owner)
    RiskComment.objects.create(risk=risk, author=owner, message="hi")
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/comments/")
    assert resp.status_code == 200
    # One lookup (the permission class fills the per-request cache); get_queryset adds none.
    assert _membership_queries(ctx) == 1


def test_risk_update_reads_linked_tasks_from_prefetch(
    client: APIClient, project: Project, owner: object
) -> None:
    risk = _risk(project, owner, n_tasks=3)
    with CaptureQueriesContext(connection) as ctx:
        resp = client.patch(
            f"/api/v1/projects/{project.pk}/risks/{risk.pk}/", {"title": "R2"}, format="json"
        )
    assert resp.status_code == 200
    through_reads = [
        q["sql"]
        for q in ctx.captured_queries
        if q["sql"].startswith("SELECT") and "projects_risk_tasks" in q["sql"]
    ]
    # prefetch (old set) + the post-save re-read; the pre-save values_list is gone.
    assert len(through_reads) <= 2, through_reads


# ---------------------------------------------------------------------------
# C4 — time entries single query
# ---------------------------------------------------------------------------


def test_task_time_entries_total_matches_and_uses_one_entry_query(
    client: APIClient, project: Project, owner: object
) -> None:
    from trueppm_api.apps.timetracking.models import TimeEntry

    task = Task.objects.create(project=project, name="T", duration=1, wbs_path="1")
    for m in (30, 45):
        TimeEntry.objects.create(task=task, user=owner, entry_date=date(2026, 1, 2), minutes=m)
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get(f"/api/v1/tasks/{task.pk}/time-entries/")
    assert resp.status_code == 200
    assert resp.data["total_logged_minutes"] == 75
    assert len(resp.data["results"]) == 2
    assert not any("SUM(" in q["sql"] for q in ctx.captured_queries)


# ---------------------------------------------------------------------------
# B1 / B2 — indexes declared
# ---------------------------------------------------------------------------


def test_sort_and_filter_indexes_exist() -> None:
    from trueppm_api.apps.taskruns.models import TaskRun

    assert any(i.fields == ["start_date", "name"] for i in Project._meta.indexes)
    assert any(i.fields == ["project", "task_name", "-created_at"] for i in TaskRun._meta.indexes)


# ---------------------------------------------------------------------------
# A4 — workspace export job order
# ---------------------------------------------------------------------------


def test_workspace_export_jobs_have_stable_order_with_equal_created_at(
    project: Project,
) -> None:
    from django.utils import timezone

    from trueppm_api.apps.workspace.models import WorkspaceExportJob

    su = User.objects.create_superuser(username="ws-root", password="pw", email="r@example.com")
    jobs = [WorkspaceExportJob.objects.create() for _ in range(12)]
    # Force a single shared timestamp so only the ``-id`` tie-break decides the order.
    WorkspaceExportJob.objects.filter(pk__in=[j.pk for j in jobs]).update(created_at=timezone.now())
    c = APIClient()
    c.force_authenticate(user=su)
    resp = c.get("/api/v1/workspace/export/")
    assert resp.status_code == 200, resp.data
    got = [str(r["id"]) for r in resp.data["results"]]
    assert got == sorted((str(j.pk) for j in jobs), reverse=True)
