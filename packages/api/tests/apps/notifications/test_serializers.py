"""Tests for notifications serializers (snippet/task_id derivation)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.notifications.models import Mention, Notification
from trueppm_api.apps.notifications.serializers import (
    MentionAuthorSerializer,
    NotificationSerializer,
)
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskComment

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def author(db: object) -> object:
    return User.objects.create_user(username="author", first_name="Authoria", password="pw")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="T", duration=1)


@pytest.fixture
def comment(task: Task, author: object) -> TaskComment:
    return TaskComment.objects.create(task=task, author=author, body="Hello, world!" * 50)


@pytest.fixture
def mention(comment: TaskComment, author: object, alice: object, project: Project) -> Mention:
    return Mention.objects.create(
        mentioner=author,
        mentioned_user=alice,
        task_comment=comment,
        project=project,
    )


# ---------------------------------------------------------------------------
# MentionAuthorSerializer.get_display_name
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMentionAuthorSerializer:
    def test_uses_full_name_when_present(self, author: object) -> None:
        data = MentionAuthorSerializer(author).data
        assert data["display_name"] == "Authoria"

    def test_falls_back_to_username(self, alice: object) -> None:
        data = MentionAuthorSerializer(alice).data
        assert data["display_name"] == "alice"


# ---------------------------------------------------------------------------
# NotificationSerializer.get_snippet / get_task_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationSerializerSnippet:
    def test_snippet_truncated_to_200_chars(
        self, mention: Mention, alice: object, project: Project
    ) -> None:
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n).data
        assert len(data["snippet"]) <= 200
        assert data["snippet"].startswith("Hello, world!")

    def test_snippet_empty_when_comment_soft_deleted(
        self,
        mention: Mention,
        comment: TaskComment,
        alice: object,
        author: object,
        project: Project,
    ) -> None:
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        comment.soft_delete(actor=author)
        n.refresh_from_db()
        data = NotificationSerializer(n).data
        assert data["snippet"] == ""

    def test_snippet_empty_when_mention_missing(self, alice: object, project: Project) -> None:
        n = Notification.objects.create(recipient=alice, mention=None, project=project)
        data = NotificationSerializer(n).data
        assert data["snippet"] == ""
        assert data["task_id"] is None

    def test_task_id_returned_when_comment_present(
        self,
        mention: Mention,
        task: Task,
        alice: object,
        project: Project,
    ) -> None:
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n).data
        assert data["task_id"] == str(task.pk)
