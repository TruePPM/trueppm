"""ADR-0152 (#327): field-level ``task_updated`` delta broadcast.

A task PATCH must broadcast ``task_updated`` carrying the changed-field *names*,
the post-commit ``server_version``, and the acting user — but never field values
(those are role-gated, ADR-0104). The originating client uses ``actor_id`` to
suppress its own echo.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.sync.broadcast import broadcast_task_updated

User = get_user_model()


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Std")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


@pytest.fixture
def membership(project: Project, user: Any) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def client(user: Any, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T1", duration=5)


def _task_updated_calls(mock_bcast: Any) -> list[tuple[str, str, dict[str, Any]]]:
    return [c.args for c in mock_bcast.call_args_list if c.args[1] == "task_updated"]


@pytest.mark.django_db
def test_patch_emits_task_updated_delta(
    client: APIClient,
    task: Task,
    user: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"status": "IN_PROGRESS"}, format="json")
        assert r.status_code == 200

    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected a task_updated broadcast"
    _pid, _event, payload = calls[-1]
    assert payload["id"] == str(task.pk)
    assert "status" in payload["changed_fields"]
    # Values must never be on the wire — only names (ADR-0104 gating).
    assert "IN_PROGRESS" not in payload["changed_fields"]
    assert isinstance(payload["version"], int) and payload["version"] >= 1
    assert payload["actor_id"] == str(user.pk)
    assert "ts" in payload


@pytest.mark.django_db
def test_non_schedule_field_patch_still_broadcasts_delta(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A name-only edit doesn't move the schedule but must still notify collaborators."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"name": "Renamed"}, format="json")
        assert r.status_code == 200

    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected a task_updated broadcast on a non-schedule edit"
    _pid, _event, payload = calls[-1]
    assert payload["changed_fields"] == ["name"]


@pytest.mark.django_db
def test_noop_patch_skips_recalc_and_broadcast(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: re-sending a stored value is not a change — no CPM recalc, no fanout."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"duration": 5}, format="json")
        assert r.status_code == 200

    recalc.assert_not_called()
    assert not _task_updated_calls(mock_bcast)


@pytest.mark.django_db
def test_mixed_patch_reports_only_the_real_change(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: changed_fields is a diff — the unchanged key is dropped, recalc still runs."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(
                f"/api/v1/tasks/{task.pk}/", {"duration": 5, "status": "IN_PROGRESS"}, format="json"
            )
        assert r.status_code == 200

    recalc.assert_called_once()
    _pid, _event, payload = _task_updated_calls(mock_bcast)[-1]
    # ``duration`` (unchanged) is dropped; ``actual_start`` is the server's derived
    # write for the IN_PROGRESS transition, so it really changed and is reported.
    assert payload["changed_fields"] == ["actual_start", "status"]


@pytest.mark.django_db
def test_empty_patch_still_recalculates(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: nothing submitted is "unknown", not "no-op" — recalc as before."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {}, format="json")
        assert r.status_code == 200

    recalc.assert_called_once()


@pytest.mark.django_db
def test_write_only_key_patch_counts_as_changed(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: a key with no comparable column (``owners``) errs toward recalc + fanout."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"owners": []}, format="json")
        assert r.status_code == 200

    recalc.assert_called_once()
    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected task_updated for a key with no comparable column"
    assert "owners" in calls[-1][2]["changed_fields"]


@pytest.mark.django_db
def test_resent_past_planned_start_is_not_a_noop(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: an unchanged key whose serializer side effect changes a stored column.

    Re-sending a past ``planned_start`` on a NOT_STARTED task promotes it to
    IN_PROGRESS and pins ``actual_start`` (``_apply_date_gated_start_transition``).
    Those derived writes never appear in ``validated_data``, so a diff over the
    submitted keys alone would call this a no-op and skip the recalc and fanout.
    """
    t = Task.objects.create(project=project, name="T", duration=5, planned_start=date(2026, 4, 1))
    t.refresh_from_db()
    assert t.status == "NOT_STARTED"
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(
                f"/api/v1/tasks/{t.pk}/", {"planned_start": "2026-04-01"}, format="json"
            )
        assert r.status_code == 200

    t.refresh_from_db()
    assert t.status == "IN_PROGRESS"
    recalc.assert_called_once()
    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected task_updated for a derived status change"
    changed = calls[-1][2]["changed_fields"]
    assert "status" in changed
    assert "actual_start" in changed
    assert "planned_start" not in changed


@pytest.mark.django_db
def test_resent_full_percent_complete_is_not_a_noop(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: ``percent_complete: 100`` re-sent on an IN_PROGRESS task completes it.

    ``_apply_percent_complete_auto_status`` injects ``status`` and the transition
    side effects stamp ``actual_finish`` (a CPM input), so this must recalc.
    """
    t = Task.objects.create(
        project=project, name="T", duration=5, status="IN_PROGRESS", percent_complete=100
    )
    t.refresh_from_db()
    assert t.status == "IN_PROGRESS" and t.percent_complete == 100
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{t.pk}/", {"percent_complete": 100}, format="json")
        assert r.status_code == 200

    t.refresh_from_db()
    assert t.status == "COMPLETE"
    recalc.assert_called_once()
    calls = _task_updated_calls(mock_bcast)
    assert calls, "expected task_updated for a derived completion"
    changed = calls[-1][2]["changed_fields"]
    assert "status" in changed
    assert "percent_complete" not in changed


@pytest.mark.django_db
def test_resent_planned_start_that_shifts_project_start_is_not_a_noop(
    client: APIClient,
    project: Project,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: the #867 project-start shift writes the Project row, not a Task column.

    A stored ``planned_start`` earlier than a project start that later moved forward,
    re-sent unchanged, pulls the project start back. No task column moves, but the
    project start is a CPM input, so this must still recalculate.
    """
    t = Task.objects.create(
        project=project,
        name="T",
        duration=5,
        planned_start=date(2026, 3, 16),
        status="IN_PROGRESS",
        actual_start=date(2026, 3, 16),
    )
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_bcast,
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as recalc,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(
                f"/api/v1/tasks/{t.pk}/", {"planned_start": "2026-03-16"}, format="json"
            )
        assert r.status_code == 200

    project.refresh_from_db()
    assert project.start_date == date(2026, 3, 16)
    recalc.assert_called_once()
    assert any(c.args[1] == "project_updated" for c in mock_bcast.call_args_list)


@pytest.mark.django_db
def test_noop_patch_skips_task_updated_webhook(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """#2564: the ``task.updated`` webhook is gated on the same no-op decision."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hooks,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"duration": 5}, format="json")
        assert r.status_code == 200

    assert not [c for c in hooks.call_args_list if c.args[1] == "task.updated"]


@pytest.mark.django_db
def test_real_change_still_fires_task_updated_webhook(
    client: APIClient,
    task: Task,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Control for the webhook gate: a real change still dispatches ``task.updated``."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hooks,
    ):
        with django_capture_on_commit_callbacks(execute=True):
            r = client.patch(f"/api/v1/tasks/{task.pk}/", {"duration": 6}, format="json")
        assert r.status_code == 200

    assert [c for c in hooks.call_args_list if c.args[1] == "task.updated"]


def test_broadcast_task_updated_payload_shape() -> None:
    """Helper assembles a stable, sorted, names-only payload."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as m:
        broadcast_task_updated(
            "p1", task_id="t1", changed_fields=["status", "assignee"], version=3, actor_id="u1"
        )
    _pid, event, payload = m.call_args.args
    assert event == "task_updated"
    assert payload["id"] == "t1"
    assert payload["changed_fields"] == ["assignee", "status"]  # sorted
    assert payload["version"] == 3
    assert payload["actor_id"] == "u1"
    assert "ts" in payload
