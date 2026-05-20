"""Tests for notifications models — Mention, Notification, NotificationPreference."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.db import IntegrityError

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    DEFAULT_PREFERENCES,
    Mention,
    MentionScope,
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
def author(db: object) -> object:
    return User.objects.create_user(username="author", password="pw")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def memberships(
    project: Project, author: object, alice: object, bob: object
) -> dict[str, ProjectMembership]:
    return {
        "author": ProjectMembership.objects.create(project=project, user=author, role=Role.MEMBER),
        "alice": ProjectMembership.objects.create(project=project, user=alice, role=Role.MEMBER),
        "bob": ProjectMembership.objects.create(project=project, user=bob, role=Role.MEMBER),
    }


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


@pytest.fixture
def comment(task: Task, author: object) -> TaskComment:
    return TaskComment.objects.create(task=task, author=author, body="Hello there")


# ---------------------------------------------------------------------------
# Mention model + constraints
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMentionModel:
    def test_create_with_mentioned_user(
        self, comment: TaskComment, author: object, alice: object, project: Project
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
        )
        assert m.scope == MentionScope.PROJECT_VISIBLE
        assert "alice" not in str(m)  # __str__ uses ids/keys, not usernames
        assert str(m).startswith("Mention(")

    def test_create_with_group_key(
        self, comment: TaskComment, author: object, project: Project
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_group_key="scrum-team",
            task_comment=comment,
            project=project,
        )
        assert m.mentioned_user_id is None
        assert "@scrum-team" in str(m)

    def test_target_required_constraint(
        self, comment: TaskComment, author: object, project: Project
    ) -> None:
        """Either mentioned_user or mentioned_group_key must be set."""
        with pytest.raises(IntegrityError):
            Mention.objects.create(
                mentioner=author,
                task_comment=comment,
                project=project,
            )

    def test_source_required_constraint(
        self, author: object, alice: object, project: Project
    ) -> None:
        """task_comment must be set in 0.2 (#476 will widen)."""
        with pytest.raises(IntegrityError):
            Mention.objects.create(
                mentioner=author,
                mentioned_user=alice,
                project=project,
            )


# ---------------------------------------------------------------------------
# MentionManager.visible_to
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMentionManagerVisibleTo:
    def test_anonymous_user_sees_none(self, comment: TaskComment) -> None:
        qs = Mention.objects.visible_to(AnonymousUser())
        assert list(qs) == []

    def test_none_user_sees_none(self) -> None:
        qs = Mention.objects.visible_to(None)
        assert list(qs) == []

    def test_member_sees_project_visible_mentions(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        bob: object,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
            scope=MentionScope.PROJECT_VISIBLE,
        )
        assert m in Mention.objects.visible_to(bob)

    def test_non_member_sees_nothing(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        outsider = User.objects.create_user(username="outsider", password="pw")
        Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
        )
        assert list(Mention.objects.visible_to(outsider)) == []

    def test_team_only_scope_restricted_to_mentioner_and_mentioned(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        bob: object,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
            scope=MentionScope.TEAM_ONLY,
        )
        assert m in Mention.objects.visible_to(author)
        assert m in Mention.objects.visible_to(alice)
        assert m not in Mention.objects.visible_to(bob)

    def test_private_scope_restricted_to_two_parties(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        bob: object,
        project: Project,
        memberships: dict[str, ProjectMembership],
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
            scope=MentionScope.PRIVATE,
        )
        assert m in Mention.objects.visible_to(author)
        assert m in Mention.objects.visible_to(alice)
        assert m not in Mention.objects.visible_to(bob)

    def test_project_id_filter(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        project: Project,
        memberships: dict[str, ProjectMembership],
        calendar: Calendar,
    ) -> None:
        other = Project.objects.create(name="Other", start_date=date(2026, 1, 1), calendar=calendar)
        ProjectMembership.objects.create(project=other, user=alice, role=Role.MEMBER)
        Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
        )
        # Filter to other project — should be empty.
        qs = Mention.objects.visible_to(alice, project_id=other.pk)
        assert list(qs) == []
        # Filter to actual project — should include the mention.
        qs2 = Mention.objects.visible_to(alice, project_id=project.pk)
        assert qs2.count() == 1


# ---------------------------------------------------------------------------
# Notification model
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationModel:
    def test_str(
        self,
        comment: TaskComment,
        author: object,
        alice: object,
        project: Project,
    ) -> None:
        m = Mention.objects.create(
            mentioner=author,
            mentioned_user=alice,
            task_comment=comment,
            project=project,
        )
        n = Notification.objects.create(recipient=alice, mention=m, project=project)
        s = str(n)
        assert "Notification(" in s
        assert str(alice.pk) in s  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# NotificationPreference + defaults
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationPreference:
    def test_unique_constraint_per_user_event_channel(self, alice: object) -> None:
        NotificationPreference.objects.create(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.IN_APP,
            enabled=True,
        )
        with pytest.raises(IntegrityError):
            NotificationPreference.objects.create(
                user=alice,
                event_type=NotificationEventType.MENTION_INDIVIDUAL,
                channel=NotificationChannel.IN_APP,
                enabled=False,
            )

    def test_str_reflects_enabled_state(self, alice: object) -> None:
        on = NotificationPreference(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.IN_APP,
            enabled=True,
        )
        off = NotificationPreference(
            user=alice,
            event_type=NotificationEventType.MENTION_INDIVIDUAL,
            channel=NotificationChannel.EMAIL,
            enabled=False,
        )
        assert "on" in str(on)
        assert "off" in str(off)

    def test_default_preferences_table_matches_voc_intent(self) -> None:
        """DEFAULT_PREFERENCES must have email OFF (Priya's VoC flip)."""
        as_dict = {(et, ch): enabled for et, ch, enabled in DEFAULT_PREFERENCES}
        individual = NotificationEventType.MENTION_INDIVIDUAL
        group = NotificationEventType.MENTION_GROUP
        email = NotificationChannel.EMAIL
        in_app = NotificationChannel.IN_APP
        assert as_dict[(individual, email)] is False
        assert as_dict[(group, email)] is False
        assert as_dict[(individual, in_app)] is True
        assert as_dict[(group, in_app)] is True
