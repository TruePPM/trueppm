"""``_run_schedule`` must accept a ``uuid.UUID`` project id (#4130).

The engine now rejects a non-string ``Project.id`` with ``InvalidScheduleInput``.
``enqueue_recalculate`` can hand ``_run_schedule`` a ``uuid.UUID`` rather than its
string (kombu's JSON serializer round-trips ``uuid.UUID``), so the scheduler project
is built with ``str(project_id)``. Without that coercion every such recalc would be
refused and the plan would silently stop updating.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule


@pytest.mark.django_db
def test_run_schedule_accepts_uuid_project_id() -> None:
    cal = Calendar.objects.create(name="UuidRecalc")
    project = Project.objects.create(name="UuidRecalc", start_date=date(2026, 1, 5), calendar=cal)
    task = Task.objects.create(project=project, name="A", duration=3)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(project.pk)  # type: ignore[arg-type]  # a UUID, not its str

    # A refused recalc writes nothing, so the task keeps NULL dates. The exact dates
    # are not pinned: unstarted work floors at the data date (today).
    task.refresh_from_db()
    assert task.early_start is not None
    assert task.early_finish is not None
