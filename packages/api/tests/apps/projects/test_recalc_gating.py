"""Recalc-gating on task PATCH (#965, revised by #1500).

`TaskViewSet.perform_update` must only enqueue a CPM recalculation when a
schedule-affecting field changed. A PATCH touching only non-scheduling fields
(``notes`` / ``name``) must NOT enqueue a recalc — that was the dominant
source of drawer-edit lag. Everything else still recalculates.

``percent_complete`` was originally in the same denylist as ``notes``/``name``
on the premise that the CPM pass never reads it. #1500: ADR-0132 made that
premise false — ``percent_complete`` derives an in-progress task's remaining
duration and marks it complete at 100%, on *every* project regardless of
whether ``Project.status_date`` is set (verified directly against
``trueppm_scheduler.engine``: a bare percent_complete write shifts
``early_finish`` even with no status_date and no actuals). So a PATCH writing
only ``percent_complete`` must always recalc.

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


@pytest.mark.django_db
def test_progress_only_patch_recalcs_with_no_status_date(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """#1500: a percent_complete-only PATCH must recalc even with no
    ``Project.status_date`` set. ``trueppm_scheduler.engine._effective_duration_days``
    derives an in-progress task's remaining duration from percent_complete
    unconditionally (not gated on status_date) — a percent_complete-only write
    is a live CPM input on every project, not just ones with a status date.
    The ``task`` fixture's project has no status_date (see ``project`` fixture).
    """
    assert task.project.status_date is None
    status, calls = _patch_task(
        client, task, {"percent_complete": 50}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_progress_only_patch_recalcs_with_status_date_set(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """#1500: same recalc requirement holds when the project has an explicit
    status date — the case the CPM forward-pass floor most directly reads
    percent_complete for (remaining duration laid out from the data date)."""
    task.project.status_date = date(2026, 4, 10)
    task.project.save(update_fields=["status_date"])
    status, calls = _patch_task(
        client, task, {"percent_complete": 50}, django_capture_on_commit_callbacks
    )
    assert status == 200
    assert calls == 1


@pytest.mark.django_db
def test_notes_and_name_only_patch_still_does_not_recalc_with_status_date_set(
    client: APIClient, task: Task, django_capture_on_commit_callbacks: object
) -> None:
    """Sanity check that the #1500 fix is scoped to percent_complete: the
    genuinely inert fields stay gated even on a project with a status date."""
    task.project.status_date = date(2026, 4, 10)
    task.project.save(update_fields=["status_date"])
    status, calls = _patch_task(
        client,
        task,
        {"notes": "Some context", "name": "Renamed"},
        django_capture_on_commit_callbacks,
    )
    assert status == 200
    assert calls == 0
