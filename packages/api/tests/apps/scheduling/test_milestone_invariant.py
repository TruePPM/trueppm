"""Milestone invariant: is_milestone=True implies start == finish after CPM.

Reproduces the failure mode reported on MR !221: a milestone with a successor
linked to it was rendering Start=May 6 and Finish=May 25 — a 19-day span — even
though milestones must be a single point in time. The fix has two layers:

1. The Task → SchedTask boundary in apps/scheduling/tasks.py forces
   duration=0 when is_milestone=True so the CPM engine treats it as a
   zero-duration node regardless of the persisted duration column.
2. A post-CPM guard in the bulk_update path resets early_finish/late_finish
   to early_start/late_start for any milestone, so even bypassed boundaries
   cannot leak a date range into the database.

These tests lock both layers in.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from trueppm_api.apps.projects.models import Calendar, Dependency, Project, Task
from trueppm_api.apps.scheduling.tasks import _run_schedule


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="StdMilestone")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="MilestoneProj",
        start_date=date(2026, 1, 5),  # Monday
        calendar=calendar,
    )


@pytest.mark.django_db
def test_milestone_with_successor_keeps_start_equal_finish(project: Project) -> None:
    """Milestone gating a downstream task must remain a single point.

    Layout: Task A (3d) → Milestone M → Task B (2d). After CPM, M must have
    early_start == early_finish even when its persisted duration is non-zero
    (simulating an MS Project import where milestones often carry duration=1).
    """
    a = Task.objects.create(project=project, name="A", duration=3)
    m = Task.objects.create(
        project=project,
        name="Phase Gate",
        duration=1,  # intentionally non-zero — the invariant must clamp it
        is_milestone=True,
    )
    b = Task.objects.create(project=project, name="B", duration=2)
    Dependency.objects.create(predecessor=a, successor=m, dep_type="FS")
    Dependency.objects.create(predecessor=m, successor=b, dep_type="FS")

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
        patch("trueppm_api.apps.webhooks.dispatch.dispatch_webhooks"),
    ):
        _run_schedule(str(project.pk))

    m.refresh_from_db()
    assert m.early_start is not None
    assert m.early_start == m.early_finish, (
        f"milestone span detected: {m.early_start} → {m.early_finish}"
    )
    assert m.late_start == m.late_finish

    # Successor B should start the working day after A finishes (FS, EF inclusive),
    # not be pushed by a phantom milestone duration.
    a.refresh_from_db()
    b.refresh_from_db()
    assert a.early_finish is not None and b.early_start is not None
    assert b.early_start > a.early_finish


@pytest.mark.django_db
def test_milestone_serializer_clamps_duration_to_zero(
    project: Project,
) -> None:
    """The TaskSerializer must reject non-zero durations on milestones.

    Without the serializer guard a client could PATCH duration=5 on a milestone
    and bypass the boundary normalisation on subsequent CPM runs that read the
    persisted column. Tested via API client because validate() is bound to DRF.
    """
    from django.contrib.auth import get_user_model
    from rest_framework.test import APIClient

    from trueppm_api.apps.access.models import ProjectMembership, Role

    user = get_user_model().objects.create_user(username="ms_user", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.post(
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "Gate",
            "duration": 5,
            "is_milestone": True,
        },
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["duration"] == 0
    assert resp.data["is_milestone"] is True
