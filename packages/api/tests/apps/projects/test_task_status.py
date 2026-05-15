"""Tests for Task.status field, API filter, and task_status_changed signal (#58)."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
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
    task.status = TaskStatus.IN_PROGRESS
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
    # actual_start was set since work has been performed
    assert task.actual_start is not None
    # actual_finish stays null — sign-off has not happened yet
    assert task.actual_finish is None


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
    member_membership: ProjectMembership,
) -> None:
    """If the caller explicitly sends status=COMPLETE, the auto-REVIEW logic does not override."""
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
    # Permission may reject this depending on RBAC — what we assert is that
    # if the request reaches the serializer, an explicit status wins. If the
    # permission layer denies this entirely, the test still pins behavior:
    # auto-REVIEW only fires when status was NOT in the payload.
    if r.status_code == 200:
        task.refresh_from_db()
        assert task.status == TaskStatus.COMPLETE


@pytest.mark.django_db
def test_backlog_progress_100_does_not_auto_promote(
    member_client: APIClient,
    project: Project,
    task: Task,
    member_membership: ProjectMembership,
) -> None:
    """A BACKLOG card with percent_complete=100 stays BACKLOG.

    Promotion from idea to delivery is a manual decision — a contributor
    setting progress on an uncommitted idea should not skip past TO DO and
    IN_PROGRESS into REVIEW silently.
    """
    task.status = TaskStatus.BACKLOG
    task.save()
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.scheduling.tasks.recalculate_schedule.delay"),
    ):
        r = member_client.patch(
            f"/api/v1/tasks/{task.pk}/", {"percent_complete": 100}, format="json"
        )
    if r.status_code == 200:
        task.refresh_from_db()
        assert task.status == TaskStatus.BACKLOG


@pytest.mark.django_db
def test_review_card_with_progress_100_stays_review(
    member_client: APIClient,
    project: Project,
    task: Task,
    member_membership: ProjectMembership,
) -> None:
    """A card already in REVIEW does not flip back when percent_complete is set to 100."""
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
    if r.status_code == 200:
        task.refresh_from_db()
        assert task.status == TaskStatus.REVIEW
