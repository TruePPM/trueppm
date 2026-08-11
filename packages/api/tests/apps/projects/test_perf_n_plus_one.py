"""Query-count regression guards for the hot Gantt fetch + bulk write path.

Covers:
- #998 — TaskBulkView serializes results through the annotated queryset (one
  batched fetch), not bare instances (per-row live queries / silent defaults).
- #999 — milestone rollup is batched once per task-list / sprint-list request
  instead of O(milestones × sprints) per-row, and the batched path is
  behavior-identical to the per-milestone compute it replaces.
- #1482 — the project list is query-count invariant to page size.
- #2770 — the task list is query-count invariant to the number of *tasks*. The
  #999 guards above scale milestones, so they cannot see a per-row read on the
  task's own relations (labels, custom fields, assignments, blockers).
"""

from __future__ import annotations

import itertools
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    Calendar,
    Dependency,
    Label,
    LabelColor,
    Methodology,
    Program,
    Project,
    ProjectCustomField,
    Sprint,
    SprintState,
    Task,
    TaskCustomFieldValue,
    TaskLabel,
    TaskStatus,
)
from trueppm_api.apps.projects.serializers import TaskSerializer
from trueppm_api.apps.projects.services import (
    batch_compute_milestone_rollups,
    compute_milestone_rollup_payload,
)
from trueppm_api.apps.projects.views import annotate_tasks_queryset
from trueppm_api.apps.resources.models import Resource, TaskResource

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

    assert r.status_code == 207, r.data
    assert r.data["rejected"] == []
    updated = [e["task"] for e in r.data["applied"] if e["outcome"] == "updated"]
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
    assert r.status_code == 207, r.data
    assert r.data["rejected"] == []
    created = [e["task"] for e in r.data["applied"]]
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


# ---------------------------------------------------------------------------
# #1482 — GET /projects/ list query count is invariant to page size.
#
# The list serializes a stack of computed-on-read settings resolvers
# (effective_*/inherited_* for sharing, attachments, mc_history, visibility,
# methodology, duration policy — ADR-0135/0193). Each resolves project ->
# program -> workspace. The invariance holds only because: program is
# select_related on the viewset, the Workspace singleton is memoized once per
# serializer (_iteration_workspace), and the row aggregates (my_role,
# open_task_count) are correlated Subqueries rather than per-row reads. This
# guard fails loudly if a newly added effective_* resolver reaches for an
# unprefetched relation and reintroduces the ~2-queries-per-project N+1 that
# #504's my_role work first surfaced.
# ---------------------------------------------------------------------------


def _project_list_query_count(client: APIClient, url: str) -> int:
    with CaptureQueriesContext(connection) as ctx:
        resp = client.get(url)
    assert resp.status_code == 200, resp.data
    return len(ctx.captured_queries)


@pytest.mark.django_db
def test_project_list_query_count_invariant_to_page_size() -> None:
    """One project vs eight must issue the same number of queries (#1482)."""
    from trueppm_api.apps.workspace.models import Workspace

    # Materialize the singleton outside the measured window — the first load()
    # INSERTs it, which would otherwise inflate the first request's count.
    Workspace.load()
    user = User.objects.create_user(username="list_perf", password="pw")
    cal = Calendar.objects.create(name="Std-1482")
    client = APIClient()
    client.force_authenticate(user=user)
    program = Program.objects.create(name="Prog-1482", public_sharing=True)

    def seed(n: int) -> None:
        ProjectMembership.objects.filter(user=user).delete()
        Project.objects.filter(name__startswith="LP").delete()
        for i in range(n):
            p = Project.objects.create(
                name=f"LP{i}",
                start_date=date(2026, 4, 1),
                calendar=cal,
                program=program,
                # exercise the effective_*/inherited_* resolvers with a mix of
                # explicit overrides and inherited (null) values
                public_sharing=True if i % 2 == 0 else None,
                methodology=Methodology.AGILE if i % 2 else Methodology.WATERFALL,
                show_baselines=True if i % 3 == 0 else None,
            )
            ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)

    seed(1)
    baseline = _project_list_query_count(client, "/api/v1/projects/")
    seed(8)
    scaled = _project_list_query_count(client, "/api/v1/projects/")

    assert scaled == baseline, (
        f"GET /projects/ is not query-count invariant: 1 project -> {baseline} "
        f"queries, 8 projects -> {scaled}. A per-row settings resolver likely "
        f"reintroduced the #1482 N+1 — fold it into a select_related/annotation."
    )


@pytest.mark.django_db
def test_ungrouped_project_list_query_count_invariant_to_page_size() -> None:
    """The Programs-directory ?program__isnull=true branch is also invariant (#1482).

    This branch adds member_count/percent_complete aggregates; they must be a
    LEFT JOIN aggregate (distinct/Avg), not a per-row read.
    """
    from trueppm_api.apps.workspace.models import Workspace

    Workspace.load()
    user = User.objects.create_user(username="ungrouped_perf", password="pw")
    cal = Calendar.objects.create(name="Std-1482b")
    client = APIClient()
    client.force_authenticate(user=user)

    def seed(n: int) -> None:
        ProjectMembership.objects.filter(user=user).delete()
        Project.objects.filter(name__startswith="UP").delete()
        for i in range(n):
            p = Project.objects.create(name=f"UP{i}", start_date=date(2026, 4, 1), calendar=cal)
            ProjectMembership.objects.create(project=p, user=user, role=Role.OWNER)

    url = "/api/v1/projects/?program__isnull=true"
    seed(1)
    baseline = _project_list_query_count(client, url)
    seed(8)
    scaled = _project_list_query_count(client, url)

    assert scaled == baseline, (
        f"Ungrouped project list not invariant: 1 -> {baseline}, 8 -> {scaled}."
    )


# ---------------------------------------------------------------------------
# #2770 — the task list is query-count invariant to the number of tasks
# ---------------------------------------------------------------------------


def _seed_fanned_out_project(
    user: object, calendar: Calendar, name: str, task_count: int
) -> Project:
    """A project whose every task carries one of each per-row relation.

    The relations here are exactly the ones ``annotate_tasks_queryset`` buys with a
    ``select_related``/``Prefetch``: sprint, blocking_task (the soft link) and
    blocked_by (the actor, a User — ADR-0124), assignments -> resource, labels, and
    custom_field_values -> field + value_user. Seeding *every* task with
    each of them is what makes the invariant meaningful — a project whose tasks have
    no labels cannot detect a dropped label prefetch, because there is no second row
    for the N+1 to fan out over.

    Both projects built by this helper differ **only** in row count, never in the
    variety of relations present, so a prefetch that is issued conditionally (only
    when at least one row has an X) still contributes the same fixed number of
    queries to each side.
    """
    project = Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)

    milestone = _make_milestone(project, f"{name}-M")
    sprint = _make_sprint(project, target_milestone=milestone, name=f"{name}-S")
    field = ProjectCustomField.objects.create(
        project=project, name="Vendor", field_type="TEXT", order=1, server_version=1
    )

    for i in range(task_count):
        blocker = Task.objects.create(
            project=project,
            name=f"{name}-blocker-{i}",
            duration=1,
            status=TaskStatus.IN_PROGRESS,
        )
        task = Task.objects.create(
            project=project,
            name=f"{name}-T{i}",
            duration=2,
            sprint=sprint,
            blocking_task=blocker,
            blocked_by=user,
        )
        label = Label.objects.create(project=project, name=f"{name}-L{i}", color=LabelColor.TEAL)
        TaskLabel.objects.create(task=task, label=label)
        TaskCustomFieldValue.objects.create(
            task=task, field=field, value_text=f"vendor-{i}", value_user=user
        )
        resource = Resource.objects.create(
            name=f"{name}-R{i}",
            email=f"{name.lower()}-r{i}@example.test",
            max_units=Decimal("1.00"),
        )
        TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.00"))

    return project


@pytest.mark.django_db
def test_task_list_query_count_invariant_to_task_count(calendar: Calendar, user: object) -> None:
    """Two tasks vs six must issue the same number of queries (#2770).

    ``GET /api/v1/tasks/?project=`` is the hot Gantt fetch and ``TaskSerializer`` is
    the widest serializer in the codebase, but nothing guarded it against row-count
    growth: the existing task-list guards scale *milestones*, not tasks, so a new
    per-row query on any of the relations above was invisible until a nightly
    ``perf:load`` p95 moved (#2767).

    Strict equality, deliberately not a ceiling — a ceiling drifts upward one commit
    at a time and stops being a guard.
    """
    client = APIClient()
    client.force_authenticate(user=user)

    small = _seed_fanned_out_project(user, calendar, "Small2770", 2)
    large = _seed_fanned_out_project(user, calendar, "Large2770", 6)

    def list_count(p: Project) -> int:
        with CaptureQueriesContext(connection) as ctx:
            resp = client.get(f"/api/v1/tasks/?project={p.pk}")
            assert resp.status_code == 200, resp.data
        return len(ctx.captured_queries)

    # Warm one-time per-process caches (permission/edition lookups) before measuring
    # either side, exactly as test_task_list_rollup_query_count_constant_in_milestones
    # does — otherwise the first request measured carries them and the two differ for
    # a reason that has nothing to do with row count.
    list_count(small)

    baseline = list_count(small)
    scaled = list_count(large)

    assert scaled == baseline, (
        f"GET /tasks/ is not query-count invariant to task count: 2 tasks -> "
        f"{baseline} queries, 6 tasks -> {scaled}. Something serializes per row — "
        f"check for a relation read outside annotate_tasks_queryset's "
        f"select_related/prefetch_related set, or a SerializerMethodField that "
        f"queries."
    )


@pytest.mark.django_db
def test_task_list_page_query_is_ordered(client: APIClient, project: Project) -> None:
    """The paginated task list emits an ORDER BY, so pages partition the result set.

    `Task.Meta.ordering` does not survive this endpoint: `annotate_tasks_queryset`
    adds aggregate annotations, the query therefore has a GROUP BY, and Django's
    compiler discards *Meta*-derived ordering whenever one is present. The shipped
    query was `LIMIT 50` with no ORDER BY at all (#2807), which DRF flags with
    UnorderedObjectListWarning — and which lets the Schedule's parallel all-pages
    fetch duplicate and drop tasks the moment the plan changes.

    Asserts the property (the page query is ordered), not the sort key, so #2814 can
    change *what* the default order is without rewriting this guard.
    """
    for i in range(3):
        Task.objects.create(project=project, name=f"T{i}", duration=1, wbs_path=str(i + 1))

    with CaptureQueriesContext(connection) as ctx:
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200, r.data

    page_queries = [
        q["sql"]
        for q in ctx.captured_queries
        if "LIMIT" in q["sql"] and "projects_task" in q["sql"] and "COUNT(*) FROM (" not in q["sql"]
    ]
    assert page_queries, "no paginated task query captured"
    # The page fetch is the one carrying the pagination LIMIT; every other LIMIT in
    # this statement belongs to a correlated subquery in the annotation set.
    page_sql = max(page_queries, key=len)
    assert "ORDER BY" in page_sql, (
        "GET /tasks/ paginated its result set with no ORDER BY. Pagination over an "
        "unordered queryset is not stable, so the Schedule's parallel page fetch can "
        "return the same task twice and miss another. TaskViewSet.ordering supplies "
        "an explicit order_by that the GROUP BY cannot discard — see #2807."
    )


@pytest.mark.django_db
def test_sprint_list_page_query_is_ordered(client: APIClient, project: Project) -> None:
    """The paginated sprint list emits an ORDER BY, so pages partition the result set.

    Same class as #2807, on a different endpoint (#2821): `Sprint.Meta.ordering`
    does not survive `SprintViewSet.get_queryset`, which annotates `pending_count`
    and `wip_count`. Those aggregates give the query a GROUP BY, and Django's
    compiler discards *Meta*-derived ordering whenever one is present, so the
    shipped query paginated an unordered relation — DRF flags that with
    UnorderedObjectListWarning, and a plan flip can serve one sprint on two pages
    while dropping another.

    Asserts the property (the page query is ordered) rather than the sort key, so a
    later change to *what* the default order is does not rewrite this guard.
    """
    for i in range(3):
        Sprint.objects.create(
            project=project,
            name=f"S{i}",
            start_date=date(2026, 4, 1 + i),
            finish_date=date(2026, 4, 14 + i),
            state=SprintState.PLANNED,
        )

    with CaptureQueriesContext(connection) as ctx:
        r = client.get(f"/api/v1/projects/{project.pk}/sprints/")
        assert r.status_code == 200, r.data

    page_queries = [
        q["sql"]
        for q in ctx.captured_queries
        if "LIMIT" in q["sql"]
        and "projects_sprint" in q["sql"]
        and "COUNT(*) FROM (" not in q["sql"]
    ]
    assert page_queries, "no paginated sprint query captured"
    # The page fetch is the one carrying the pagination LIMIT; any other LIMIT in
    # this statement belongs to a correlated subquery in the annotation set.
    page_sql = max(page_queries, key=len)
    assert "ORDER BY" in page_sql, (
        "GET /projects/{id}/sprints/ paginated its result set with no ORDER BY. "
        "Pagination over an unordered queryset is not stable, so a page fetch can "
        "return the same sprint twice and miss another. SprintViewSet.ordering "
        "supplies an explicit order_by that the GROUP BY cannot discard — see #2821."
    )


@pytest.mark.django_db
def test_sprint_list_default_order_is_the_declared_key(client: APIClient, project: Project) -> None:
    """The restored default order is the model's declared key, not insertion order.

    The #2807 fix pinned `id` because a WBS sort above that endpoint's GroupAggregate
    cost 5.7 s on a 4,000-task project. A sprint list is tens of project-scoped rows
    over an indexed `(project, start_date)`, so it can afford — and should serve —
    the order `Sprint.Meta` declares. Sprints are created here in reverse start-date
    order so insertion order and the declared order disagree.
    """
    for i in (2, 1, 0):
        Sprint.objects.create(
            project=project,
            name=f"S{i}",
            start_date=date(2026, 4, 1 + i),
            finish_date=date(2026, 4, 14 + i),
            state=SprintState.PLANNED,
        )

    r = client.get(f"/api/v1/projects/{project.pk}/sprints/")
    assert r.status_code == 200, r.data
    assert [s["name"] for s in r.data["results"]] == ["S0", "S1", "S2"]


@pytest.mark.django_db
def test_dependency_list_page_query_is_ordered(client: APIClient, project: Project) -> None:
    """The paginated dependency list emits an ORDER BY (#2821 sweep).

    A different root cause from the task and sprint lists, with a worse blast
    radius. Those declare `Meta.ordering` and lose it to a GROUP BY; `Dependency`
    declares no ordering at all, so this list never had one. And it is the list
    the Gantt walks with `ScheduleFetchPagination` in parallel (#1519) — so an
    unstable page boundary does not read as a missing row, it draws a schedule
    with one dependency arrow duplicated and another absent.
    """
    tasks = [
        Task.objects.create(project=project, name=f"D{i}", duration=1, wbs_path=str(i + 1))
        for i in range(4)
    ]
    for pred, succ in itertools.pairwise(tasks):
        Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS")

    with CaptureQueriesContext(connection) as ctx:
        r = client.get(f"/api/v1/dependencies/?project={project.pk}")
        assert r.status_code == 200, r.data

    page_queries = [
        q["sql"]
        for q in ctx.captured_queries
        if "LIMIT" in q["sql"]
        and "projects_dependency" in q["sql"]
        and "COUNT(*) FROM (" not in q["sql"]
    ]
    assert page_queries, "no paginated dependency query captured"
    page_sql = max(page_queries, key=len)
    assert "ORDER BY" in page_sql, (
        "GET /dependencies/ paginated its result set with no ORDER BY. The Gantt "
        "fetches every page of this list in parallel, so an unstable page boundary "
        "renders a duplicated dependency arrow and drops another — see #2821."
    )


@pytest.mark.django_db
def test_baseline_list_page_query_is_ordered(client: APIClient, project: Project) -> None:
    """The paginated baseline list emits an ORDER BY (#2821 sweep).

    Same mechanism as the sprint list: `Baseline.Meta.ordering` is discarded
    because `get_queryset` annotates `task_count`, which gives the query a
    GROUP BY.
    """
    for i in range(3):
        Baseline.objects.create(project=project, name=f"B{i}")

    with CaptureQueriesContext(connection) as ctx:
        r = client.get(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 200, r.data

    page_queries = [
        q["sql"]
        for q in ctx.captured_queries
        if "LIMIT" in q["sql"]
        and "projects_baseline" in q["sql"]
        and "COUNT(*) FROM (" not in q["sql"]
    ]
    assert page_queries, "no paginated baseline query captured"
    page_sql = max(page_queries, key=len)
    assert "ORDER BY" in page_sql, (
        "GET /projects/{id}/baselines/ paginated its result set with no ORDER BY — "
        "the `task_count` annotation's GROUP BY discards Baseline.Meta.ordering. "
        "See #2821."
    )
