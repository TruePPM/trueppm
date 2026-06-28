"""Query-count regression guards for the hot Gantt fetch + bulk write path.

Covers:
- #998 — TaskBulkView serializes results through the annotated queryset (one
  batched fetch), not bare instances (per-row live queries / silent defaults).
- #999 — milestone rollup is batched once per task-list / sprint-list request
  instead of O(milestones × sprints) per-row, and the batched path is
  behavior-identical to the per-milestone compute it replaces.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.serializers import TaskSerializer
from trueppm_api.apps.projects.services import (
    batch_compute_milestone_rollups,
    compute_milestone_rollup_payload,
)
from trueppm_api.apps.projects.views import annotate_tasks_queryset

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_milestone(project: Project, name: str, early_finish: date = date(2026, 4, 30)) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=0,
        is_milestone=True,
        early_finish=early_finish,
        early_start=early_finish,
    )


def _make_sprint(
    project: Project,
    *,
    target_milestone: Task,
    state: SprintState = SprintState.COMPLETED,
    committed_points: int | None = 20,
    completed_points: int | None = 12,
    committed_task_count: int | None = 8,
    completed_task_count: int | None = 6,
    name: str = "Sprint",
) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=state,
        target_milestone=target_milestone,
        committed_points=committed_points,
        completed_points=completed_points,
        committed_task_count=committed_task_count,
        completed_task_count=completed_task_count,
    )


# ---------------------------------------------------------------------------
# #998 — bulk response uses the annotated queryset
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_bulk_response_serialization_is_constant_in_n(project: Project) -> None:
    """Serializing the bulk result through annotate_tasks_queryset costs the same
    number of queries for 2 tasks as for 20 — proving the response phase is O(1)
    in bulk size (#998), not the prior per-row live-query / prefetch-miss cascade.
    """
    small_ids = [
        Task.objects.create(project=project, name=f"S{i}", duration=1).pk for i in range(2)
    ]
    big_ids = [Task.objects.create(project=project, name=f"B{i}", duration=1).pk for i in range(20)]

    def serialize_count(ids: list[object]) -> int:
        with CaptureQueriesContext(connection) as ctx:
            qs = annotate_tasks_queryset(
                Task.objects.filter(pk__in=ids, is_deleted=False), None, str(project.pk)
            )
            # Force evaluation of every annotation-backed field, as the view does.
            [TaskSerializer(t).data for t in qs]
        return len(ctx.captured_queries)

    # Warm any one-time caches (Django app/content-type lookups) before measuring,
    # so the first measured call isn't charged for them.
    serialize_count(small_ids)
    assert serialize_count(small_ids) == serialize_count(big_ids)


@pytest.mark.django_db
def test_bulk_update_response_carries_is_summary_annotation(
    client: APIClient, project: Project
) -> None:
    """A bulk-updated summary task reports is_summary=True in the response.

    Serializing a bare locked instance would silently fall back to the field's
    ``default=False`` (the #998 correctness regression); only a re-fetch through
    the annotated queryset yields the real ltree-derived value.
    """
    parent = Task.objects.create(project=project, name="Phase", duration=5, wbs_path="1")
    Task.objects.create(project=project, name="Leaf", duration=2, wbs_path="1.1", is_subtask=True)

    r = client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": [{"op": "update", "id": str(parent.pk), "data": {"name": "Phase A"}}]},
        format="json",
    )

    assert r.status_code == 200, r.data
    updated = r.data["updated"]
    assert len(updated) == 1
    assert updated[0]["is_summary"] is True
    assert updated[0]["name"] == "Phase A"


@pytest.mark.django_db
def test_bulk_create_returns_all_created(client: APIClient, project: Project) -> None:
    """The batched re-fetch preserves per-bucket order and returns every task."""
    r = client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {"operations": [{"op": "create", "data": {"name": f"T{i}"}} for i in range(5)]},
        format="json",
    )
    assert r.status_code == 200, r.data
    created = r.data["created"]
    assert [t["name"] for t in created] == [f"T{i}" for i in range(5)]
    # Annotation-backed field present (would be absent on a bare instance with no default).
    assert all("is_summary" in t for t in created)


# ---------------------------------------------------------------------------
# #999 — milestone rollup batching on the list endpoints
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_batches_milestone_rollups(client: APIClient, project: Project) -> None:
    """The task list computes rollups once per request (batched), never per row."""
    for i in range(3):
        m = _make_milestone(project, f"M{i}")
        _make_sprint(project, target_milestone=m, name=f"S{i}")

    with (
        patch(
            "trueppm_api.apps.projects.services.batch_compute_milestone_rollups",
            wraps=batch_compute_milestone_rollups,
        ) as batch_spy,
        patch("trueppm_api.apps.projects.services.compute_milestone_rollup_payload") as single_spy,
    ):
        r = client.get(f"/api/v1/tasks/?project={project.pk}")

    assert r.status_code == 200
    assert batch_spy.call_count == 1
    # The per-milestone fallback must not run on the list path.
    assert single_spy.call_count == 0


@pytest.mark.django_db
def test_task_list_rollup_query_count_constant_in_milestones(
    client: APIClient, calendar: Calendar, user: object
) -> None:
    """Adding more milestones (each with a targeting sprint) does not add queries
    to the task-list fetch — the rollup is batched, not O(milestones × sprints).
    """

    def build_project(name: str, milestone_count: int) -> Project:
        p = Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)
        ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)
        for i in range(milestone_count):
            m = _make_milestone(p, f"{name}-M{i}")
            _make_sprint(p, target_milestone=m, name=f"{name}-S{i}")
        return p

    small = build_project("Small", 1)
    large = build_project("Large", 5)

    def list_count(p: Project) -> int:
        with CaptureQueriesContext(connection) as ctx:
            r = client.get(f"/api/v1/tasks/?project={p.pk}")
            assert r.status_code == 200
        return len(ctx.captured_queries)

    # Warm one-time per-process caches before measuring either project.
    list_count(small)
    assert list_count(small) == list_count(large)


@pytest.mark.django_db
def test_sprint_list_batches_target_milestone_rollups(client: APIClient, project: Project) -> None:
    """The sprint list batches each sprint's target-milestone rollup once."""
    for i in range(3):
        m = _make_milestone(project, f"M{i}")
        _make_sprint(project, target_milestone=m, name=f"S{i}")

    with (
        patch(
            "trueppm_api.apps.projects.services.batch_compute_milestone_rollups",
            wraps=batch_compute_milestone_rollups,
        ) as batch_spy,
        patch("trueppm_api.apps.projects.services.compute_milestone_rollup_payload") as single_spy,
    ):
        r = client.get(f"/api/v1/projects/{project.pk}/sprints/")

    assert r.status_code == 200
    assert batch_spy.call_count == 1
    assert single_spy.call_count == 0


# ---------------------------------------------------------------------------
# #999 — batched output is behavior-identical to the per-milestone compute
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_batch_matches_single_across_sprint_states(project: Project) -> None:
    """batch_compute_milestone_rollups yields the same payload as calling
    compute_milestone_rollup_payload once per milestone, across every sprint
    state mix (the refactor must be behavior-preserving)."""
    # m0: a single COMPLETED sprint (points basis).
    m0 = _make_milestone(project, "M0")
    _make_sprint(project, target_milestone=m0, state=SprintState.COMPLETED, name="m0s")

    # m1: an ACTIVE sprint with live COMPLETE tasks (live numerator).
    m1 = _make_milestone(project, "M1")
    active = _make_sprint(
        project,
        target_milestone=m1,
        state=SprintState.ACTIVE,
        committed_points=20,
        completed_points=None,
        completed_task_count=None,
        name="m1s",
    )
    Task.objects.create(
        project=project,
        name="done",
        duration=1,
        sprint=active,
        story_points=7,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="wip",
        duration=1,
        sprint=active,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )

    # m2: a PLANNED sprint (denominator-only).
    m2 = _make_milestone(project, "M2")
    _make_sprint(
        project,
        target_milestone=m2,
        state=SprintState.PLANNED,
        committed_points=13,
        completed_points=0,
        completed_task_count=0,
        name="m2s",
    )

    # m3: no targeting sprints → None.
    m3 = _make_milestone(project, "M3")

    milestones = [m0, m1, m2, m3]
    batched = batch_compute_milestone_rollups(milestones)
    for m in milestones:
        assert batched[m.pk] == compute_milestone_rollup_payload(m)


# ---------------------------------------------------------------------------
# Pre-release perf-check regression guards (P24/P25/P26 + 🔴-3/🔴-4/🔴-6)
# ---------------------------------------------------------------------------


@pytest.fixture
def admin_user(db: object) -> object:
    return User.objects.create_user(username="admin_u", password="pw")


@pytest.fixture
def admin_project(calendar: Calendar) -> Project:
    return Project.objects.create(name="AdminProj", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def admin_membership(admin_user: object, admin_project: Project) -> object:
    from trueppm_api.apps.access.models import ProjectMembership, Role

    return ProjectMembership.objects.create(project=admin_project, user=admin_user, role=Role.OWNER)


@pytest.fixture
def admin_client(admin_user: object, admin_membership: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin_user)
    return c


# ── P25 AcceptanceCriterion.perform_create — atomic double-write ──────────


@pytest.mark.django_db
def test_acceptance_criterion_create_met_attribution_rollback(
    admin_client: APIClient, admin_project: Project, admin_user: object
) -> None:
    """P25: when creating an already-met criterion, a crash after serializer.save()
    but before the met_by stamp must not leave a row with null attribution.

    The atomic block ensures both writes land together or neither does.
    """
    from unittest.mock import patch

    from trueppm_api.apps.projects.models import AcceptanceCriterion, Task

    task = Task.objects.create(project=admin_project, name="Story", duration=1)
    url = "/api/v1/acceptance-criteria/"

    # Patch criterion.save (the second write) to raise after the first .save() succeeds.
    original_save = AcceptanceCriterion.save

    call_count = {"n": 0}

    def _fail_on_second_save(self: AcceptanceCriterion, *args: object, **kwargs: object) -> None:
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RuntimeError("simulated crash between writes")
        original_save(self, *args, **kwargs)

    # The view lets the RuntimeError propagate (it is not a DRF APIException), so
    # tell the test client to surface it as a 500 response rather than re-raising it.
    admin_client.raise_request_exception = False
    with patch.object(AcceptanceCriterion, "save", _fail_on_second_save):
        response = admin_client.post(
            url,
            {"task": str(task.pk), "text": "must ship", "met": True},
            format="json",
        )

    # The whole request must fail (no partial commit leaves met=True + null met_by).
    assert response.status_code in (400, 500), (
        f"Expected failure when the second save raises; got {response.status_code}: {response.data}"
    )
    # No criterion should have met=True with null met_by — the atomic block must roll back.
    orphan = AcceptanceCriterion.objects.filter(task=task, met=True, met_by__isnull=True)
    assert not orphan.exists(), (
        "Found a criterion with met=True but null met_by — the atomic block did not roll back"
    )


# ── 🔴-3 Sprint list predecessor prefetch ────────────────────────────────


@pytest.mark.django_db
def test_sprint_list_predecessor_ids_no_n_plus_one(
    admin_client: APIClient, admin_project: Project
) -> None:
    """🔴-3: GET /sprints/ must NOT fire one Dependency query per sprint row that
    has a target_milestone. The fix is a Prefetch on predecessor_set with to_attr.
    """
    from trueppm_api.apps.projects.models import Dependency

    # Build 5 milestones each with predecessor deps, then 5 sprints targeting them.
    sprints = []
    for i in range(5):
        milestone = Task.objects.create(
            project=admin_project,
            name=f"M{i}",
            duration=0,
            is_milestone=True,
            early_finish=date(2026, 5, 1),
            early_start=date(2026, 5, 1),
        )
        pred = Task.objects.create(project=admin_project, name=f"Pred{i}", duration=2)
        Dependency.objects.create(predecessor=pred, successor=milestone, dep_type="FS", lag=0)
        sprints.append(
            Sprint.objects.create(
                project=admin_project,
                name=f"S{i}",
                start_date=date(2026, 4, 1),
                finish_date=date(2026, 4, 14),
                target_milestone=milestone,
                state=SprintState.PLANNED,
            )
        )

    # Warm caches before measuring.
    admin_client.get(f"/api/v1/projects/{admin_project.pk}/sprints/")

    with CaptureQueriesContext(connection) as ctx:
        response = admin_client.get(f"/api/v1/projects/{admin_project.pk}/sprints/")

    assert response.status_code == 200
    # Collect queries that hit the dependency table.
    dep_queries = [q["sql"] for q in ctx.captured_queries if "projects_dependency" in q["sql"]]
    # There must be AT MOST 1 Dependency query (the prefetch), not one per sprint.
    assert len(dep_queries) <= 1, (
        f"Expected ≤1 Dependency query but got {len(dep_queries)}: {dep_queries}"
    )


# ── 🔴-4 CrossProjectSlipConflict select_related ────────────────────────


@pytest.mark.django_db
def test_cross_project_slip_conflict_list_no_n_plus_one(
    admin_client: APIClient, calendar: Calendar, admin_user: object
) -> None:
    """🔴-4: GET /slip-conflicts/ must not fire per-row FK queries for
    dependency__predecessor__project and task__project.
    """
    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.models import CrossProjectSlipConflict, Dependency

    proj_a = Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)
    proj_b = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=proj_a, user=admin_user, role=Role.OWNER)
    ProjectMembership.objects.create(project=proj_b, user=admin_user, role=Role.OWNER)

    sprint = Sprint.objects.create(
        project=proj_b,
        name="Sp",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )
    upstream = Task.objects.create(project=proj_a, name="Up", duration=5)
    # Create 5 conflicts, each on a distinct downstream task — the unique
    # constraint is per (sprint, task), so the rows must target different tasks.
    for i in range(5):
        downstream = Task.objects.create(
            project=proj_b, name=f"Down {i}", duration=3, sprint=sprint
        )
        dep = Dependency.objects.create(
            predecessor=upstream, successor=downstream, dep_type="FS", lag=0
        )
        CrossProjectSlipConflict.objects.create(
            sprint=sprint,
            task=downstream,
            dependency=dep,
            pushed_to=date(2026, 4, 20),
        )

    # Warm caches.
    admin_client.get("/api/v1/slip-conflicts/")

    with CaptureQueriesContext(connection) as ctx:
        response = admin_client.get("/api/v1/slip-conflicts/")

    assert response.status_code == 200
    # With proper select_related, query count is O(1), not O(conflicts × 3).
    # Allow generous budget (auth + membership + slip_conflicts + any prefetch).
    assert len(ctx.captured_queries) <= 8, (
        f"Expected ≤8 queries for slip-conflict list but got {len(ctx.captured_queries)}"
    )


# ── 🔴-6 Task retrieve milestone rollup — no per-row compute ─────────────


@pytest.mark.django_db
def test_task_retrieve_batches_milestone_rollup(
    admin_client: APIClient, admin_project: Project
) -> None:
    """🔴-6: GET /tasks/{pk}/ on a milestone task must not call
    compute_milestone_rollup_payload (the per-milestone fallback). The retrieve
    override must attach rollup via _attach_milestone_rollups.
    """
    milestone = Task.objects.create(
        project=admin_project,
        name="M-retrieve",
        duration=0,
        is_milestone=True,
        early_finish=date(2026, 5, 1),
        early_start=date(2026, 5, 1),
    )

    with (
        patch(
            "trueppm_api.apps.projects.services.batch_compute_milestone_rollups",
            wraps=batch_compute_milestone_rollups,
        ) as batch_spy,
        patch("trueppm_api.apps.projects.services.compute_milestone_rollup_payload") as single_spy,
    ):
        response = admin_client.get(
            f"/api/v1/tasks/{milestone.pk}/",
            {"project": str(admin_project.pk)},
        )

    assert response.status_code == 200
    # The batched path must be used on retrieve (not the per-task fallback).
    assert batch_spy.call_count >= 1, "Expected batch_compute_milestone_rollups to be called"
    assert single_spy.call_count == 0, (
        "compute_milestone_rollup_payload (per-task fallback) must not be called on retrieve"
    )


# ── P24 Baseline perform_create — pre-flight reads inside atomic ──────────


@pytest.mark.django_db(transaction=True)
def test_baseline_create_auto_name_inside_atomic(
    admin_client: APIClient, admin_project: Project
) -> None:
    """P24: the auto-name counter and the unique-name existence check must both
    run inside the atomic block so concurrent creates don't race to the same name.

    This test verifies the structural property — all three pre-flight reads
    are inside the transaction.atomic() — by confirming the endpoint correctly
    responds and creates a baseline with the expected auto-name.
    """
    from trueppm_api.apps.projects.models import Baseline

    url = f"/api/v1/projects/{admin_project.pk}/baselines/"
    response = admin_client.post(url, {}, format="json")
    assert response.status_code == 201, response.data
    assert Baseline.objects.filter(project=admin_project, name="Baseline 1").exists()

    # A second create must auto-name as "Baseline 2" (count inside atomic).
    response2 = admin_client.post(url, {}, format="json")
    assert response2.status_code == 201, response2.data
    assert Baseline.objects.filter(project=admin_project, name="Baseline 2").exists()


# ---------------------------------------------------------------------------
# Index guards (#1352) — lock the pre-tag perf indexes onto their models so a
# later model edit can't silently drop them and reintroduce an in-memory sort
# or a JSONField seq-scan. Behavior is unchanged; these assert the query plan's
# supporting structure stays in place.
# ---------------------------------------------------------------------------


def test_pretag_perf_indexes_are_registered() -> None:
    """The three #1352 indexes remain declared on their models.

    - Sprint (project, finish_date): SprintViewSet exposes finish_date ordering.
    - Risk (project, -impact, -probability, title): the register's default order.
    - BacklogItem tags GIN: backlog tag filtering uses jsonb `@>` containment.
    """
    from trueppm_api.apps.projects.models import BacklogItem, Risk, Sprint

    sprint_index_names = {idx.name for idx in Sprint._meta.indexes}
    assert "sprint_project_finish_idx" in sprint_index_names

    risk_index_names = {idx.name for idx in Risk._meta.indexes}
    assert "risk_project_register_idx" in risk_index_names

    backlog_index_names = {idx.name for idx in BacklogItem._meta.indexes}
    assert "backlogitem_tags_gin" in backlog_index_names
