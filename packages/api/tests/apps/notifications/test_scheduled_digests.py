"""Tests for the scheduled program-health / overallocation digests (ADR-0663, #2407).

Covers the four things that can actually break this feature:

1. **Slot matching** — the sweep fires only in the recipient's own timezone-local
   weekday+hour, which is the whole reason it runs hourly.
2. **Opt-in** — both channels default OFF, so an untouched install sends nothing.
3. **Idempotency** — the ``(user, event_type, period_start)`` ledger makes a second
   sweep in the same hour (or the same week) a no-op.
4. **The honest empty state** — "nothing at risk" is a send, not a suppression.

Like ``test_stale_task_detection``, the sweep is exercised through
:func:`send_due_digests` with an injected clock rather than the Celery wrapper, so no
broker or Redis is in the loop.
"""

from __future__ import annotations

import datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProjectMembership,
    Role,
)
from trueppm_api.apps.notifications.digests import (
    build_program_health_digest,
    build_resource_overallocation_digest,
    purge_old_digest_runs,
    resolve_user_timezone,
    send_due_digests,
    week_start_for,
)
from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationDigestRun,
    NotificationEventType,
    NotificationPreference,
    UserNotificationSettings,
)
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task, TaskStatus

User = get_user_model()

HEALTH_EVENT = NotificationEventType.PROGRAM_HEALTH_DIGEST.value
OVERALLOC_EVENT = NotificationEventType.RESOURCE_OVERALLOCATION_DIGEST.value

# 2026-07-26 is a Sunday. weekday()==6, which is the model default.
SUNDAY_1700_UTC = datetime.datetime(2026, 7, 26, 17, 0, tzinfo=datetime.UTC)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Digest Standard")


@pytest.fixture
def janet(db: object) -> Any:
    return User.objects.create_user(username="digest_janet", password="pw", email="janet@x.io")


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="Apollo")


@pytest.fixture
def late_project(program: Program, calendar: Calendar) -> Project:
    """A project guaranteed to land in the ``critical`` schedule-health band.

    SPI = complete-by-today / planned-by-today. Three tasks were due well before
    today and none is complete, so SPI is 0 → ``critical``.
    """
    project = Project.objects.create(
        name="Lander",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        program=program,
    )
    for i in range(3):
        Task.objects.create(
            project=project,
            name=f"Overdue {i}",
            early_finish=datetime.date(2026, 2, 1),
            status=TaskStatus.IN_PROGRESS,
        )
    return project


def _opt_in(user: Any, event_type: str, *, in_app: bool = True, email: bool = False) -> None:
    """Store explicit preference rows — the only way a digest ever sends."""
    NotificationPreference.objects.create(
        user=user, event_type=event_type, channel=NotificationChannel.IN_APP.value, enabled=in_app
    )
    NotificationPreference.objects.create(
        user=user, event_type=event_type, channel=NotificationChannel.EMAIL.value, enabled=email
    )


# ---------------------------------------------------------------------------
# Opt-in gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_no_digest_without_explicit_opt_in(janet: Any, program: Program, late_project: Project):
    """An untouched install sends nothing — both channels default OFF."""
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)

    assert send_due_digests(now=SUNDAY_1700_UTC) == 0
    assert not Notification.objects.filter(recipient=janet).exists()
    assert not NotificationDigestRun.objects.exists()


@pytest.mark.django_db
def test_digest_sends_when_opted_in(janet: Any, program: Program, late_project: Project):
    """An opted-in member on a critical program gets one inbox row naming it."""
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    assert send_due_digests(now=SUNDAY_1700_UTC) == 1

    notif = Notification.objects.get(recipient=janet, event_type=HEALTH_EVENT)
    assert "Apollo" in notif.body
    # The contributing project is named, not just the program.
    assert "Lander" in notif.body
    # A digest is account-scoped — it spans the whole membership set.
    assert notif.project_id is None


@pytest.mark.django_db
def test_email_channel_opt_in_sets_email_pending(
    janet: Any, program: Program, late_project: Project
):
    """Opting into email marks the row for the existing outbox drain."""
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT, in_app=True, email=True)

    send_due_digests(now=SUNDAY_1700_UTC)

    assert Notification.objects.get(recipient=janet, event_type=HEALTH_EVENT).email_pending is True


# ---------------------------------------------------------------------------
# Slot matching
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_wrong_hour_does_not_send(janet: Any, program: Program, late_project: Project):
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    off_hour = SUNDAY_1700_UTC.replace(hour=16)
    assert send_due_digests(now=off_hour) == 0


@pytest.mark.django_db
def test_wrong_weekday_does_not_send(janet: Any, program: Program, late_project: Project):
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    # 2026-07-27 is the Monday after.
    monday = datetime.datetime(2026, 7, 27, 17, 0, tzinfo=datetime.UTC)
    assert send_due_digests(now=monday) == 0


@pytest.mark.django_db
def test_slot_is_evaluated_in_the_users_timezone(
    janet: Any, program: Program, late_project: Project
):
    """The whole reason the sweep runs hourly: the slot is the user's, not the cluster's.

    17:00 in New York is 21:00 UTC, so the UTC hour that fires is 21 — not 17.
    """
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)
    UserNotificationSettings.objects.create(
        user=janet, digest_weekday=6, digest_hour=17, digest_timezone="America/New_York"
    )

    assert send_due_digests(now=SUNDAY_1700_UTC) == 0
    assert send_due_digests(now=SUNDAY_1700_UTC.replace(hour=21)) == 1


@pytest.mark.django_db
def test_unknown_timezone_falls_back_to_server_timezone():
    """A stale tz key must degrade, not raise — one bad row can't break the sweep."""
    assert resolve_user_timezone("Mars/Olympus_Mons") is not None
    assert resolve_user_timezone("") is not None


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_second_sweep_same_hour_is_a_noop(janet: Any, program: Program, late_project: Project):
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    assert send_due_digests(now=SUNDAY_1700_UTC) == 1
    assert send_due_digests(now=SUNDAY_1700_UTC) == 0
    assert Notification.objects.filter(recipient=janet, event_type=HEALTH_EVENT).count() == 1


@pytest.mark.django_db
def test_ledger_period_is_the_week_not_the_send_day(
    janet: Any, program: Program, late_project: Project
):
    """Changing the send day mid-week must not produce a second digest for that week.

    ``week_start_for`` anchors on Monday, so Sunday and the preceding Wednesday in
    the same ISO week share one ledger row.
    """
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)
    settings_row = UserNotificationSettings.objects.create(
        user=janet, digest_weekday=6, digest_hour=17
    )

    assert send_due_digests(now=SUNDAY_1700_UTC) == 1

    # Move the slot to Wednesday of the SAME week (2026-07-22) and sweep again.
    settings_row.digest_weekday = 2
    settings_row.save(update_fields=["digest_weekday"])
    wednesday = datetime.datetime(2026, 7, 22, 17, 0, tzinfo=datetime.UTC)
    assert week_start_for(wednesday) == week_start_for(SUNDAY_1700_UTC)
    assert send_due_digests(now=wednesday) == 0


@pytest.mark.django_db
def test_next_week_sends_again(janet: Any, program: Program, late_project: Project):
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    assert send_due_digests(now=SUNDAY_1700_UTC) == 1
    next_sunday = SUNDAY_1700_UTC + datetime.timedelta(days=7)
    assert send_due_digests(now=next_sunday) == 1
    assert Notification.objects.filter(recipient=janet, event_type=HEALTH_EVENT).count() == 2


# ---------------------------------------------------------------------------
# Honest empty state
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_empty_digest_is_still_sent(janet: Any, program: Program, calendar: Calendar):
    """"Nothing at risk" is a complete report, not a suppressed one."""
    # A program with a healthy project — no task is overdue, so health is not at_risk.
    Project.objects.create(
        name="Healthy",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        program=program,
    )
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)
    _opt_in(janet, HEALTH_EVENT)

    assert send_due_digests(now=SUNDAY_1700_UTC) == 1
    notif = Notification.objects.get(recipient=janet, event_type=HEALTH_EVENT)
    assert "nothing at risk" in notif.subject.lower()
    assert "complete report" in notif.body


@pytest.mark.django_db
def test_healthy_program_is_not_listed(janet: Any, program: Program, calendar: Calendar):
    """Only at_risk/critical programs earn a line — a digest line must mean something."""
    Project.objects.create(
        name="Healthy",
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        program=program,
    )
    ProgramMembership.objects.create(program=program, user=janet, role=Role.ADMIN)

    _, body = build_program_health_digest(janet, SUNDAY_1700_UTC)
    assert "Healthy" not in body


# ---------------------------------------------------------------------------
# Overallocation digest audience
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_overallocation_digest_skips_projects_below_scheduler_role(
    janet: Any, calendar: Calendar, late_project: Project
):
    """A contributor has no lever over allocation, so they are not in the audience."""
    ProjectMembership.objects.create(project=late_project, user=janet, role=Role.MEMBER)

    _, body = build_resource_overallocation_digest(janet, SUNDAY_1700_UTC)
    assert "Lander" not in body
    assert "nobody over capacity" not in body.lower() or "complete report" in body


@pytest.mark.django_db
def test_overallocation_empty_state(janet: Any, calendar: Calendar, late_project: Project):
    ProjectMembership.objects.create(project=late_project, user=janet, role=Role.SCHEDULER)

    subject, body = build_resource_overallocation_digest(janet, SUNDAY_1700_UTC)
    # No assignments exist, so nobody is over capacity.
    assert "nobody over capacity" in subject.lower()
    assert "complete report" in body


# ---------------------------------------------------------------------------
# Ledger retention
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_purge_drops_only_rows_past_retention(janet: Any):
    fresh = NotificationDigestRun.objects.create(
        user=janet, event_type=HEALTH_EVENT, period_start=datetime.date(2026, 7, 20)
    )
    old = NotificationDigestRun.objects.create(
        user=janet, event_type=HEALTH_EVENT, period_start=datetime.date(2026, 1, 5)
    )
    # created_at is auto_now_add, so age it explicitly.
    NotificationDigestRun.objects.filter(pk=old.pk).update(
        created_at=datetime.datetime(2026, 1, 5, tzinfo=datetime.UTC)
    )

    purge_old_digest_runs(older_than_days=90)

    assert NotificationDigestRun.objects.filter(pk=fresh.pk).exists()
    assert not NotificationDigestRun.objects.filter(pk=old.pk).exists()


# ---------------------------------------------------------------------------
# Settings endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_settings_endpoint_round_trips_the_slot(janet: Any):
    client = APIClient()
    client.force_authenticate(user=janet)

    resp = client.patch(
        "/api/v1/me/notification-settings/",
        {"digest_weekday": 4, "digest_hour": 8, "digest_timezone": "Europe/Berlin"},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["digest_weekday"] == 4
    assert resp.data["digest_hour"] == 8
    assert resp.data["digest_timezone"] == "Europe/Berlin"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "payload",
    [
        {"digest_weekday": 7},
        {"digest_weekday": -1},
        {"digest_hour": 24},
        {"digest_hour": -1},
        {"digest_timezone": "Not/AZone"},
    ],
)
def test_settings_endpoint_rejects_out_of_range(janet: Any, payload: dict[str, Any]):
    """A bad slot is a 400, never a silent clamp to a time the user did not choose."""
    client = APIClient()
    client.force_authenticate(user=janet)

    resp = client.patch("/api/v1/me/notification-settings/", payload, format="json")
    assert resp.status_code == 400, resp.data
