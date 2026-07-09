"""Tests for account-wide Do-Not-Disturb (#1707, ADR-0292).

The safety contract: account-wide DND silences the transient channel (email) for
routine events while (a) the durable in-app inbox row is ALWAYS created — nothing
is ever lost — and (b) the four DND_BYPASS_EVENTS always email through, so a muted
bell can never swallow a blocker. Covers the pure gate predicate, all four
dispatch paths that compute ``email_pending``, the /me/notification-settings/
endpoint, and the read-only ``dnd_enabled`` projection on /auth/me.
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
    DND_BYPASS_EVENTS,
    SIGNAL_ONLY_EVENTS,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
    UserNotificationSettings,
)
from trueppm_api.apps.notifications.services import (
    ParsedMention,
    _dnd_silences,
    create_event_notifications,
    create_event_notifications_batch,
    create_mention_notifications,
    create_stale_task_notifications,
    get_or_create_notification_settings,
    resolve_parsed_mentions,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment, TaskStatus

User = get_user_model()

SETTINGS_URL = "/api/v1/me/notification-settings/"
ME_URL = "/api/v1/auth/me/"
ROUTINE_EVENT = NotificationEventType.TASK_ASSIGNED.value


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="DndProj", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def author(db: object) -> Any:
    return User.objects.create_user(username="dnd_author", password="pw", email="author@x.io")


@pytest.fixture
def alice(db: object) -> Any:
    return User.objects.create_user(username="dnd_alice", password="pw", email="alice@x.io")


@pytest.fixture
def bob(db: object) -> Any:
    return User.objects.create_user(username="dnd_bob", password="pw", email="bob@x.io")


@pytest.fixture
def memberships(
    project: Project, author: Any, alice: Any, bob: Any
) -> dict[str, ProjectMembership]:
    return {
        "author": ProjectMembership.objects.create(project=project, user=author, role=Role.ADMIN),
        "alice": ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER),
        "bob": ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER),
    }


@pytest.fixture
def comment(project: Project, author: Any) -> TaskComment:
    task = Task.objects.create(project=project, name="T", duration=1)
    return TaskComment.objects.create(task=task, author=author, body="body")


def _enable_email(user: Any, event: Any) -> None:
    """Opt the user into email for ``event`` so the DND-off baseline emails —
    isolating the DND effect from the (mostly OFF) per-event email defaults."""
    NotificationPreference.objects.create(
        user=user,
        event_type=event,
        channel=NotificationChannel.EMAIL,
        enabled=True,
    )


def _make_stale_task(project: Project, assignee: Any) -> Task:
    task = Task.objects.create(
        project=project, name="Forgotten", duration=1, status=TaskStatus.REVIEW, assignee=assignee
    )
    # Task.save() stamps status_changed_at to now; back-date past the 7-day default.
    Task.objects.filter(pk=task.pk).update(status_changed_at=timezone.now() - timedelta(days=30))
    return task


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Pure gate predicate — the safety contract, no DB
# ---------------------------------------------------------------------------


class TestDndSilencesPredicate:
    def test_dnd_off_never_silences(self) -> None:
        assert (
            _dnd_silences(ROUTINE_EVENT, NotificationChannel.EMAIL.value, dnd_enabled=False)
            is False
        )

    def test_in_app_never_silenced_even_under_dnd(self) -> None:
        # The durable inbox row is never gated by DND (mirrors quiet-hours exemption).
        assert (
            _dnd_silences(ROUTINE_EVENT, NotificationChannel.IN_APP.value, dnd_enabled=True)
            is False
        )

    def test_routine_email_silenced_under_dnd(self) -> None:
        assert (
            _dnd_silences(ROUTINE_EVENT, NotificationChannel.EMAIL.value, dnd_enabled=True) is True
        )

    @pytest.mark.parametrize("event", sorted(DND_BYPASS_EVENTS))
    def test_bypass_events_email_through_dnd(self, event: str) -> None:
        assert _dnd_silences(event, NotificationChannel.EMAIL.value, dnd_enabled=True) is False

    def test_bypass_set_is_exactly_the_four_and_differs_from_signal_only(self) -> None:
        # The load-bearing membership (#1707). Deliberately NOT SIGNAL_ONLY_EVENTS,
        # which is the contributor settings preset (a different, wrong set).
        assert (
            frozenset(
                {
                    NotificationEventType.TASK_BLOCKED,
                    NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED,
                    NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED,
                    NotificationEventType.MILESTONE_FORECAST_SHIFTED,
                }
            )
            == DND_BYPASS_EVENTS
        )
        assert DND_BYPASS_EVENTS != SIGNAL_ONLY_EVENTS
        # A routine due-date change must NOT bypass (the inverse-of-intent bug).
        assert NotificationEventType.TASK_DUE_DATE_CHANGED not in DND_BYPASS_EVENTS


# ---------------------------------------------------------------------------
# create_event_notifications — the primary dispatch path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDndEventDispatch:
    def test_in_app_row_always_created_under_dnd(self, project: Project, bob: Any) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        _enable_email(bob, NotificationEventType.TASK_ASSIGNED)
        n = create_event_notifications(
            event_type=ROUTINE_EVENT,
            recipient_ids=[bob.pk],
            subject="s",
            body="b",
            project_id=project.pk,
        )
        assert n == 1
        notif = Notification.objects.get(recipient=bob)
        # The durable inbox row lands; only its email is held back.
        assert notif.email_pending is False

    def test_routine_email_sent_when_dnd_off(self, project: Project, bob: Any) -> None:
        _enable_email(bob, NotificationEventType.TASK_ASSIGNED)
        create_event_notifications(
            event_type=ROUTINE_EVENT,
            recipient_ids=[bob.pk],
            subject="s",
            body="b",
            project_id=project.pk,
        )
        assert Notification.objects.get(recipient=bob).email_pending is True

    @pytest.mark.parametrize("event", sorted(DND_BYPASS_EVENTS))
    def test_bypass_event_emails_even_under_dnd(
        self, project: Project, bob: Any, event: str
    ) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        _enable_email(bob, event)
        create_event_notifications(
            event_type=event,
            recipient_ids=[bob.pk],
            subject="s",
            body="b",
            project_id=project.pk,
        )
        notif = Notification.objects.get(recipient=bob)
        assert notif.email_pending is True, f"{event} must email through DND"


# ---------------------------------------------------------------------------
# create_event_notifications_batch
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDndBatchDispatch:
    def test_routine_email_held_under_dnd(self, project: Project, bob: Any) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        _enable_email(bob, NotificationEventType.TASK_ASSIGNED)
        create_event_notifications_batch(
            event_type=ROUTINE_EVENT,
            project_id=project.pk,
            rows=[(bob.pk, "s", "b", None)],
        )
        notif = Notification.objects.get(recipient=bob)
        assert notif.email_pending is False

    def test_bypass_email_sent_under_dnd(self, project: Project, bob: Any) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        _enable_email(bob, NotificationEventType.TASK_BLOCKED)
        create_event_notifications_batch(
            event_type=NotificationEventType.TASK_BLOCKED.value,
            project_id=project.pk,
            rows=[(bob.pk, "s", "b", None)],
        )
        assert Notification.objects.get(recipient=bob).email_pending is True


# ---------------------------------------------------------------------------
# create_stale_task_notifications
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDndStaleDispatch:
    def test_stale_email_held_but_inapp_created_under_dnd(self, project: Project, bob: Any) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        _enable_email(bob, NotificationEventType.TASK_STALE)
        _make_stale_task(project, bob)
        created = create_stale_task_notifications()
        assert created == 1
        notif = Notification.objects.get(
            recipient=bob, event_type=NotificationEventType.TASK_STALE.value
        )
        # task.stale is not a bypass event: the nudge stays in the inbox, no email.
        assert notif.email_pending is False


# ---------------------------------------------------------------------------
# create_mention_notifications — durable row survives DND
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDndMentionDispatch:
    def test_mention_inapp_row_created_under_dnd(
        self,
        project: Project,
        author: Any,
        alice: Any,
        comment: TaskComment,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        UserNotificationSettings.objects.create(user=alice, dnd_enabled=True)
        resolved = resolve_parsed_mentions(
            [ParsedMention("user", "dnd_alice")], project.pk, actor_role=Role.ADMIN
        )
        created = create_mention_notifications(
            task_comment=comment,
            mentioner=author,
            parsed_result=resolved,
            project_id=project.pk,
        )
        # DND never drops the durable mention record — the in-app row still lands.
        assert created == 1
        assert Notification.objects.filter(recipient=alice).exists()


# ---------------------------------------------------------------------------
# /me/notification-settings/ endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationSettingsEndpoint:
    def test_requires_auth(self, db: object) -> None:
        assert APIClient().get(SETTINGS_URL).status_code == 401
        assert (
            APIClient().patch(SETTINGS_URL, {"dnd_enabled": True}, format="json").status_code == 401
        )

    def test_get_defaults_false_and_lazily_creates_row(self, bob: Any) -> None:
        assert not UserNotificationSettings.objects.filter(user=bob).exists()
        resp = _client(bob).get(SETTINGS_URL)
        assert resp.status_code == 200
        assert resp.data["dnd_enabled"] is False
        # GET lazily creates the row (the authoritative surface, unlike /auth/me).
        assert UserNotificationSettings.objects.filter(user=bob).exists()

    def test_patch_enables_dnd(self, bob: Any) -> None:
        resp = _client(bob).patch(SETTINGS_URL, {"dnd_enabled": True}, format="json")
        assert resp.status_code == 200
        assert resp.data["dnd_enabled"] is True
        assert get_or_create_notification_settings(bob).dnd_enabled is True

    def test_patch_is_idempotent(self, bob: Any) -> None:
        c = _client(bob)
        c.patch(SETTINGS_URL, {"dnd_enabled": True}, format="json")
        resp = c.patch(SETTINGS_URL, {"dnd_enabled": True}, format="json")
        assert resp.status_code == 200
        assert resp.data["dnd_enabled"] is True

    def test_self_scoped_no_cross_user_effect(self, bob: Any, alice: Any) -> None:
        _client(bob).patch(SETTINGS_URL, {"dnd_enabled": True}, format="json")
        assert get_or_create_notification_settings(bob).dnd_enabled is True
        # alice's own settings are untouched — the endpoint is self-scoped.
        assert _client(alice).get(SETTINGS_URL).data["dnd_enabled"] is False


# ---------------------------------------------------------------------------
# /auth/me dnd_enabled projection
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMeDndProjection:
    def test_me_exposes_dnd_false_by_default(self, bob: Any) -> None:
        resp = _client(bob).get(ME_URL)
        assert resp.status_code == 200
        assert resp.data["dnd_enabled"] is False

    def test_me_does_not_create_a_row(self, bob: Any) -> None:
        # The hot /auth/me read is non-creating — absence reads as DND off.
        _client(bob).get(ME_URL)
        assert not UserNotificationSettings.objects.filter(user=bob).exists()

    def test_me_reflects_enabled_dnd(self, bob: Any) -> None:
        UserNotificationSettings.objects.create(user=bob, dnd_enabled=True)
        resp = _client(bob).get(ME_URL)
        assert resp.data["dnd_enabled"] is True
