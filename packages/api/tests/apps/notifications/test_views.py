"""Tests for NotificationViewSet + NotificationPreferenceViewSet (ADR-0075)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    DEFAULT_PREFERENCES,
    Mention,
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def memberships(project: Project, alice: object, bob: object) -> dict[str, ProjectMembership]:
    return {
        "alice": ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER),
        "bob": ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER),
    }


@pytest.fixture
def alice_client(alice: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=alice)
    return c


@pytest.fixture
def bob_client(bob: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=bob)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def comment(task: Task, bob: object) -> TaskComment:
    return TaskComment.objects.create(task=task, author=bob, body="hello")


@pytest.fixture
def alice_notifications(
    alice: object,
    bob: object,
    comment: TaskComment,
    project: Project,
    memberships: dict[str, ProjectMembership],
) -> list[Notification]:
    """Three notifications addressed to alice — used for list/filter tests."""
    out: list[Notification] = []
    for _ in range(3):
        m = Mention.objects.create(
            mentioner=bob,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
        )
        out.append(Notification.objects.create(recipient=alice, mention=m, project=project))
    return out


# ---------------------------------------------------------------------------
# NotificationViewSet — list / retrieve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationList:
    def test_unauthenticated_blocked(self) -> None:
        r = APIClient().get("/api/v1/me/notifications/")
        assert r.status_code in (401, 403)

    def test_returns_only_own_notifications(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
        alice_notifications: list[Notification],
    ) -> None:
        # Add a notification addressed to bob — alice must not see it.
        m = Mention.objects.create(
            mentioner=alice,
            mentioned_user=bob,
            task_comment=comment,
            project=project,
        )
        Notification.objects.create(recipient=bob, mention=m, project=project)

        r = alice_client.get("/api/v1/me/notifications/")
        assert r.status_code == 200
        recipients = {n["recipient"] for n in r.data["results"]}
        assert recipients == {alice.pk}  # type: ignore[attr-defined]
        assert len(r.data["results"]) == 3

    def test_unread_only_filter(
        self, alice_client: APIClient, alice_notifications: list[Notification]
    ) -> None:
        # Mark one as read
        n = alice_notifications[0]
        n.is_read = True
        n.save(update_fields=["is_read"])
        r = alice_client.get("/api/v1/me/notifications/?unread_only=true")
        assert r.status_code == 200
        assert len(r.data["results"]) == 2

    def test_archived_filter(
        self, alice_client: APIClient, alice_notifications: list[Notification]
    ) -> None:
        n = alice_notifications[0]
        n.is_archived = True
        n.save(update_fields=["is_archived"])
        # Default list excludes archived
        r = alice_client.get("/api/v1/me/notifications/")
        assert len(r.data["results"]) == 2
        # archived=true returns only archived rows
        r2 = alice_client.get("/api/v1/me/notifications/?archived=true")
        assert len(r2.data["results"]) == 1


# ---------------------------------------------------------------------------
# NotificationViewSet — patch / mark-all-read
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationUpdate:
    def test_patch_marks_read_and_stamps_read_at(
        self, alice_client: APIClient, alice_notifications: list[Notification]
    ) -> None:
        n = alice_notifications[0]
        r = alice_client.patch(
            f"/api/v1/me/notifications/{n.pk}/",
            {"is_read": True},
            format="json",
        )
        assert r.status_code == 200
        n.refresh_from_db()
        assert n.is_read is True
        assert n.read_at is not None

    def test_patch_does_not_reset_read_at_on_idempotent_reread(
        self, alice_client: APIClient, alice_notifications: list[Notification]
    ) -> None:
        n = alice_notifications[0]
        alice_client.patch(f"/api/v1/me/notifications/{n.pk}/", {"is_read": True}, format="json")
        n.refresh_from_db()
        first_read_at = n.read_at
        # Another PATCH with is_read=True must not bump read_at
        alice_client.patch(f"/api/v1/me/notifications/{n.pk}/", {"is_read": True}, format="json")
        n.refresh_from_db()
        assert n.read_at == first_read_at

    def test_cannot_patch_another_users_notification(
        self,
        bob_client: APIClient,
        alice_notifications: list[Notification],
    ) -> None:
        n = alice_notifications[0]
        r = bob_client.patch(
            f"/api/v1/me/notifications/{n.pk}/",
            {"is_read": True},
            format="json",
        )
        assert r.status_code == 404  # queryset is recipient-scoped, so not found

    def test_mark_all_read(
        self, alice_client: APIClient, alice_notifications: list[Notification]
    ) -> None:
        r = alice_client.post("/api/v1/me/notifications/mark-all-read/")
        assert r.status_code == 200
        assert r.data["updated"] == 3
        recipient_id = alice_notifications[0].recipient_id
        read_count = Notification.objects.filter(recipient=recipient_id, is_read=True).count()
        assert read_count == 3


# ---------------------------------------------------------------------------
# NotificationPreferenceViewSet
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationPreferences:
    def test_first_get_backfills_defaults(self, alice_client: APIClient, alice: object) -> None:
        assert NotificationPreference.objects.filter(user=alice).count() == 0
        r = alice_client.get("/api/v1/me/notification-preferences/")
        assert r.status_code == 200
        assert len(r.data["results"]) == len(DEFAULT_PREFERENCES)

    def test_patch_toggles_enabled(self, alice_client: APIClient, alice: object) -> None:
        # Backfill defaults
        alice_client.get("/api/v1/me/notification-preferences/")
        pref = NotificationPreference.objects.get(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.EMAIL,
        )
        assert pref.enabled is False
        r = alice_client.patch(
            f"/api/v1/me/notification-preferences/{pref.pk}/",
            {"enabled": True},
            format="json",
        )
        assert r.status_code == 200
        pref.refresh_from_db()
        assert pref.enabled is True

    def test_cannot_patch_other_users_preference(
        self,
        bob_client: APIClient,
        alice_client: APIClient,
        alice: object,
    ) -> None:
        alice_client.get("/api/v1/me/notification-preferences/")
        pref = NotificationPreference.objects.filter(user=alice).first()
        assert pref is not None
        r = bob_client.patch(
            f"/api/v1/me/notification-preferences/{pref.pk}/",
            {"enabled": True},
            format="json",
        )
        assert r.status_code == 404

    def test_unauthenticated_blocked(self) -> None:
        r = APIClient().get("/api/v1/me/notification-preferences/")
        assert r.status_code in (401, 403)

    # -- apply-preset (#855) --------------------------------------------------

    def test_apply_signal_only_preset(self, alice_client: APIClient, alice: object) -> None:
        """signal_only keeps in-app ON for blocked + deadline-changed, all else OFF."""
        from trueppm_api.apps.notifications.models import SIGNAL_ONLY_EVENTS

        r = alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "signal_only"},
            format="json",
        )
        assert r.status_code == 200, r.data
        for pref in NotificationPreference.objects.filter(user=alice):
            expected = (
                pref.channel == NotificationChannel.IN_APP and pref.event_type in SIGNAL_ONLY_EVENTS
            )
            assert pref.enabled is expected, (pref.event_type, pref.channel)

    def test_apply_everything_preset_restores_defaults(
        self, alice_client: APIClient, alice: object
    ) -> None:
        # First go signal-only, then restore everything.
        alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "signal_only"},
            format="json",
        )
        r = alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "everything"},
            format="json",
        )
        assert r.status_code == 200
        default_map = {(e, c): enabled for (e, c, enabled) in DEFAULT_PREFERENCES}
        for pref in NotificationPreference.objects.filter(user=alice):
            assert pref.enabled is default_map[(pref.event_type, pref.channel)]

    def test_apply_preset_rejects_unknown(self, alice_client: APIClient) -> None:
        r = alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "nope"},
            format="json",
        )
        assert r.status_code == 400

    @pytest.mark.parametrize("body", [["signal_only"], "signal_only", 42])
    def test_apply_preset_rejects_non_object_body(
        self, alice_client: APIClient, body: object
    ) -> None:
        """A non-object JSON body (list/str/scalar) has no ``.get`` — the view must
        treat it as a missing preset and return 400, not raise AttributeError → 500
        (#2126 class 2)."""
        r = alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            body,
            format="json",
        )
        assert r.status_code == 400

    def test_apply_preset_unauthenticated_blocked(self) -> None:
        r = APIClient().post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "signal_only"},
            format="json",
        )
        assert r.status_code in (401, 403)

    def test_apply_preset_is_atomic_bulk_update(
        self, alice_client: APIClient, alice: object
    ) -> None:
        """apply_preset wraps get_or_create + read + bulk_update in transaction.atomic()
        (perf-check finding #1316). Verify all rows are in their final state after the
        call (no partial writes observable between the steps)."""

        # Ensure rows exist before the call.
        alice_client.get("/api/v1/me/notification-preferences/")
        rows_before = NotificationPreference.objects.filter(user=alice).count()
        assert rows_before > 0

        # Apply signal_only — all rows should be in the expected final state.
        r = alice_client.post(
            "/api/v1/me/notification-preferences/apply-preset/",
            {"preset": "signal_only"},
            format="json",
        )
        assert r.status_code == 200

        # Database must reflect the preset consistently (no half-written rows).
        from trueppm_api.apps.notifications.models import SIGNAL_ONLY_EVENTS

        for pref in NotificationPreference.objects.filter(user=alice):
            expected = (
                pref.channel == NotificationChannel.IN_APP and pref.event_type in SIGNAL_ONLY_EVENTS
            )
            assert pref.enabled is expected, (
                f"Row {pref.event_type}/{pref.channel} has unexpected enabled={pref.enabled}"
            )
