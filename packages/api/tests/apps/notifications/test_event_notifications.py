"""Tests for #639 email notifications — per-user own-task event prefs + dispatch.

Covers: the conservative default seeds, create_event_notifications gating,
the generalized (mention-free) email render, NOTIFICATION_CHANNELS registration,
the read-only SMTP status endpoint, and end-to-end event dispatch on task PATCH /
comment create (ADR-0085).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import override_settings
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.registry import NOTIFICATION_CHANNELS
from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.notifications.services import (
    create_event_notifications,
    get_or_create_default_preferences,
)
from trueppm_api.apps.notifications.tasks import _send_email_for_notification
from trueppm_api.apps.projects.models import Calendar, Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="NotifProj", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin(db: object) -> Any:
    return User.objects.create_user(username="ev_admin", password="pw", email="admin@x.io")


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="bob", password="pw", email="bob@x.io")


@pytest.fixture
def memberships(project: Project, admin: Any, bob: Any) -> None:
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER)


@pytest.fixture
def client(admin: Any, memberships: None) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


# ---------------------------------------------------------------------------
# Default seeds (Priya: email OFF)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_defaults_seed_own_task_events_email_off(bob: Any) -> None:
    get_or_create_default_preferences(bob)
    for event in (
        NotificationEventType.TASK_ASSIGNED,
        NotificationEventType.TASK_DUE_DATE_CHANGED,
        NotificationEventType.COMMENT_ON_MY_TASK,
    ):
        in_app = NotificationPreference.objects.get(
            user=bob, event_type=event, channel=NotificationChannel.IN_APP
        )
        email = NotificationPreference.objects.get(
            user=bob, event_type=event, channel=NotificationChannel.EMAIL
        )
        assert in_app.enabled is True
        assert email.enabled is False, f"{event} email default must be OFF (Priya)"


# ---------------------------------------------------------------------------
# create_event_notifications gating
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_event_notification_uses_defaults_when_no_rows(project: Project, bob: Any) -> None:
    # No stored prefs → default (in_app ON, email OFF): in-app row, no email.
    n = create_event_notifications(
        event_type=NotificationEventType.TASK_ASSIGNED.value,
        recipient_ids=[bob.pk],
        subject="s",
        body="b",
        project_id=project.pk,
    )
    assert n == 1
    notif = Notification.objects.get(recipient=bob)
    assert notif.event_type == "task.assigned"
    assert notif.email_pending is False
    assert notif.mention_id is None


@pytest.mark.django_db
def test_event_notification_email_pending_when_opted_in(project: Project, bob: Any) -> None:
    NotificationPreference.objects.create(
        user=bob,
        event_type=NotificationEventType.TASK_ASSIGNED,
        channel=NotificationChannel.EMAIL,
        enabled=True,
    )
    create_event_notifications(
        event_type=NotificationEventType.TASK_ASSIGNED.value,
        recipient_ids=[bob.pk],
        subject="s",
        body="b",
        project_id=project.pk,
    )
    assert Notification.objects.get(recipient=bob).email_pending is True


@pytest.mark.django_db
def test_event_notification_skipped_when_in_app_off(project: Project, bob: Any) -> None:
    NotificationPreference.objects.create(
        user=bob,
        event_type=NotificationEventType.TASK_ASSIGNED,
        channel=NotificationChannel.IN_APP,
        enabled=False,
    )
    n = create_event_notifications(
        event_type=NotificationEventType.TASK_ASSIGNED.value,
        recipient_ids=[bob.pk],
        subject="s",
        body="b",
        project_id=project.pk,
    )
    assert n == 0
    assert not Notification.objects.filter(recipient=bob).exists()


@pytest.mark.django_db
def test_event_notification_dedupes_none_and_duplicates(project: Project, bob: Any) -> None:
    n = create_event_notifications(
        event_type=NotificationEventType.TASK_ASSIGNED.value,
        recipient_ids=[bob.pk, bob.pk, None],
        subject="s",
        body="b",
        project_id=project.pk,
    )
    assert n == 1


# ---------------------------------------------------------------------------
# Generalized (mention-free) email render
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
def test_event_sourced_notification_renders_and_sends(project: Project, bob: Any) -> None:
    notif = Notification.objects.create(
        recipient=bob,
        project=project,
        event_type="task.assigned",
        subject="You were assigned to Foundation pour",
        body="You were assigned to the task in TruePPM.",
        email_pending=True,
    )
    mail.outbox.clear()
    assert _send_email_for_notification(notif) is True
    assert len(mail.outbox) == 1
    assert mail.outbox[0].subject == "You were assigned to Foundation pour"
    assert mail.outbox[0].to == ["bob@x.io"]


# ---------------------------------------------------------------------------
# Channel registration
# ---------------------------------------------------------------------------


def test_notification_channels_registered() -> None:
    assert "email" in NOTIFICATION_CHANNELS
    assert "in_app" in NOTIFICATION_CHANNELS


# ---------------------------------------------------------------------------
# SMTP status endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_smtp_status_for_org_admin(client: APIClient) -> None:
    resp = client.get("/api/v1/workspace/email-settings/")
    assert resp.status_code == 200, resp.data
    assert "from_email" in resp.data
    assert "transport_mode" in resp.data
    # Never expose the password / username.
    assert "password" not in resp.data
    assert "EMAIL_HOST_PASSWORD" not in resp.data


@pytest.mark.django_db
def test_smtp_status_forbidden_for_non_admin(project: Project) -> None:
    member = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=member)
    assert c.get("/api/v1/workspace/email-settings/").status_code == 403


# ---------------------------------------------------------------------------
# End-to-end dispatch on task PATCH / comment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_assigning_task_notifies_new_assignee_not_actor(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Foundation pour", duration=1)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(f"/api/v1/tasks/{task.pk}/", {"assignee": bob.pk}, format="json")
    assert resp.status_code == 200, resp.data
    # New assignee (bob) gets an in-app task.assigned notification; actor (admin) does not.
    assert Notification.objects.filter(recipient=bob, event_type="task.assigned").count() == 1
    assert not Notification.objects.filter(recipient=admin, event_type="task.assigned").exists()


@pytest.mark.django_db
def test_comment_notifies_task_assignee(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    task = Task.objects.create(project=project, name="Foundation pour", duration=1, assignee=bob)
    url = f"/api/v1/projects/{project.pk}/tasks/{task.pk}/comments/"
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.post(url, {"body": "looks good"}, format="json")
    assert resp.status_code == 201, resp.data
    # Assignee bob (not the commenter admin) gets a comment_on_my_task notification.
    assert Notification.objects.filter(recipient=bob, event_type="comment_on_my_task").count() == 1


# ---------------------------------------------------------------------------
# task.blocked transition (#855 / #476)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_blocking_task_notifies_assignee_not_actor(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Setting blocked_reason on bob's task notifies bob, not the actor (admin)."""
    task = Task.objects.create(project=project, name="Foundation pour", duration=1, assignee=bob)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"blocked_reason": "Waiting on the permit"},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    assert Notification.objects.filter(recipient=bob, event_type="task.blocked").count() == 1
    assert not Notification.objects.filter(recipient=admin, event_type="task.blocked").exists()


@pytest.mark.django_db
def test_blocked_notification_fires_once_not_on_reason_edit(
    client: APIClient,
    project: Project,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Editing an already-blocked task's reason must not re-notify (transition guard)."""
    task = Task.objects.create(
        project=project,
        name="Foundation pour",
        duration=1,
        assignee=bob,
        blocked_reason="Waiting on the permit",
    )
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"blocked_reason": "Still waiting on the permit"},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    # No new task.blocked notification — the task was already blocked.
    assert not Notification.objects.filter(recipient=bob, event_type="task.blocked").exists()


@pytest.mark.django_db
def test_blocked_default_seed_in_app_on_email_off(bob: Any) -> None:
    get_or_create_default_preferences(bob)
    in_app = NotificationPreference.objects.get(
        user=bob,
        event_type=NotificationEventType.TASK_BLOCKED,
        channel=NotificationChannel.IN_APP,
    )
    email = NotificationPreference.objects.get(
        user=bob,
        event_type=NotificationEventType.TASK_BLOCKED,
        channel=NotificationChannel.EMAIL,
    )
    assert in_app.enabled is True
    assert email.enabled is False


# ---------------------------------------------------------------------------
# ADR-0124 #1134 — impediment routing to SM + PM, reason never in the body
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_blocked_notifies_scrum_master_and_pm_not_just_assignee(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Flagging a task blocked routes to the assignee + Scrum Master + PM (#1134).

    The actor (who raised it) is excluded; the SM (team facet) and the other PM
    (Role.ADMIN) are both notified even though they are not the assignee. The actor
    is a PM here because raising a blocker on someone else's task requires write
    access (IsProjectMemberWriteOrOwn) — a plain member can only flag their own task.
    """
    from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

    # carol (a PM) raises the flag on bob's task (the actor); dave is the SM; admin
    # is the other PM; bob owns it. carol is excluded as the actor.
    carol = User.objects.create_user(username="carol", password="pw", email="carol@x.io")
    dave = User.objects.create_user(username="dave", password="pw", email="dave@x.io")
    ProjectMembership.objects.create(project=project, user=carol, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=dave, role=Role.MEMBER)
    team = Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)
    TeamMembership.objects.create(team=team, user=dave, role=TeamRole.MEMBER, is_scrum_master=True)

    task = Task.objects.create(project=project, name="Foundation pour", duration=1, assignee=bob)

    actor_client = APIClient()
    actor_client.force_authenticate(user=carol)
    with django_capture_on_commit_callbacks(execute=True):
        resp = actor_client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"blocked_reason": "Waiting on the permit", "blocker_type": "vendor"},
            format="json",
        )
    assert resp.status_code == 200, resp.data

    recipients = set(
        Notification.objects.filter(event_type="task.blocked").values_list(
            "recipient__username", flat=True
        )
    )
    # assignee (bob) + SM (dave) + PM (admin=ev_admin); the actor (carol) is excluded.
    assert recipients == {"bob", "dave", "ev_admin"}
    assert "carol" not in recipients


@pytest.mark.django_db
def test_blocked_notification_body_never_contains_reason(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The task.blocked subject/body carry type + age, NEVER the reason (Morgan)."""
    secret = "SECRET vendor escalation details"
    task = Task.objects.create(project=project, name="Foundation pour", duration=1, assignee=bob)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"blocked_reason": secret, "blocker_type": "vendor"},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    notif = Notification.objects.get(recipient=bob, event_type="task.blocked")
    assert secret not in notif.subject
    assert secret not in notif.body
    # The triage signal (the type label) IS present.
    assert "External vendor" in notif.body


# ---------------------------------------------------------------------------
# ADR-0124 #1136 — opt-in email fires off-device, still reason-free
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
def test_blocked_email_fires_for_opted_in_recipient_without_reason(
    client: APIClient,
    project: Project,
    admin: Any,
    bob: Any,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A recipient who opted into the task.blocked EMAIL channel gets an email (#1136).

    The email is the off-device nudge Sarah/Priya asked for; its body still never
    contains the free-text reason. Drives the real Notification.email_pending →
    drain path end to end.
    """
    from trueppm_api.apps.notifications.tasks import _do_drain_emails

    NotificationPreference.objects.create(
        user=bob,
        event_type=NotificationEventType.TASK_BLOCKED,
        channel=NotificationChannel.EMAIL,
        enabled=True,
    )
    secret = "SECRET reason text"
    task = Task.objects.create(project=project, name="Foundation pour", duration=1, assignee=bob)
    mail.outbox.clear()
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.patch(
            f"/api/v1/tasks/{task.pk}/",
            {"blocked_reason": secret, "blocker_type": "decision"},
            format="json",
        )
    assert resp.status_code == 200, resp.data
    notif = Notification.objects.get(recipient=bob, event_type="task.blocked")
    assert notif.email_pending is True
    # Backdate past the email orphan window so the drain picks it up (the window
    # exists so a rolled-back transaction never strands an email — not relevant here).
    from datetime import timedelta as _td

    from django.utils import timezone as _tz

    Notification.objects.filter(pk=notif.pk).update(created_at=_tz.now() - _td(minutes=30))
    _do_drain_emails()
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["bob@x.io"]
    assert secret not in mail.outbox[0].subject
    assert secret not in mail.outbox[0].body
    assert "Decision needed" in mail.outbox[0].body
