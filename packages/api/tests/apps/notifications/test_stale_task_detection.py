"""Tests for stale-task daily detection + notification fan-out (ADR-0199, #646).

Covers the ``create_stale_task_notifications`` scan service: threshold edge cases at
exactly N days, terminal / unassigned / percent-complete exclusions, per-project
threshold override, per-user preference gating, and the unread dedupe that makes the
daily job idempotent. Also covers the ``stale_task_threshold_days`` project setting on
the serializer (validation + Admin-only RBAC).

The scan is exercised through the service with an injected clock (``now=``) rather than
the Celery wrapper, mirroring the app's convention of testing ``_do_drain_*`` directly
so no broker/Redis is in the loop.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.notifications.services import (
    DEFAULT_STALE_TASK_THRESHOLD_DAYS,
    create_stale_task_notifications,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

User = get_user_model()

STALE_EVENT = NotificationEventType.TASK_STALE.value


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="StaleProj", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="stale_bob", password="pw", email="bob@x.io")


def _make_task(
    project: Project,
    *,
    assignee: Any | None,
    status: str = TaskStatus.REVIEW,
    status_age_days: float | None = None,
    percent_complete: float = 0.0,
    name: str = "Forgotten card",
) -> Task:
    """Create a task and back-date its ``status_changed_at`` past the auto-stamp.

    ``Task.save()`` stamps ``status_changed_at`` to now on creation, so a stale age
    is applied afterwards with a raw ``update()`` that bypasses ``save()``.
    """
    task = Task.objects.create(
        project=project,
        name=name,
        duration=1,
        status=status,
        assignee=assignee,
        percent_complete=percent_complete,
    )
    if status_age_days is not None:
        stamped = timezone.now() - timedelta(days=status_age_days)
        Task.objects.filter(pk=task.pk).update(status_changed_at=stamped)
    return task


# ---------------------------------------------------------------------------
# Core detection
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_stale_assigned_task_notifies_assignee(project: Project, bob: Any) -> None:
    _make_task(project, assignee=bob, status_age_days=10)

    created = create_stale_task_notifications()

    assert created == 1
    notif = Notification.objects.get(recipient=bob, event_type=STALE_EVENT)
    assert notif.project_id == project.id
    assert not notif.is_read
    # Email defaults OFF (Priya's un-opted-email rule) — in-app only.
    assert notif.email_pending is False
    assert "stale" in notif.subject.lower()


@pytest.mark.django_db
def test_fresh_task_is_not_stale(project: Project, bob: Any) -> None:
    _make_task(project, assignee=bob, status_age_days=1)
    assert create_stale_task_notifications() == 0
    assert not Notification.objects.filter(event_type=STALE_EVENT).exists()


@pytest.mark.django_db
def test_threshold_boundary_exactly_n_days(project: Project, bob: Any) -> None:
    """At exactly the threshold the task is NOT stale; a hair older, it is.

    The scan filters ``status_changed_at < now - threshold`` (strictly less), so a
    task whose status was stamped exactly ``threshold`` days ago is on the boundary
    and excluded. This pins the off-by-one.
    """
    now = timezone.now()
    threshold = DEFAULT_STALE_TASK_THRESHOLD_DAYS
    task = _make_task(project, assignee=bob, status_age_days=None)
    # Exactly on the cutoff — not yet stale.
    Task.objects.filter(pk=task.pk).update(status_changed_at=now - timedelta(days=threshold))
    assert create_stale_task_notifications(now=now) == 0

    # One second past the cutoff — stale.
    Task.objects.filter(pk=task.pk).update(
        status_changed_at=now - timedelta(days=threshold, seconds=1)
    )
    assert create_stale_task_notifications(now=now) == 1


@pytest.mark.django_db
def test_terminal_task_excluded(project: Project, bob: Any) -> None:
    _make_task(project, assignee=bob, status=TaskStatus.COMPLETE, status_age_days=30)
    assert create_stale_task_notifications() == 0


@pytest.mark.django_db
def test_unassigned_task_excluded(project: Project, bob: Any) -> None:
    _make_task(project, assignee=None, status_age_days=30)
    assert create_stale_task_notifications() == 0


@pytest.mark.django_db
def test_review_task_pending_signoff_is_stale(project: Project, bob: Any) -> None:
    # REVIEW coerces percent_complete to 100 (functionally done, pending sign-off) but
    # is the flagship "forgot in Review" case — staleness is by status column, not %.
    task = _make_task(project, assignee=bob, status=TaskStatus.REVIEW, status_age_days=30)
    task.refresh_from_db()
    assert task.percent_complete == 100  # coerced by save()
    assert create_stale_task_notifications() == 1


@pytest.mark.django_db
def test_long_task_name_does_not_abort_scan(project: Project, bob: Any) -> None:
    # Task.name (max 512) must not overflow Notification.subject (max 255) — bulk_create
    # bypasses validation, so an over-long subject would DataError and abort the scan.
    long_name = "X" * 500
    _make_task(project, assignee=bob, status_age_days=10, name=long_name)
    assert create_stale_task_notifications() == 1
    notif = Notification.objects.get(recipient=bob, event_type=STALE_EVENT)
    assert len(notif.subject) <= 255
    assert notif.subject.endswith('" has gone stale')


@pytest.mark.django_db
def test_soft_deleted_task_excluded(project: Project, bob: Any) -> None:
    task = _make_task(project, assignee=bob, status_age_days=30)
    Task.objects.filter(pk=task.pk).update(is_deleted=True)
    assert create_stale_task_notifications() == 0


# ---------------------------------------------------------------------------
# Per-project threshold
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_per_project_threshold_override(calendar: Calendar, bob: Any) -> None:
    strict = Project.objects.create(
        name="Strict", start_date=date(2026, 3, 1), calendar=calendar, stale_task_threshold_days=3
    )
    lax = Project.objects.create(
        name="Lax", start_date=date(2026, 3, 1), calendar=calendar, stale_task_threshold_days=14
    )
    # 5 days old: stale for the 3-day board, fresh for the 14-day board.
    _make_task(strict, assignee=bob, status_age_days=5, name="Strict card")
    _make_task(lax, assignee=bob, status_age_days=5, name="Lax card")

    created = create_stale_task_notifications()

    assert created == 1
    assert Notification.objects.filter(event_type=STALE_EVENT, project=strict).count() == 1
    assert Notification.objects.filter(event_type=STALE_EVENT, project=lax).count() == 0


# ---------------------------------------------------------------------------
# Dedupe / idempotency
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_rerun_dedupes_against_unread(project: Project, bob: Any) -> None:
    _make_task(project, assignee=bob, status_age_days=10)
    assert create_stale_task_notifications() == 1
    # Second run finds the existing UNREAD stale notification and creates nothing.
    assert create_stale_task_notifications() == 0
    assert Notification.objects.filter(event_type=STALE_EVENT, recipient=bob).count() == 1


@pytest.mark.django_db
def test_read_notification_allows_a_fresh_nudge(project: Project, bob: Any) -> None:
    _make_task(project, assignee=bob, status_age_days=10)
    assert create_stale_task_notifications() == 1
    # The user reads (acknowledges) it but leaves the task stale — a later run re-nudges.
    Notification.objects.filter(event_type=STALE_EVENT, recipient=bob).update(is_read=True)
    assert create_stale_task_notifications() == 1
    assert Notification.objects.filter(event_type=STALE_EVENT, recipient=bob).count() == 2


@pytest.mark.django_db
def test_archived_notification_does_not_block_but_is_not_double_counted(
    project: Project, bob: Any
) -> None:
    # An archived (read+aged) stale notification should not suppress a new nudge:
    # dedupe is against UNREAD, un-archived rows only.
    _make_task(project, assignee=bob, status_age_days=10)
    create_stale_task_notifications()
    Notification.objects.filter(event_type=STALE_EVENT).update(is_read=True, is_archived=True)
    assert create_stale_task_notifications() == 1


# ---------------------------------------------------------------------------
# Preference gating
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_user_in_app_off_suppresses(project: Project, bob: Any) -> None:
    NotificationPreference.objects.create(
        user=bob, event_type=STALE_EVENT, channel=NotificationChannel.IN_APP, enabled=False
    )
    _make_task(project, assignee=bob, status_age_days=10)
    assert create_stale_task_notifications() == 0


@pytest.mark.django_db
def test_user_email_opt_in_flags_email_pending(project: Project, bob: Any) -> None:
    NotificationPreference.objects.create(
        user=bob, event_type=STALE_EVENT, channel=NotificationChannel.EMAIL, enabled=True
    )
    _make_task(project, assignee=bob, status_age_days=10)
    assert create_stale_task_notifications() == 1
    notif = Notification.objects.get(recipient=bob, event_type=STALE_EVENT)
    assert notif.email_pending is True


# ---------------------------------------------------------------------------
# Project serializer: threshold setting (validation + RBAC)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_admin_can_set_threshold(project: Project) -> None:
    admin = User.objects.create_user(username="pm", password="pw", email="pm@x.io")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"stale_task_threshold_days": 14}, format="json"
    )
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.stale_task_threshold_days == 14


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, 366, -1])
def test_threshold_rejects_out_of_range(project: Project, bad: int) -> None:
    admin = User.objects.create_user(username="pm2", password="pw", email="pm2@x.io")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"stale_task_threshold_days": bad}, format="json"
    )
    assert resp.status_code == 400
    assert "stale_task_threshold_days" in resp.data


@pytest.mark.django_db
def test_scheduler_cannot_change_threshold(project: Project) -> None:
    """Threshold is Admin-only — it is deliberately out of _SCHEDULER_WRITABLE_FIELDS."""
    scheduler = User.objects.create_user(username="sched", password="pw", email="s@x.io")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"stale_task_threshold_days": 21}, format="json"
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.stale_task_threshold_days == 7
