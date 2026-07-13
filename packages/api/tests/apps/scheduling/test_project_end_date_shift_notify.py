"""Project end-date shift notification — the third #82 schedule rule (#1911).

Companion to #1668's dependency-slip / became-critical pair. When a project's
CPM finish (tracked via ``ProjectForecastSnapshot``, ADR-0154) moves by more
than the project's configurable ``end_date_shift_threshold_days``, the
project's PM/Owner cohort (role >= ADMIN) is notified. Mirrors the shipped
sibling ``notify_milestone_forecast_shift`` (#861) — same role targeting, same
``create_event_notifications`` emit path, same structural debounce (fires once
per newly-captured snapshot).

These exercise ``notify_project_end_date_shift`` directly against real
``ProjectForecastSnapshot`` rows, plus the ``safe_capture_forecast_snapshot``
wiring end to end.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Notification, NotificationEventType
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus
from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot
from trueppm_api.apps.scheduling.services import (
    notify_project_end_date_shift,
    safe_capture_forecast_snapshot,
)

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    # Default threshold is 5 days (Project.end_date_shift_threshold_days) unless
    # a test overrides it.
    return Project.objects.create(
        name="ShiftProject", start_date=date(2026, 3, 1), calendar=calendar
    )


@pytest.fixture
def people(project: Project) -> dict[str, Any]:
    admin = User.objects.create_user(username="ed_admin", password="pw")
    owner = User.objects.create_user(username="ed_owner", password="pw")
    member = User.objects.create_user(username="ed_member", password="pw")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=owner, role=Role.OWNER)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    return {"admin": admin, "owner": owner, "member": member}


def _snap(project: Project, **kw: Any) -> ProjectForecastSnapshot:
    defaults: dict[str, Any] = dict(project=project, cpm_finish=date(2026, 8, 1))
    defaults.update(kw)
    return ProjectForecastSnapshot.objects.create(**defaults)


# ---------------------------------------------------------------------------
# notify_project_end_date_shift — direct unit tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotifyProjectEndDateShift:
    def test_shift_beyond_threshold_notifies_pm_and_owner_only(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # Default threshold is 5 days; a 10-day slip is material.
        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 11))  # +10 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert (
            Notification.objects.filter(
                recipient=people["admin"],
                event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED,
            ).count()
            == 1
        )
        assert (
            Notification.objects.filter(
                recipient=people["owner"],
                event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED,
            ).count()
            == 1
        )
        assert not Notification.objects.filter(recipient=people["member"]).exists()

        note = Notification.objects.filter(recipient=people["admin"]).first()
        assert note is not None
        assert "2026-08-01" in note.body
        assert "2026-08-11" in note.body
        assert "10 days" in note.body
        assert "pushed out" in note.body
        assert project.name in note.subject

    def test_shift_at_or_below_threshold_notifies_nobody(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # Default threshold is 5 days; a boundary-exact 5-day move is NOT material
        # (the rule is "strictly greater than", matching stale_task_threshold_days'
        # ADR-0200 boundary convention).
        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 6))  # +5 days, at threshold

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.exists()

    def test_shift_below_threshold_notifies_nobody(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 3))  # +2 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.exists()

    def test_respects_per_project_threshold_override(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # Tighten the project's configurable threshold to 1 day; a 2-day move
        # that would be silent under the default (5) must now notify.
        project.end_date_shift_threshold_days = 1
        project.save(update_fields=["end_date_shift_threshold_days"])

        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 3))  # +2 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert Notification.objects.filter(recipient=people["admin"]).count() == 1

    def test_finish_pulled_in_is_also_a_shift(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # A finish moving EARLIER by more than the threshold is a shift too —
        # the rule is symmetric (abs delta), not just slips.
        _snap(project, cpm_finish=date(2026, 8, 20))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 5))  # -15 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        note = Notification.objects.filter(recipient=people["admin"]).first()
        assert note is not None
        assert "pulled in" in note.body

    def test_no_prior_snapshot_does_not_notify(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        new = _snap(project, cpm_finish=date(2026, 8, 1))  # first-ever snapshot

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.exists()

    def test_null_cpm_finish_does_not_notify(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=None)  # no tasks left with a finish

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.exists()

    def test_soft_removed_pm_not_notified(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # Removal is a soft delete that leaves the membership row (with its
        # role) intact, so the digest must not reach a revoked PM (rbac-check).
        ProjectMembership.objects.filter(project=project, user=people["admin"]).update(
            is_deleted=True
        )
        _snap(project, cpm_finish=date(2026, 8, 1))  # prior
        new = _snap(project, cpm_finish=date(2026, 8, 11))  # +10 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.filter(recipient=people["admin"]).exists()
        assert Notification.objects.filter(recipient=people["owner"]).count() == 1

    def test_plain_member_never_notified_even_with_no_pm_filter_bypass(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # rbac-check: role targeting is computed server-side from ProjectMembership,
        # not derived from any caller-supplied recipient list — there is no code
        # path by which a Team Member (role < ADMIN) can end up notified.
        _snap(project, cpm_finish=date(2026, 8, 1))
        new = _snap(project, cpm_finish=date(2026, 8, 20))  # +19 days

        with django_capture_on_commit_callbacks(execute=True):
            notify_project_end_date_shift(new)

        assert not Notification.objects.filter(recipient=people["member"]).exists()


# ---------------------------------------------------------------------------
# safe_capture_forecast_snapshot wiring — end-to-end through the real capture path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSafeCaptureWiring:
    def test_capture_then_material_recompute_notifies(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        early = Task.objects.create(
            project=project,
            name="T1",
            duration=1,
            status=TaskStatus.NOT_STARTED,
            early_finish=date(2026, 8, 1),
            total_float=0,
        )
        with django_capture_on_commit_callbacks(execute=True):
            safe_capture_forecast_snapshot(str(project.pk), "recompute")
        assert not Notification.objects.exists()  # first snapshot — nothing to compare

        # Task finish slips 10 days; a second capture must notify.
        early.early_finish = date(2026, 8, 11)
        early.save(update_fields=["early_finish"])
        with django_capture_on_commit_callbacks(execute=True):
            safe_capture_forecast_snapshot(str(project.pk), "recompute")

        assert Notification.objects.filter(
            recipient=people["admin"],
            event_type=NotificationEventType.PROJECT_END_DATE_SHIFTED,
        ).exists()

    def test_unchanged_recompute_does_not_spam(
        self,
        project: Project,
        people: dict[str, Any],
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        task = Task.objects.create(
            project=project,
            name="T1",
            duration=1,
            status=TaskStatus.NOT_STARTED,
            early_finish=date(2026, 8, 1),
            total_float=0,
        )
        with django_capture_on_commit_callbacks(execute=True):
            safe_capture_forecast_snapshot(str(project.pk), "recompute")
        assert not Notification.objects.exists()  # first snapshot — nothing to compare

        # Material slip — the first real shift. Notifies once.
        task.early_finish = date(2026, 8, 11)
        task.save(update_fields=["early_finish"])
        with django_capture_on_commit_callbacks(execute=True):
            safe_capture_forecast_snapshot(str(project.pk), "recompute")
        assert Notification.objects.count() == 2  # admin + owner

        # Recomputing again with NOTHING changed dedups (capture-path window) —
        # no new snapshot row is written, so notify_project_end_date_shift is
        # never re-invoked for the same already-notified shift. This is the
        # AC's debounce guard: a single material shift produces exactly one
        # round of notifications, not one per recompute.
        with django_capture_on_commit_callbacks(execute=True):
            safe_capture_forecast_snapshot(str(project.pk), "recompute")

        assert Notification.objects.count() == 2


# ---------------------------------------------------------------------------
# ProjectSerializer: end_date_shift_threshold_days setting (validation + RBAC)
# ---------------------------------------------------------------------------
# Mirrors test_stale_task_detection.py's threshold-setting coverage exactly —
# same field shape (PositiveIntegerField, 1-365 validated range, Admin-only
# write via the _SCHEDULER_WRITABLE_FIELDS allowlist).


@pytest.mark.django_db
def test_admin_can_set_threshold(project: Project) -> None:
    admin = User.objects.create_user(username="ts_admin", password="pw", email="a@x.io")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"end_date_shift_threshold_days": 3}, format="json"
    )
    assert resp.status_code == 200, resp.data
    project.refresh_from_db()
    assert project.end_date_shift_threshold_days == 3


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, 366, -1])
def test_threshold_rejects_out_of_range(project: Project, bad: int) -> None:
    admin = User.objects.create_user(username="ts_admin2", password="pw", email="a2@x.io")
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    client = APIClient()
    client.force_authenticate(user=admin)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"end_date_shift_threshold_days": bad}, format="json"
    )
    assert resp.status_code == 400
    assert "end_date_shift_threshold_days" in resp.data


@pytest.mark.django_db
def test_scheduler_cannot_change_threshold(project: Project) -> None:
    """Threshold is Admin-only — it is deliberately out of _SCHEDULER_WRITABLE_FIELDS."""
    scheduler = User.objects.create_user(username="ts_sched", password="pw", email="s@x.io")
    ProjectMembership.objects.create(project=project, user=scheduler, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"end_date_shift_threshold_days": 3}, format="json"
    )
    assert resp.status_code == 400
    project.refresh_from_db()
    assert project.end_date_shift_threshold_days == 5


@pytest.mark.django_db
def test_member_cannot_change_threshold(project: Project) -> None:
    member = User.objects.create_user(username="ts_member", password="pw", email="m@x.io")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member)

    resp = client.patch(
        f"/api/v1/projects/{project.pk}/", {"end_date_shift_threshold_days": 3}, format="json"
    )
    assert resp.status_code in (400, 403)
    project.refresh_from_db()
    assert project.end_date_shift_threshold_days == 5
