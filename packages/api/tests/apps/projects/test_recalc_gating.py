"""Recalc-gating on task PATCH (#965).

`TaskViewSet.perform_update` must only enqueue a CPM recalculation when a
schedule-affecting field changed. A PATCH touching only non-scheduling fields
(``percent_complete`` / ``notes`` / ``name``) must NOT enqueue a recalc — that
was the dominant source of drawer-edit lag. Everything else still recalculates.

The recalc is deferred via ``transaction.on_commit``; the tests capture and
execute the on-commit callbacks so the (patched) ``_enqueue_recalculate`` is
observed.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


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
    # planned_start is set so percent_complete > 0 passes the progress-anchor
    # gate (ADR-0057) — these tests exercise the recalc trigger, not that gate.
    return Task.objects.create(
        project=project, name="T1", duration=3, planned_start=date(2026, 4, 1)
    )


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _patch_task(
    client: APIClient,
    task: Task,
    body: dict[str, object],
    django_capture_on_commit_callbacks: object,
) -> tuple[int, int]:
    """PATCH the task, executing on-commit callbacks, and return
    (status_code, recalc_call_count)."""
    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.projects.views._dispatch_webhooks"),
        patch("trueppm_api.apps.projects.views._enqueue_recalculate") as mock_recalc,
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        r = client.patch(f"/api/v1/tasks/{task.pk}/", body, format="json")
    return r.status_code, mock_recalc.call_count


# ---------------------------------------------------------------------------
# Non-scheduling fields → no recalc
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_progress_only_patch_does_not_recalc(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"percent_complete": 50}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


@pytest.mark.django_db
def test_notes_only_patch_does_not_recalc(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"notes": "Some context"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


@pytest.mark.django_db
def test_name_only_patch_does_not_recalc(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"name": "Renamed"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 0


# ---------------------------------------------------------------------------
# Scheduling fields → recalc
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_duration_patch_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(client, task, {"duration": 5}, django_capture_on_commit_callbacks)
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_planned_start_patch_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    status, calls = _patch_task(
        client, task, {"planned_start": "2026-05-01"}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_progress_plus_status_recalcs(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    # status can move the schedule (actuals), so any write that includes a
    # non-denylisted field still recalcs even when bundled with progress.
    status, calls = _patch_task(
        client,
        task,
        {"percent_complete": 50, "status": "IN_PROGRESS"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    assert calls == 1
