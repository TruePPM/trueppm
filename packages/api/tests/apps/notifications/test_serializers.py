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

    def test_snippet_shown_to_source_project_member(
        self, mention: Mention, alice: object, project: Project
    ) -> None:
        # #514 cross-project gate: a recipient who is a member of the source
        # project still sees the body (context supplies their member set).
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n, context={"member_project_ids": {project.id}}).data
        assert data["snippet"].startswith("Hello, world!")

    def test_snippet_redacted_for_recipient_not_in_source_project(
        self, mention: Mention, alice: object, project: Project
    ) -> None:
        # A @program-* mention can reach a sibling-project member who is NOT a
        # member of the source project — the row surfaces but the body is
        # redacted so one project's comment never leaks to another's team.
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["snippet"] == ""
        # The row itself is still delivered (recipient knows they were pinged).
        assert data["task_id"] is not None

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


# ---------------------------------------------------------------------------
# NotificationSerializer.to_representation — subject/body/project redaction (#3510)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationSerializerRevokedMemberRedaction:
    """A revoked member's notifications must stop naming the project/task.

    Extends the #514 snippet gate to the three other fields that can carry a
    project or task name — subject, body, and the project FK itself — which
    were previously served unredacted regardless of current membership.
    """

    def test_subject_body_project_shown_to_current_member(
        self, alice: object, project: Project, task: Task
    ) -> None:
        n = Notification.objects.create(
            recipient=alice,
            event_type="task.assigned",
            subject=f'Assigned: "{task.name}"',
            body=f'You were assigned "{task.name}" on {project.name}.',
            project=project,
            task=task,
        )
        data = NotificationSerializer(n, context={"member_project_ids": {project.id}}).data
        assert data["subject"] == f'Assigned: "{task.name}"'
        assert data["body"] == f'You were assigned "{task.name}" on {project.name}.'
        assert data["project"] == project.id

    def test_subject_body_project_redacted_for_revoked_member(
        self, alice: object, project: Project, task: Task
    ) -> None:
        # Recipient is no longer a member of the source project — the
        # membership context supplies an empty set, mirroring a revoked row.
        n = Notification.objects.create(
            recipient=alice,
            event_type="task.assigned",
            subject=f'Assigned: "{task.name}"',
            body=f'You were assigned "{task.name}" on {project.name}.',
            project=project,
            task=task,
        )
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["subject"] == ""
        assert data["body"] == ""
        assert data["project"] is None
        # The row itself is still delivered — the recipient still sees they
        # were notified; only the content that names the project/task is gone.
        assert data["id"] == str(n.id)
        assert data["event_type"] == "task.assigned"

    def test_null_project_digest_row_is_never_redacted(self, alice: object) -> None:
        # ADR-0663 account-scoped digest rows have no single owning project —
        # there is no project boundary to check, so they are always visible.
        n = Notification.objects.create(
            recipient=alice,
            event_type="milestone.forecast_shifted",
            subject="Weekly digest",
            body="Some digest content naming several projects.",
            project=None,
        )
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["subject"] == "Weekly digest"
        assert data["body"] == "Some digest content naming several projects."
        assert data["project"] is None
