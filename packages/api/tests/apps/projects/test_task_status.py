"""Tests for Task.status field, API filter, and task_status_changed signal (#58)."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
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
from trueppm_api.apps.projects.signals import task_status_changed

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(project: Project, user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=2)


# ---------------------------------------------------------------------------
# Model defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_status_defaults_to_not_started(project: Project) -> None:
    task = Task.objects.create(project=project, name="T", duration=1)
    assert task.status == TaskStatus.NOT_STARTED


# ---------------------------------------------------------------------------
# API — read and write
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_list_includes_status_field(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    first = next(t for t in results if t["id"] == str(task.pk))
    assert "status" in first
    assert first["status"] == TaskStatus.NOT_STARTED


@pytest.mark.django_db
def test_patch_status_updates_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"status": "IN_PROGRESS"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


@pytest.mark.django_db
def test_patch_invalid_status_rejected(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    r = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"status": "BOGUS"},
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_filter_tasks_by_status(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        t_open = Task.objects.create(
            project=project, name="Open", duration=1, status=TaskStatus.NOT_STARTED
        )
        t_done = Task.objects.create(
            project=project, name="Done", duration=1, status=TaskStatus.COMPLETE
        )

    r = client.get(f"/api/v1/tasks/?project={project.pk}&status=COMPLETE")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    ids = [t["id"] for t in results]
    assert str(t_done.pk) in ids
    assert str(t_open.pk) not in ids


# ---------------------------------------------------------------------------
# Signal — task_status_changed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signal_emitted_when_status_changes(project: Project, task: Task) -> None:
    handler = MagicMock()
    task_status_changed.connect(handler)
    try:
        task.status = TaskStatus.IN_PROGRESS
        task.save(update_fields=["status"])
        handler.assert_called_once()
        _, kwargs = handler.call_args
        assert kwargs["old_status"] == TaskStatus.NOT_STARTED
        assert kwargs["new_status"] == TaskStatus.IN_PROGRESS
        assert kwargs["task"] == task
    finally:
        task_status_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_not_emitted_when_status_unchanged(project: Project, task: Task) -> None:
    handler = MagicMock()
    task_status_changed.connect(handler)
    try:
        task.name = "Renamed"
        task.save(update_fields=["name"])
        handler.assert_not_called()
    finally:
        task_status_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_not_emitted_when_value_does_not_change(project: Project, task: Task) -> None:
    # status is already NOT_STARTED; saving it again should not fire
    handler = MagicMock()
    task_status_changed.connect(handler)
    try:
        task.status = TaskStatus.NOT_STARTED
        task.save(update_fields=["status"])
        handler.assert_not_called()
    finally:
        task_status_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_includes_old_and_new_status_on_full_save(project: Project, task: Task) -> None:
    task.status = TaskStatus.IN_PROGRESS
    task.save(update_fields=["status"])  # set up initial state

    calls: list[dict[str, object]] = []

    def capture(sender: object, **kwargs: object) -> None:
        calls.append(dict(kwargs))

    task_status_changed.connect(capture)
    try:
        task.status = TaskStatus.COMPLETE
        task.save()  # full save — no update_fields
        assert len(calls) == 1
        assert calls[0]["old_status"] == TaskStatus.IN_PROGRESS
        assert calls[0]["new_status"] == TaskStatus.COMPLETE
    finally:
        task_status_changed.disconnect(capture)


# ---------------------------------------------------------------------------
# Sync serializer includes status
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sync_task_serializer_includes_status(project: Project, task: Task) -> None:
    from trueppm_api.apps.sync.serializers import SyncTaskSerializer

    data = SyncTaskSerializer(task).data
    assert "status" in data
    assert data["status"] == TaskStatus.NOT_STARTED


# ---------------------------------------------------------------------------
# Readiness field (issue #179)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_readiness_idea_when_no_assignee_in_backlog(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Unassigned tasks in BACKLOG report readiness=idea (ADR-0047)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        backlog_task = Task.objects.create(
            project=project, name="Backlog idea", duration=2, status=TaskStatus.BACKLOG
        )
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    t_data = next(t for t in results if t["id"] == str(backlog_task.pk))
    assert t_data["readiness"] == "idea"


@pytest.mark.django_db
def test_readiness_estimated_when_no_assignee_outside_backlog(
    client: APIClient, project: Project, membership: ProjectMembership
) -> None:
    """Unassigned tasks promoted out of BACKLOG report readiness=estimated, not idea (ADR-0047).

    Ghost styling is suppressed once a PM commits the card to a working column.
    """
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        committed = Task.objects.create(
            project=project, name="Committed unassigned", duration=2, status=TaskStatus.NOT_STARTED
        )
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    t_data = next(t for t in results if t["id"] == str(committed.pk))
    assert t_data["readiness"] == "estimated"


@pytest.mark.django_db
def test_readiness_estimated_when_assignee_no_predecessors(
    client: APIClient, project: Project, membership: ProjectMembership, user: object
) -> None:
    """Tasks with an assignee but no predecessor links report readiness=estimated."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        assigned = Task.objects.create(project=project, name="Assigned", duration=2, assignee=user)
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    t_data = next(t for t in results if t["id"] == str(assigned.pk))
    assert t_data["readiness"] == "estimated"


@pytest.mark.django_db
def test_readiness_ready_when_has_predecessor(
    client: APIClient, project: Project, membership: ProjectMembership, user: object, task: Task
) -> None:
    """Tasks with an assignee and a predecessor link report readiness=ready."""
    from trueppm_api.apps.projects.models import Dependency

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        successor = Task.objects.create(
            project=project, name="Successor", duration=2, assignee=user
        )
        Dependency.objects.create(predecessor=task, successor=successor)
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
    assert r.status_code == 200
    results = r.data.get("results", r.data)
    t_data = next(t for t in results if t["id"] == str(successor.pk))
    assert t_data["readiness"] == "ready"


@pytest.mark.django_db
def test_new_statuses_accepted_by_api(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """BACKLOG and REVIEW are accepted as valid status values."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r_backlog = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "BACKLOG"}, format="json")
        assert r_backlog.status_code == 200
        r_review = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "REVIEW"}, format="json")
        assert r_review.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


@pytest.mark.django_db
def test_complete_status_coerces_progress_to_100(project: Project) -> None:
    """Saving a task with status=COMPLETE forces percent_complete to 100.

    Mirrors the BoardCard / popover display clamp added in #381 so the
    underlying record stays consistent with the column the card lives in.
    """
    task = Task.objects.create(project=project, name="ship it", duration=2)
    task.status = TaskStatus.COMPLETE
    task.save()
    task.refresh_from_db()
    assert task.percent_complete == 100.0


@pytest.mark.django_db
def test_complete_status_with_partial_progress_is_clamped(project: Project) -> None:
    """A caller that PATCHes status=COMPLETE with progress=40 still ends at 100."""
    task = Task.objects.create(project=project, name="ship it", duration=2, percent_complete=40.0)
    task.status = TaskStatus.COMPLETE
    task.save()
    task.refresh_from_db()
    assert task.percent_complete == 100.0


@pytest.mark.django_db
def test_non_complete_status_does_not_touch_progress(project: Project) -> None:
    """Inverse coupling is intentionally not enforced — progress=100 + IN_PROGRESS stays."""
    task = Task.objects.create(
        project=project,
        name="almost done",
        duration=2,
        status=TaskStatus.IN_PROGRESS,
        percent_complete=100.0,
    )
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete == 100.0


# ---------------------------------------------------------------------------
# Option E auto-status on percent_complete=100 (#381 follow-up, VoC 2026-05-08)
# ---------------------------------------------------------------------------


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="contrib", password="pw")


@pytest.fixture
def member_membership(project: Project, member_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.mark.django_db
def test_pm_progress_100_auto_completes_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """A PM (Role.ADMIN) marking progress=100 auto-flips status to COMPLETE."""
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE
    assert task.percent_complete == 100.0


@pytest.mark.django_db
def test_contributor_progress_100_routes_to_review(
    member_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """A contributor (Role.MEMBER) marking progress=100 on their own task lands
    in REVIEW, not COMPLETE.

    Sign-off stays with PM/PMO via the Review column gate (Option E, VoC).
    """
    task = Task.objects.create(
        project=project,
        name="Member task",
        duration=2,
        assignee=member_user,
        planned_start=date(2026, 4, 1),
    )
    # Simulate a task that was genuinely started (an IN_PROGRESS PATCH records
    # actual_start; we set it directly here as the precondition).
    task.status = TaskStatus.IN_PROGRESS
    task.actual_start = date(2026, 4, 1)
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
        )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW
    assert task.percent_complete == 100.0
    # actual_start was set when the task went IN_PROGRESS above; the REVIEW
    # transition itself no longer stamps it (ADR-0136).
    assert task.actual_start == date(2026, 4, 1)
    # actual_finish stays null — sign-off has not happened yet
    assert task.actual_finish is None


# ---------------------------------------------------------------------------
# Full 5-role matrix for the percent_complete=100 auto-status transition
# (#2639). ADMIN and MEMBER are covered above; these fill in OWNER (also
# Admin+, so COMPLETE), and confirm SCHEDULER and VIEWER never reach the
# auto-status branch at all — they're turned away by RBAC before the
# serializer's percent_complete handling ever runs, which is itself the
# correct behavior for those two roles in this transition's matrix.
# ---------------------------------------------------------------------------


@pytest.fixture
def owner_user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def owner_membership(project: Project, owner_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=owner_user, role=Role.OWNER)


@pytest.fixture
def owner_client(owner_user: object, owner_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner_user)
    return c


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def scheduler_membership(project: Project, scheduler_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def scheduler_client(scheduler_user: object, scheduler_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def viewer_membership(project: Project, viewer_user: object) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def viewer_client(viewer_user: object, viewer_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.mark.django_db
def test_owner_progress_100_auto_completes_task(
    owner_client: APIClient, project: Project, task: Task, owner_membership: ProjectMembership
) -> None:
    """An Owner (Role.OWNER, Project Admin) is Admin+ same as a PM — progress=100
    auto-completes, same as test_pm_progress_100_auto_completes_task.
    """
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = owner_client.patch(
            f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
        )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE
    assert task.percent_complete == 100.0


@pytest.mark.django_db
def test_scheduler_cannot_patch_progress_at_all(
    scheduler_client: APIClient,
    project: Project,
    task: Task,
    scheduler_membership: ProjectMembership,
) -> None:
    """Role.SCHEDULER (Resource Manager) is read-only for task content per
    IsProjectMemberWriteOrOwn — it never reaches percent_complete auto-status
    because the permission check turns the write away first. Completing the
    #2639 role matrix means confirming this role is blocked, not that it
    routes anywhere.
    """
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    r = scheduler_client.patch(
        f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
    )
    assert r.status_code == 403
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete != 100.0


@pytest.mark.django_db
def test_viewer_cannot_patch_progress_at_all(
    viewer_client: APIClient, project: Project, task: Task, viewer_membership: ProjectMembership
) -> None:
    """Role.VIEWER is read-only — a Viewer PATCHing percent_complete never
    reaches the auto-status branch, same reasoning as the Scheduler case above.
    """
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    r = viewer_client.patch(f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json")
    assert r.status_code == 403
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete != 100.0


@pytest.mark.django_db
def test_review_status_clamps_progress_to_100(project: Project) -> None:
    """Setting status=REVIEW directly clamps percent_complete to 100, mirroring COMPLETE."""
    task = Task.objects.create(
        project=project, name="awaiting QA", duration=2, percent_complete=70.0
    )
    task.status = TaskStatus.REVIEW
    task.save()
    task.refresh_from_db()
    assert task.percent_complete == 100.0
    assert task.status == TaskStatus.REVIEW


@pytest.mark.django_db
def test_explicit_status_overrides_auto_review(
    member_client: APIClient,
    project: Project,
    task: Task,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """If the caller explicitly sends status=COMPLETE, the auto-REVIEW logic does not override.

    PATCHing the shared **unassigned** ``task`` fixture with ``member_client``
    would 403 (a MEMBER cannot edit an unassigned task per
    ``can_user_edit_task``), which would leave any assertion after the request
    unreachable. Assigning the task to ``member_user`` (and giving it a
    ``planned_start`` so the percent_complete progress-anchor gate, ADR-0057
    Q5, doesn't itself 400 a non-ADMIN caller) lets the PATCH reach the
    serializer so the assertion below is unconditional.
    """
    task.assignee = member_user
    task.planned_start = date(2026, 4, 1)
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"percent_complete": 100, "status": "COMPLETE"},
            format="json",
        )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE


@pytest.mark.django_db
def test_backlog_progress_100_does_not_auto_promote(
    member_client: APIClient,
    project: Project,
    task: Task,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """A BACKLOG card with percent_complete=100 stays BACKLOG.

    Promotion from idea to delivery is a manual decision — a contributor
    setting progress on an uncommitted idea should not skip past TO DO and
    IN_PROGRESS into REVIEW silently.

    See ``test_explicit_status_overrides_auto_review`` docstring — assigned
    + anchored so the MEMBER PATCH actually reaches the serializer.
    """
    task.assignee = member_user
    task.planned_start = date(2026, 4, 1)
    task.status = TaskStatus.BACKLOG
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
        )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_review_card_with_progress_100_stays_review(
    member_client: APIClient,
    project: Project,
    task: Task,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """A card already in REVIEW does not flip back when percent_complete is set to 100.

    See ``test_explicit_status_overrides_auto_review`` docstring — assigned
    + anchored so the MEMBER PATCH actually reaches the serializer.
    """
    task.assignee = member_user
    task.planned_start = date(2026, 4, 1)
    task.status = TaskStatus.REVIEW
    task.percent_complete = 80.0
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
        )
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW


# ---------------------------------------------------------------------------
# Pass 2: actual-date edges; reopen; signal on full save
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_complete_status_via_api_sets_actual_finish(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """Transitioning to COMPLETE via PATCH sets actual_finish to today."""
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "COMPLETE"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE
    assert task.actual_finish == date.today()


@pytest.mark.django_db
def test_reopen_complete_task_clears_actual_finish(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """Re-opening a COMPLETE task to any non-COMPLETE status clears actual_finish."""
    task.status = TaskStatus.COMPLETE
    task.actual_finish = date(2026, 5, 1)
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.actual_finish is None


@pytest.mark.django_db
def test_review_transition_preserves_in_progress_actual_start(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """A REVIEW transition keeps the actual_start recorded at IN_PROGRESS, and never
    sets actual_finish (sign-off has not happened)."""
    task.status = TaskStatus.IN_PROGRESS
    task.actual_start = date(2026, 4, 1)
    task.save()
    started = date(2026, 4, 1)
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "REVIEW"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW
    assert task.actual_start == started
    assert task.actual_finish is None


@pytest.mark.django_db
def test_review_transition_without_prior_start_leaves_actual_start_null(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """A card taken straight to REVIEW without ever being IN_PROGRESS records no
    actual_start — stamping "today" would collapse the schedule bar; the engine
    derives the full-duration span instead (ADR-0136)."""
    assert task.status != TaskStatus.IN_PROGRESS
    assert task.actual_start is None
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "REVIEW"}, format="json")
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.REVIEW
    assert task.actual_start is None
    assert task.actual_finish is None


@pytest.mark.django_db
def test_signal_not_emitted_on_full_save_when_status_unchanged(
    project: Project, task: Task
) -> None:
    """A full model save() where status did not change must not fire task_status_changed."""
    handler = MagicMock()
    task_status_changed.connect(handler)
    try:
        task.name = "Renamed"
        task.save()  # full save, status = NOT_STARTED (same as before)
        handler.assert_not_called()
    finally:
        task_status_changed.disconnect(handler)


@pytest.mark.django_db
def test_explicit_complete_status_overrides_auto_review_for_admin(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """An ADMIN explicitly sending status=COMPLETE with percent_complete=100 always gets
    COMPLETE — the auto-REVIEW rule only fires when status is absent from the payload."""
    task.status = TaskStatus.IN_PROGRESS
    task.planned_start = date(2026, 4, 1)
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"percent_complete": 100, "status": "COMPLETE"},
            format="json",
        )
    assert r.status_code == 200
    task.refresh_from_db()
    assert task.status == TaskStatus.COMPLETE


# ---------------------------------------------------------------------------
# Readiness — 'baselined' branch (#848 backfill)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_readiness_baselined_when_baseline_start_annotated(project: Project, user: object) -> None:
    """A task that appears in the active baseline reports readiness=baselined.

    The viewset annotates ``baseline_start`` from the active baseline; the
    serializer reads that annotation. We set it directly to test the branch
    (serializers.get_readiness) in isolation from the annotation query.
    """
    from trueppm_api.apps.projects.serializers import TaskSerializer

    task = Task.objects.create(
        project=project,
        name="Baselined",
        duration=3,
        assignee=user,
        status=TaskStatus.IN_PROGRESS,
    )
    task.baseline_start = date(2026, 1, 5)
    assert TaskSerializer().get_readiness(task) == "baselined"


@pytest.mark.django_db
def test_readiness_baselined_takes_precedence_over_idea(project: Project) -> None:
    """'baselined' is the highest-specificity verdict — it wins even for an
    unassigned BACKLOG task that would otherwise report 'idea'."""
    from trueppm_api.apps.projects.serializers import TaskSerializer

    task = Task.objects.create(
        project=project,
        name="Backlog but baselined",
        duration=2,
        status=TaskStatus.BACKLOG,
    )
    assert TaskSerializer().get_readiness(task) == "idea"
    task.baseline_start = date(2026, 1, 5)
    assert TaskSerializer().get_readiness(task) == "baselined"


# ---------------------------------------------------------------------------
# #2680 — the web board's read-only guard (Viewer, closed sprint) must have a
# server-side equivalent for the status-changing PATCH the drag paths fire.
# Viewer was already covered by can_user_edit_task (test_viewer_cannot_patch_progress_at_all
# above proves the general Viewer write-block; this asserts it explicitly for
# a plain `status` PATCH too). The closed-sprint case had NO server-side check
# at all prior to this fix — any role that could otherwise write the task
# (assignee Member, Admin, Owner) could move a task's status inside a
# COMPLETED sprint, silently corrupting that sprint's already-closed
# completed_*/velocity numbers. This section pins the fix.
# ---------------------------------------------------------------------------


def _make_sprint(project: Project, **kwargs: object) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=kwargs.pop("name", "Sprint 1"),
        start_date=kwargs.pop("start_date", date(2026, 4, 1)),
        finish_date=kwargs.pop("finish_date", date(2026, 4, 14)),
        **kwargs,
    )


@pytest.mark.django_db
def test_viewer_cannot_patch_status(
    viewer_client: APIClient, project: Project, task: Task, viewer_membership: ProjectMembership
) -> None:
    """A Viewer's status-changing PATCH /tasks/{id}/ is rejected server-side (403).

    This is the "does the API independently reject a Viewer" question #2680
    asked before triaging severity — it does, via can_user_edit_task's Viewer
    branch (permissions.py), independent of the web board's own readOnly guard.
    """
    r = viewer_client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 403
    task.refresh_from_db()
    assert task.status == TaskStatus.NOT_STARTED


@pytest.mark.django_db
def test_admin_cannot_patch_status_on_closed_sprint_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """#2680: an Admin (otherwise fully permitted by can_user_edit_task) is still
    rejected on a status PATCH once the task's sprint has closed.

    Prior to this fix nothing server-side checked sprint.state on a task write —
    only the web board's client-side `boardReadOnly` guard blocked the drag. This
    pins the genuine RBAC/consistency hole the issue's Step 1 investigation found:
    a closed sprint must freeze every task in it board-wide, matching the client.
    """
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task.sprint = sprint
    task.status = TaskStatus.NOT_STARTED
    task.save()
    r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 400, r.content
    assert "status" in r.data
    task.refresh_from_db()
    assert task.status == TaskStatus.NOT_STARTED


@pytest.mark.django_db
def test_member_assignee_cannot_patch_status_on_closed_sprint_task(
    member_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """Same as the Admin case above, for a Member who is the task's own
    assignee — normally permitted to edit their own task per can_user_edit_task,
    but a closed sprint overrides that and freezes the status field regardless.
    """
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task = Task.objects.create(
        project=project,
        name="Closed-sprint task",
        duration=2,
        assignee=member_user,
        sprint=sprint,
        status=TaskStatus.NOT_STARTED,
    )
    r = member_client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 400, r.content
    assert "status" in r.data
    task.refresh_from_db()
    assert task.status == TaskStatus.NOT_STARTED


@pytest.mark.django_db
def test_patch_status_still_allowed_on_active_sprint_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """Control: the new closed-sprint guard must not over-fire on an ACTIVE
    sprint — only COMPLETED freezes status."""
    sprint = _make_sprint(project, state=SprintState.ACTIVE)
    task.sprint = sprint
    task.status = TaskStatus.NOT_STARTED
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS


@pytest.mark.django_db
def test_patch_non_status_field_still_allowed_on_closed_sprint_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """Control: the guard is scoped to `status` changes only — it must not
    block an unrelated field edit (e.g. renaming) on a closed-sprint task."""
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task.sprint = sprint
    task.save()
    r = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Renamed"}, format="json")
    assert r.status_code == 200, r.content
    task.refresh_from_db()
    assert task.name == "Renamed"


# ---------------------------------------------------------------------------
# #2680 follow-up: three auto-status side effects inject `status` into
# validated_data *after* validate() already passed, with no `status` key in
# the original payload — a bare `_reject_status_change_on_closed_sprint`
# check in validate() alone cannot see these. Each one is a real bypass of
# the closed-sprint freeze via a plain PATCH that never mentions `status`.
# `_reject_auto_status_injection_on_closed_sprint` (called from `update()`,
# after all three injectors) closes it. Pinned here individually since each
# injector has its own trigger condition.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_planned_start_auto_promote_blocked_on_closed_sprint_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """#336's date-gated NOT_STARTED -> IN_PROGRESS auto-transition must not
    fire on a closed-sprint task — even though the payload never mentions
    `status` at all, only `planned_start`."""
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task.sprint = sprint
    task.status = TaskStatus.NOT_STARTED
    task.save()
    r = client.patch(
        f"/api/v1/tasks/{task.pk}/",
        {"planned_start": date.today().isoformat()},
        format="json",
    )
    assert r.status_code == 400, r.content
    assert "status" in r.data
    task.refresh_from_db()
    assert task.status == TaskStatus.NOT_STARTED
    assert task.planned_start is None


@pytest.mark.django_db
def test_percent_complete_auto_promote_blocked_on_closed_sprint_task(
    member_client: APIClient,
    project: Project,
    member_user: object,
    member_membership: ProjectMembership,
) -> None:
    """#362's percent_complete 0 -> >0 auto-promote (NOT_STARTED -> IN_PROGRESS)
    must not fire on a closed-sprint task via a payload that only sends
    `percent_complete`, never `status`."""
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task = Task.objects.create(
        project=project,
        name="Closed-sprint task",
        duration=2,
        assignee=member_user,
        sprint=sprint,
        status=TaskStatus.NOT_STARTED,
        percent_complete=0,
    )
    r = member_client.patch(f"/api/v1/tasks/{task.pk}/", {"percent_complete": 40}, format="json")
    assert r.status_code == 400, r.content
    assert "status" in r.data
    task.refresh_from_db()
    assert task.status == TaskStatus.NOT_STARTED
    assert task.percent_complete == 0


@pytest.mark.django_db
def test_percent_complete_100_auto_status_blocked_on_closed_sprint_task(
    client: APIClient, project: Project, task: Task, membership: ProjectMembership
) -> None:
    """Option E's percent_complete=100 auto-status (-> REVIEW or COMPLETE per
    role) must not fire on a closed-sprint task via a payload that only sends
    `percent_complete`, never `status`."""
    sprint = _make_sprint(project, state=SprintState.COMPLETED)
    task.sprint = sprint
    task.status = TaskStatus.IN_PROGRESS
    task.save()
    r = client.patch(f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json")
    assert r.status_code == 400, r.content
    assert "status" in r.data
    task.refresh_from_db()
    assert task.status == TaskStatus.IN_PROGRESS
    assert task.percent_complete != 100.0
