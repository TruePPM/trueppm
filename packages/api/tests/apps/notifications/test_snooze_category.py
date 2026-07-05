"""Tests for notification snooze + derived category filters (ADR-0213, #1558)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.categories import (
    CATEGORIES,
    CATEGORY_MENTIONS,
    CATEGORY_PROJECT,
    CATEGORY_SIGNALS,
    CATEGORY_TASKS,
    category_for,
    event_types_for_category,
)
from trueppm_api.apps.notifications.models import (
    Mention,
    Notification,
    NotificationEventType,
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
def memberships(project: Project, alice: object, bob: object) -> None:
    ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER)


@pytest.fixture
def alice_client(alice: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=alice)
    return c


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def comment(task: Task, bob: object) -> TaskComment:
    return TaskComment.objects.create(task=task, author=bob, body="hello")


def _mention_notification(
    alice: object, bob: object, comment: TaskComment, project: Project
) -> Notification:
    m = Mention.objects.create(
        mentioner=bob, mentioned_user=alice, task_comment=comment, project=project
    )
    return Notification.objects.create(recipient=alice, mention=m, project=project)


def _event_notification(
    alice: object, project: Project, event_type: str, task: Task | None = None
) -> Notification:
    return Notification.objects.create(
        recipient=alice,
        event_type=event_type,
        subject=f"{event_type} subject",
        body="body",
        project=project,
        task=task,
    )


# ---------------------------------------------------------------------------
# Category mapping — pure functions
# ---------------------------------------------------------------------------


class TestCategoryMapping:
    def test_every_event_type_maps_to_a_known_category(self) -> None:
        """Exhaustiveness guard (ADR-0213 consequences): a newly added event type
        that isn't classified would silently fall back to `mentions` — this test
        forces an explicit mapping decision for every enum member instead."""
        from trueppm_api.apps.notifications import categories as cat_module

        for event_type in NotificationEventType.values:
            assert event_type in cat_module._EVENT_TYPE_CATEGORY, (
                f"{event_type} has no explicit category mapping"
            )
            assert cat_module._EVENT_TYPE_CATEGORY[event_type] in CATEGORIES

    def test_category_for_string_event_types(self) -> None:
        assert category_for(NotificationEventType.MENTION_INDIVIDUAL.value) == CATEGORY_MENTIONS
        assert category_for(NotificationEventType.TASK_ASSIGNED.value) == CATEGORY_TASKS
        assert category_for(NotificationEventType.TASK_STALE.value) == CATEGORY_TASKS
        assert category_for(NotificationEventType.SPRINT_TASK_RESCHEDULED.value) == CATEGORY_TASKS
        assert (
            category_for(NotificationEventType.MILESTONE_FORECAST_SHIFTED.value) == CATEGORY_SIGNALS
        )
        assert (
            category_for(NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED.value)
            == CATEGORY_SIGNALS
        )
        assert category_for(NotificationEventType.PROJECT_DELETED.value) == CATEGORY_PROJECT

    @pytest.mark.django_db
    def test_category_for_mention_row(
        self, alice: object, bob: object, comment: TaskComment, project: Project
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        # Mention-sourced row: blank event_type + mention FK → mentions.
        assert notif.event_type == ""
        assert category_for(notif) == CATEGORY_MENTIONS

    def test_event_types_for_category_round_trips(self) -> None:
        for category in CATEGORIES:
            for event_type in event_types_for_category(category):
                assert category_for(event_type) == category

    def test_event_types_for_unknown_category_is_empty(self) -> None:
        assert event_types_for_category("bogus") == frozenset()


# ---------------------------------------------------------------------------
# Snooze — query-time exclusion + reappearance
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSnooze:
    def test_snoozed_row_excluded_until_time_passes_then_reappears(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)

        # Snooze it 1 hour out.
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "1h"}, format="json"
        )
        assert r.status_code == 200, r.data
        assert r.data["snoozed_until"] is not None

        # Hidden from the default (all) and unread views while snoozed.
        assert len(alice_client.get("/api/v1/me/notifications/").data["results"]) == 0
        assert (
            len(alice_client.get("/api/v1/me/notifications/?unread_only=true").data["results"]) == 0
        )

        # Surfaced by ?snoozed=true.
        snoozed = alice_client.get("/api/v1/me/notifications/?snoozed=true").data["results"]
        assert len(snoozed) == 1
        assert snoozed[0]["id"] == str(notif.pk)

        # Move snoozed_until into the past → reappears (still unread).
        notif.refresh_from_db()
        notif.snoozed_until = timezone.now() - timedelta(minutes=1)
        notif.save(update_fields=["snoozed_until"])
        assert len(alice_client.get("/api/v1/me/notifications/").data["results"]) == 1
        assert (
            len(alice_client.get("/api/v1/me/notifications/?unread_only=true").data["results"]) == 1
        )
        # And no longer in the snoozed view.
        assert len(alice_client.get("/api/v1/me/notifications/?snoozed=true").data["results"]) == 0

    def test_unread_count_excludes_snoozed(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        """The bell badge (unread_only&limit=0) must not count a snoozed row."""
        keep = _mention_notification(alice, bob, comment, project)
        snoozed = _mention_notification(alice, bob, comment, project)

        # Baseline: both count.
        r = alice_client.get("/api/v1/me/notifications/?unread_only=true&limit=0")
        assert r.data["count"] == 2

        alice_client.post(
            f"/api/v1/me/notifications/{snoozed.pk}/snooze/", {"preset": "3h"}, format="json"
        )
        r = alice_client.get("/api/v1/me/notifications/?unread_only=true&limit=0")
        assert r.data["count"] == 1
        # The surviving unread row is the un-snoozed one.
        rows = alice_client.get("/api/v1/me/notifications/?unread_only=true").data["results"]
        assert {row["id"] for row in rows} == {str(keep.pk)}

    def test_snooze_preset_sets_expected_time(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        before = timezone.now()
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "1h"}, format="json"
        )
        assert r.status_code == 200
        notif.refresh_from_db()
        assert notif.snoozed_until is not None
        # ~1 hour out (allow a minute of test-execution slack).
        expected = before + timedelta(hours=1)
        assert abs((notif.snoozed_until - expected).total_seconds()) < 60

    def test_snooze_tomorrow_preset_is_future_morning(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "tomorrow"}, format="json"
        )
        assert r.status_code == 200
        notif.refresh_from_db()
        assert notif.snoozed_until is not None
        assert notif.snoozed_until > timezone.now()

    def test_snooze_with_explicit_until(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        until = (timezone.now() + timedelta(hours=5)).isoformat()
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"until": until}, format="json"
        )
        assert r.status_code == 200
        notif.refresh_from_db()
        assert notif.snoozed_until is not None

    def test_un_snooze_with_null_until(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "1h"}, format="json"
        )
        # A snoozed row is hidden from the default list...
        assert len(alice_client.get("/api/v1/me/notifications/").data["results"]) == 0
        # ...but the snooze action can still reach it to un-snooze (null clears it).
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"until": None}, format="json"
        )
        assert r.status_code == 200
        assert r.data["snoozed_until"] is None
        assert len(alice_client.get("/api/v1/me/notifications/").data["results"]) == 1

    def test_snooze_rejects_unknown_preset(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        r = alice_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "10y"}, format="json"
        )
        assert r.status_code == 400

    def test_snooze_rejects_empty_body(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        r = alice_client.post(f"/api/v1/me/notifications/{notif.pk}/snooze/", {}, format="json")
        assert r.status_code == 400

    def test_cannot_snooze_another_users_notification(
        self,
        bob: object,
        alice: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        bob_client = APIClient()
        bob_client.force_authenticate(user=bob)
        r = bob_client.post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "1h"}, format="json"
        )
        assert r.status_code == 404

    def test_snooze_requires_authentication(
        self,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        notif = _mention_notification(alice, bob, comment, project)
        r = APIClient().post(
            f"/api/v1/me/notifications/{notif.pk}/snooze/", {"preset": "1h"}, format="json"
        )
        assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Category filter on the list endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCategoryFilter:
    def test_category_tasks_returns_only_task_rows(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
        task: Task,
    ) -> None:
        mention = _mention_notification(alice, bob, comment, project)
        task_row = _event_notification(
            alice, project, NotificationEventType.TASK_ASSIGNED.value, task
        )
        _event_notification(alice, project, NotificationEventType.PROJECT_DELETED.value)

        r = alice_client.get("/api/v1/me/notifications/?category=tasks")
        assert r.status_code == 200
        ids = {row["id"] for row in r.data["results"]}
        assert ids == {str(task_row.pk)}
        assert str(mention.pk) not in ids
        # Every returned row is tagged tasks by the serializer.
        assert all(row["category"] == "tasks" for row in r.data["results"])

    def test_category_mentions_includes_mention_sourced_rows(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
        task: Task,
    ) -> None:
        mention = _mention_notification(alice, bob, comment, project)
        _event_notification(alice, project, NotificationEventType.TASK_ASSIGNED.value, task)

        r = alice_client.get("/api/v1/me/notifications/?category=mentions")
        ids = {row["id"] for row in r.data["results"]}
        assert ids == {str(mention.pk)}
        assert all(row["category"] == "mentions" for row in r.data["results"])

    def test_category_signals_and_project(
        self,
        alice_client: APIClient,
        alice: object,
        project: Project,
    ) -> None:
        signal_row = _event_notification(
            alice, project, NotificationEventType.MILESTONE_FORECAST_SHIFTED.value
        )
        project_row = _event_notification(
            alice, project, NotificationEventType.PROJECT_DELETED.value
        )

        signals = alice_client.get("/api/v1/me/notifications/?category=signals").data["results"]
        assert {row["id"] for row in signals} == {str(signal_row.pk)}

        projects = alice_client.get("/api/v1/me/notifications/?category=project").data["results"]
        assert {row["id"] for row in projects} == {str(project_row.pk)}

    def test_serializer_exposes_snoozed_until_and_category(
        self,
        alice_client: APIClient,
        alice: object,
        bob: object,
        comment: TaskComment,
        project: Project,
    ) -> None:
        _mention_notification(alice, bob, comment, project)
        row = alice_client.get("/api/v1/me/notifications/").data["results"][0]
        assert "snoozed_until" in row
        assert row["snoozed_until"] is None
        assert row["category"] == "mentions"
