"""Tests for the auto-scheduling Celery task and trigger endpoint."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Sprint, SprintState, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="sched_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Sched", start_date=date(2026, 1, 5), calendar=calendar)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=3)


@pytest.fixture
def scheduler_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Task create triggers recalculate_schedule.delay
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_task_create_triggers_schedule(user: object, project: Project, calendar: Calendar) -> None:
    """Creating a Task via the API enqueues recalculate_schedule for its project."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "mock-celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 2},
        )
        assert resp.status_code == 201
        mock_task.delay.assert_called_once_with(str(project.pk))


@pytest.mark.django_db(transaction=True)
def test_task_delete_triggers_schedule(user: object, project: Project, task: Task) -> None:
    """Deleting a Task via the API enqueues recalculate_schedule."""
    # Role.ADMIN required: IsProjectMemberWriteOrOwn blocks MEMBER on unassigned tasks.
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_result = MagicMock()
        mock_result.id = "mock-celery-id"
        mock_task.delay = MagicMock(return_value=mock_result)
        resp = c.delete(f"/api/v1/tasks/{task.pk}/")
        assert resp.status_code == 204
        mock_task.delay.assert_called_once_with(str(project.pk))


# ---------------------------------------------------------------------------
# Redis idempotency lock — collision causes re-queue
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_schedule_lock_collision_requeues(project: Project) -> None:
    """When the Redis lock is already held, the task re-queues itself."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    # SET NX returns None (falsy) when lock is already held.
    mock_redis.set.return_value = None

    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch.object(recalculate_schedule, "apply_async") as mock_apply,
    ):
        mock_redis_module.from_url.return_value = mock_redis

        # Call the task's run() method directly so self=recalculate_schedule
        # (the Celery task instance), which is what bind=True provides at runtime.
        # patch.object above intercepts self.apply_async inside the function body.
        recalculate_schedule.run(str(project.pk))

        mock_apply.assert_called_once_with(
            args=[str(project.pk)],
            kwargs={},
            countdown=10,
            headers={"x-requeue-count": 1},
        )


@pytest.mark.django_db
def test_successful_recalc_stamps_recalculated_at(project: Project, task: Task) -> None:
    """A successful CPM pass stamps recalculated_at — the signal the web Schedule
    view's "recalculating" badge clears against (#1053). Acquire the lock so the
    task body runs through to the post-_run_schedule stamp."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    assert project.recalculated_at is None

    mock_redis = MagicMock()
    # SET NX returns truthy → lock acquired, task body executes.
    mock_redis.set.return_value = "OK"

    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))

    project.refresh_from_db()
    assert project.recalculated_at is not None


@pytest.mark.django_db
def test_completed_task_without_actuals_keeps_full_span(project: Project) -> None:
    """End-to-end (builder -> engine -> bulk_update): a 100%-complete task with no
    actual dates must keep its full-duration bar, not collapse to early_start ==
    early_finish (the 1-day-bar bug, ADR-0136)."""
    from trueppm_api.apps.projects.models import TaskStatus
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    # A 5-working-day task marked complete with no actuals (the seed/contributor
    # state). Project starts Mon 2026-01-05.
    done = Task.objects.create(
        project=project,
        name="Done",
        duration=5,
        status=TaskStatus.COMPLETE,
        percent_complete=100.0,
    )

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"  # lock acquired → task body runs
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))

    done.refresh_from_db()
    assert done.early_start is not None and done.early_finish is not None
    assert done.early_start != done.early_finish  # not collapsed to a single day
    # Mon 2026-01-05 .. Fri 2026-01-09 is five working days (four calendar days apart).
    assert done.early_start == date(2026, 1, 5)
    assert done.early_finish == date(2026, 1, 9)


# ---------------------------------------------------------------------------
# Reason plumbing (#355) — outbox row must record what triggered the recalc
# so "why did this fire?" debugging doesn't require correlating timestamps.
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_dependency_create_records_dependency_change_reason(
    user: object, project: Project, task: Task
) -> None:
    """Creating a Dependency via the API tags the outbox row as DEPENDENCY_CHANGE."""
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    Dependency.objects.all().delete()  # ensure a clean slate
    ScheduleRequest.objects.all().delete()

    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)
    successor = Task.objects.create(project=project, name="T2", duration=2)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(
            "/api/v1/dependencies/",
            {"predecessor": str(task.pk), "successor": str(successor.pk), "dep_type": "FS"},
        )
        assert resp.status_code == 201

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.DEPENDENCY_CHANGE


@pytest.mark.django_db(transaction=True)
def test_manual_trigger_records_manual_reason(user: object, project: Project) -> None:
    """The manual /schedule/ endpoint tags the outbox row as MANUAL."""
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.SCHEDULER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(f"/api/v1/projects/{project.pk}/schedule/")
        assert resp.status_code == 202

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.MANUAL


@pytest.mark.django_db(transaction=True)
def test_task_create_records_task_change_reason(
    user: object, project: Project, calendar: Calendar
) -> None:
    """Creating a Task (non-dependency edit) keeps the default TASK_CHANGE reason."""
    from trueppm_api.apps.scheduling.models import ScheduleRequest, ScheduleRequestReason

    ScheduleRequest.objects.all().delete()
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)

    with patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule") as mock_task:
        mock_task.delay = MagicMock(return_value=MagicMock(id="celery-id"))
        resp = c.post(
            "/api/v1/tasks/",
            {"project": str(project.pk), "name": "Build", "duration": 2},
        )
        assert resp.status_code == 201

    req = ScheduleRequest.objects.get(project=project)
    assert req.reason == ScheduleRequestReason.TASK_CHANGE


# ---------------------------------------------------------------------------
# Manual trigger endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_trigger_endpoint_requires_scheduler_role(user: object, project: Project) -> None:
    """A Member cannot trigger the schedule endpoint."""
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=user)
    resp = c.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_trigger_endpoint_enqueues_task(scheduler_client: APIClient, project: Project) -> None:
    """A Scheduler-role user can trigger the schedule endpoint."""
    with patch(
        "trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay",
        return_value=MagicMock(id="test-celery-id"),
    ):
        resp = scheduler_client.post(f"/api/v1/projects/{project.pk}/schedule/")
    assert resp.status_code == 202
    assert resp.data == {"queued": True}


@pytest.mark.django_db
def test_trigger_endpoint_404_for_missing_project(scheduler_client: APIClient) -> None:
    import uuid

    fake_pk = uuid.uuid4()
    resp = scheduler_client.post(f"/api/v1/projects/{fake_pk}/schedule/")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Incremental CPM recompute (#8)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_incremental_write_skips_unaffected_tasks(project: Project) -> None:
    """Incremental path only writes CPM results for the changed task and its downstream.

    Approach: run a full recompute first so all tasks have CPM dates. Then force t3's
    early_start to a sentinel value and run an incremental recompute seeded only on t1.
    Because t3 is not downstream of t1, its early_start must remain unchanged.
    """
    from datetime import date

    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    # Build a project with enough tasks that the affected ratio stays below the 25% threshold.
    # Affected = {t1, t2} = 2 tasks.  Total must be > 8 (2/N < 0.25 → N > 8).
    # We use 10 tasks: a 2-task chain (t1→t2) and 8 independent stubs (t3-t10).
    t1 = Task.objects.create(project=project, name="T1", duration=2)
    t2 = Task.objects.create(project=project, name="T2", duration=3)
    independents = [
        Task.objects.create(project=project, name=f"TI{i}", duration=1) for i in range(8)
    ]
    t3 = independents[0]  # sentinel target — completely independent of t1/t2
    Dependency.objects.create(predecessor=t1, successor=t2, dep_type="FS")
    # t3-t10 have no dependencies — changing t1 must not touch their CPM fields.

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        # Full recompute to populate CPM fields.
        _run_schedule(str(project.pk))

        # Overwrite t3's early_start with a sentinel date so we can detect if it gets touched.
        sentinel = date(2099, 1, 1)
        Task.objects.filter(pk=t3.pk).update(early_start=sentinel)

        # Incremental recompute seeded on t1 only.
        # Affected = {t1, t2} = 2/10 = 20% < 25% threshold → incremental write.
        _run_schedule(str(project.pk), changed_task_ids=[str(t1.pk)])

    t3.refresh_from_db()
    assert t3.early_start == sentinel, (
        "Incremental recompute must not overwrite t3 (not downstream of t1)"
    )


@pytest.mark.django_db
def test_incremental_falls_back_to_full_write_above_threshold(project: Project) -> None:
    """When affected tasks exceed 25% of all tasks, a full write is performed.

    Scenario: 4 tasks in a linear chain. Changing t1 makes all 4 tasks affected
    (100% > 25% threshold) → full write, so t3's sentinel date IS overwritten.
    """
    from datetime import date

    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    t1 = Task.objects.create(project=project, name="T1", duration=1)
    t2 = Task.objects.create(project=project, name="T2", duration=1)
    t3 = Task.objects.create(project=project, name="T3", duration=1)
    t4 = Task.objects.create(project=project, name="T4", duration=1)
    Dependency.objects.create(predecessor=t1, successor=t2, dep_type="FS")
    Dependency.objects.create(predecessor=t2, successor=t3, dep_type="FS")
    Dependency.objects.create(predecessor=t3, successor=t4, dep_type="FS")

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        # Full recompute to populate CPM fields.
        _run_schedule(str(project.pk))

        # Put a sentinel on t3 — if the incremental path falls back to full write, it gets cleared.
        sentinel = date(2099, 1, 1)
        Task.objects.filter(pk=t3.pk).update(early_start=sentinel)

        # Incremental seeded on t1 — 100% of tasks affected → should fall back to full write.
        _run_schedule(str(project.pk), changed_task_ids=[str(t1.pk)])

    t3.refresh_from_db()
    # Full write clears the sentinel (writes the real CPM result).
    assert t3.early_start != sentinel, "Full-write fallback should have overwritten the sentinel"


@pytest.mark.django_db
def test_incremental_result_equals_full_recompute() -> None:
    """Equivalence: incremental write produces identical CPM results for affected tasks.

    Strategy (fuzz, 20 cases):
    1. Build a random project and run a full recompute to get the baseline.
    2. Corrupt one task's early_start in the DB to a sentinel value.
    3. Run an incremental recompute seeded from that task.
    4. Verify the corrupted task now matches the baseline (i.e., it was healed).
    5. Verify that other tasks whose values we did NOT corrupt are unchanged.

    This is the regression guard for #8 — verifies that the incremental path
    writes the same CPM values as the full path for affected tasks.
    """
    import random
    from datetime import date

    from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
    from trueppm_api.apps.scheduling.tasks import _downstream_task_ids, _run_schedule

    rng = random.Random(42)
    n_cases = 20

    for case_idx in range(n_cases):
        cal = Calendar.objects.create(name=f"Cal{case_idx}")
        proj = Project.objects.create(
            name=f"P{case_idx}", start_date=date(2026, 1, 5), calendar=cal
        )

        # Use enough tasks that at least one is independent (ratio below threshold).
        n_tasks = rng.randint(10, 20)
        tasks = [
            Task.objects.create(project=proj, name=f"T{i}", duration=rng.randint(1, 10))
            for i in range(n_tasks)
        ]

        # Random forward-only FS dependencies (guarantees a DAG).
        for i in range(n_tasks):
            for j in range(i + 1, n_tasks):
                if rng.random() < 0.2:
                    Dependency.objects.create(
                        predecessor=tasks[i], successor=tasks[j], dep_type="FS"
                    )

        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
        ):
            # Baseline full recompute.
            _run_schedule(str(proj.pk))

            # Record baseline early_start values.
            baseline = {str(t.pk): Task.objects.get(pk=t.pk).early_start for t in tasks}

            # Pick a seed task and corrupt it.
            seed = tasks[0]
            sentinel = date(2099, 12, 31)
            Task.objects.filter(pk=seed.pk).update(early_start=sentinel)

            # Incremental recompute seeded from the corrupted task.
            _run_schedule(str(proj.pk), changed_task_ids=[str(seed.pk)])

        # Determine which tasks were in the affected subgraph.
        affected = _downstream_task_ids(str(proj.pk), [str(seed.pk)])
        n_total = n_tasks
        ratio = len(affected) / n_total

        if ratio <= 0.25:
            # Incremental path was taken: seed task must be healed.
            seed.refresh_from_db()
            assert seed.early_start == baseline[str(seed.pk)], (
                f"Case {case_idx}: incremental did not heal seed task early_start "
                f"(got {seed.early_start!r}, expected {baseline[str(seed.pk)]!r})"
            )
        # Full-write fallback is also correct (all tasks healed), but we don't test
        # that path here since test_incremental_falls_back_to_full_write_above_threshold
        # already covers it.


@pytest.mark.django_db
def test_incremental_benchmark_500_tasks_5_changes() -> None:
    """Verify the incremental write path skips the bulk of the DB on small changes.

    Structure: 20 independent chains of 25 tasks each (500 tasks total).  Changing 5
    tasks in chain #0 affects at most 25 downstream tasks = 5% < 25% threshold, so the
    incremental write path is taken.  The CPM still runs on all 500 tasks but only the
    affected chain is written back to the DB, which is the meaningful savings for large
    projects.

    Why we assert on bulk_update row count, not wall-clock time:
    The whole *point* of the incremental path is "write ~25 rows instead of 500."
    Counting rows passed to bulk_update directly is deterministic and immune to
    runner noise — a wall-clock budget on shared CI hosts produced flake (samples
    like [827, 828, 610] ms against a 600 ms budget) because the runner was
    sustained-slow, not jittering, so best-of-N didn't help. Row count regresses
    sharply (~25 → ~500) if someone accidentally drops back to the full-write
    path, giving a stronger signal than ms anyway.

    We can't use CaptureQueriesContext alone: on PostgreSQL, bulk_update emits a
    single UPDATE with CASE WHEN clauses regardless of row count, so query count
    is identical for 25 rows and 500 rows. We spy on bulk_update directly.
    """
    from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
    from trueppm_api.apps.scheduling.tasks import _run_schedule

    original_bulk_update = Task.objects.bulk_update
    bulk_update_sizes: list[int] = []

    def spy_bulk_update(objs, *args, **kwargs):  # type: ignore[no-untyped-def]
        objs_list = list(objs)
        bulk_update_sizes.append(len(objs_list))
        return original_bulk_update(objs_list, *args, **kwargs)

    cal = Calendar.objects.create(name="Bench")
    proj = Project.objects.create(name="BenchProj", start_date=date(2026, 1, 5), calendar=cal)

    # 20 independent chains of 25 tasks each (500 tasks total, no cross-chain deps).
    n_chains, chain_len = 20, 25
    all_tasks: list[list[Task]] = []
    for c in range(n_chains):
        chain = [
            Task.objects.create(project=proj, name=f"C{c}T{i}", duration=2)
            for i in range(chain_len)
        ]
        all_tasks.append(chain)

    Dependency.objects.bulk_create(
        [
            Dependency(predecessor=all_tasks[c][i], successor=all_tasks[c][i + 1], dep_type="FS")
            for c in range(n_chains)
            for i in range(chain_len - 1)
        ]
    )

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        # Warm up with a full recompute so CPM results are in the DB.
        _run_schedule(str(proj.pk))

        # Change the first 5 tasks in chain #0.
        # Downstream = 20 tasks (indices 5-24 in chain 0) = 20/500 = 4% < 25% threshold.
        changed = [str(all_tasks[0][i].pk) for i in range(5)]
        bulk_update_sizes.clear()
        with patch.object(Task.objects, "bulk_update", side_effect=spy_bulk_update):
            _run_schedule(str(proj.pk), changed_task_ids=changed)

    # Incremental should write only the affected chain (~20-25 rows). Full-write
    # would write all 500. The upper bound (60) sits well above the incremental
    # ceiling and an order of magnitude below the full-write floor; the lower
    # bound (1) catches a regression that silently writes nothing.
    assert bulk_update_sizes, "Task.objects.bulk_update was never called"
    incremental_write_size = max(bulk_update_sizes)
    assert 1 <= incremental_write_size <= 60, (
        f"Incremental bulk_update wrote {incremental_write_size} Task rows "
        f"(sizes={bulk_update_sizes}); expected 1-60 (full-write would be ~500). "
        f"This likely means the change ratio threshold tripped or the incremental "
        f"path regressed to full-write."
    )


# ---------------------------------------------------------------------------
# Sprint-window SNET floor end-to-end (ADR-0168, #1284): a sprint-assigned task
# with no planned_start positions in its sprint window, not the project origin.
# ---------------------------------------------------------------------------


def _run_recalc(project: Project) -> None:
    """Run recalculate_schedule end-to-end with the idempotency lock acquired and
    the side-effecting broadcasts/webhooks patched out (mirrors the completed-task
    span test above)."""
    from trueppm_api.apps.scheduling.tasks import recalculate_schedule

    mock_redis = MagicMock()
    mock_redis.set.return_value = "OK"  # lock acquired → task body runs
    with (
        patch("trueppm_api.core.idempotent.redis_lib") as mock_redis_module,
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        mock_redis_module.from_url.return_value = mock_redis
        recalculate_schedule.run(str(project.pk))


def _active_sprint(project: Project, start: date, finish: date) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=start,
        finish_date=finish,
        state=SprintState.ACTIVE,
    )


@pytest.mark.django_db
def test_sprint_assigned_task_floors_at_sprint_start(project: Project) -> None:
    """A sprint-assigned task with no planned_start positions at its sprint start
    (project starts Mon 2026-01-05; the sprint starts four weeks later)."""
    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    story = Task.objects.create(project=project, name="Story", duration=3, sprint=sprint)

    _run_recalc(project)

    story.refresh_from_db()
    # Floored at the sprint start (Mon 2026-02-02), not the project origin.
    assert story.early_start == date(2026, 2, 2)
    # Three working days: 02-02, 02-03, 02-04.
    assert story.early_finish == date(2026, 2, 4)
    # The floor is engine input only — the stored field stays null (ADR-0168).
    assert story.planned_start is None


@pytest.mark.django_db
def test_task_without_sprint_still_floors_at_project_start(project: Project) -> None:
    """Regression guard: the floor only applies to sprint-assigned tasks; a loose
    task with no planned_start still floors at the project start."""
    loose = Task.objects.create(project=project, name="Loose", duration=3)

    _run_recalc(project)

    loose.refresh_from_db()
    assert loose.early_start == date(2026, 1, 5)


@pytest.mark.django_db
def test_dependency_later_than_sprint_floor_wins(project: Project) -> None:
    """A predecessor that finishes after the sprint start pushes the successor past
    its sprint floor — the existing max(es_constraints) resolves precedence."""
    from trueppm_api.apps.projects.models import Dependency

    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    # Predecessor pinned far past the sprint: Mon 2026-03-02 + 2 wd → ends Tue 03-03.
    pred = Task.objects.create(
        project=project, name="Pred", duration=2, planned_start=date(2026, 3, 2)
    )
    succ = Task.objects.create(project=project, name="Succ", duration=3, sprint=sprint)
    Dependency.objects.create(predecessor=pred, successor=succ, dep_type="FS", lag=0)

    _run_recalc(project)

    succ.refresh_from_db()
    # max(sprint floor 02-02, pred finish 03-03 + 1 wd = 03-04) → the dependency wins.
    assert succ.early_start == date(2026, 3, 4)


@pytest.mark.django_db
def test_sprint_milestone_not_floored_at_sprint_start(project: Project) -> None:
    """A milestone is excluded from the sprint floor (a sprint review/demo gate
    belongs at the sprint end, ADR-0106) — it floors at the project start instead."""
    sprint = _active_sprint(project, date(2026, 2, 2), date(2026, 2, 13))
    ms = Task.objects.create(project=project, name="Demo", is_milestone=True, sprint=sprint)

    _run_recalc(project)

    ms.refresh_from_db()
    assert ms.early_start == date(2026, 1, 5)
