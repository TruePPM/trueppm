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


@pytest.fixture
def program_group_mention(comment: TaskComment, author: object, project: Project) -> Mention:
    """A ``@program-pms`` auto-group mention — the #514 cross-project population.

    Group mentions carry no ``mentioned_user``; the fan-out
    (``services._add_group_recipients``) attaches this one row to every resolved
    member, including members of *sibling* projects who are not members of the
    source project and were never intentionally denied.
    """
    return Mention.objects.create(
        mentioner=author,
        mentioned_group_key="program-pms",
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
        # The row itself is still delivered (recipient knows they were pinged) —
        # #3674 narrowed what "the row" carries: the identity fields stay, the
        # raw object references do not. This assertion previously read
        # `task_id is not None`; see TestNotificationSerializerObjectReference-
        # Redaction below for why that reversed and what replaced it.
        assert data["id"] == str(n.id)
        assert data["mention"]["mentioner"]["username"] == "author"
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


# ---------------------------------------------------------------------------
# NotificationSerializer — object-reference redaction (#3674)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestNotificationSerializerObjectReferenceRedaction:
    """``task_id`` and ``mention.task_comment`` redact on the same gate as #3510.

    The decision recorded in ``NotificationSerializer.to_representation``: the
    two raw UUIDs are opaque handles into the source project's content graph
    with no value to a reader who cannot spend them, so they go; the mention's
    identity fields (mentioner / mentioned_user / group key / scope / id) are
    not project-content references and carry the "you were pinged" signal #514
    exists to deliver, so they stay. Both populations that fail the gate — a
    revoked member and a never-a-member ``@program-*`` recipient — get the same
    treatment, because they are identical in capability even though they differ
    in intent.
    """

    def test_current_member_sees_both_object_references(
        self, mention: Mention, task: Task, comment: TaskComment, alice: object, project: Project
    ) -> None:
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n, context={"member_project_ids": {project.id}}).data
        assert data["task_id"] == str(task.pk)
        assert data["mention"]["task_comment"] == comment.pk

    def test_revoked_member_loses_both_object_references(
        self, alice: object, project: Project, task: Task
    ) -> None:
        # Population 1: was a member, access removed. An event-sourced row
        # carries the deep link on Notification.task directly.
        n = Notification.objects.create(
            recipient=alice,
            event_type="task.assigned",
            subject=f'Assigned: "{task.name}"',
            body="…",
            project=project,
            task=task,
        )
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["task_id"] is None
        # The row is still delivered and still says what kind of thing happened.
        assert data["id"] == str(n.id)
        assert data["event_type"] == "task.assigned"

    def test_program_group_recipient_keeps_identity_loses_object_references(
        self, program_group_mention: Mention, alice: object, project: Project
    ) -> None:
        # Population 2 (#514): a sibling-project member reached by @program-pms,
        # never a member of the source project and never intentionally denied.
        # The #514 promise — "the row surfaces, they know they were pinged" —
        # must survive intact, so assert the kept fields explicitly rather than
        # only asserting the absences.
        n = Notification.objects.create(
            recipient=alice, mention=program_group_mention, project=project
        )
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data

        # Gone: the two opaque handles into the source project's content graph.
        assert data["task_id"] is None
        assert data["mention"]["task_comment"] is None
        assert data["snippet"] == ""

        # Kept: everything that makes the row legible as "you were pinged".
        assert data["mention"]["id"] == str(program_group_mention.id)
        assert data["mention"]["mentioner"]["username"] == "author"
        assert data["mention"]["mentioner"]["display_name"] == "Authoria"
        assert data["mention"]["mentioned_group_key"] == "program-pms"
        assert data["mention"]["scope"] == "project_visible"
        assert data["category"] == "mentions"

    def test_mentioned_user_on_a_direct_mention_is_the_recipient_themselves(
        self, mention: Mention, alice: object, project: Project
    ) -> None:
        # Why keeping `mentioned_user` discloses nothing: the fan-out keys a
        # direct mention by its own target (services._resolve_mention_recipients),
        # so the only non-null value a recipient can ever read here is their own
        # account. A group mention leaves it null.
        n = Notification.objects.create(recipient=alice, mention=mention, project=project)
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["mention"]["mentioned_user"]["username"] == "alice"

    def test_null_project_digest_row_keeps_its_task_reference(
        self, alice: object, task: Task
    ) -> None:
        # ADR-0663 account-scoped rows have no project boundary to check against,
        # so the gate never fires and the deep link is untouched.
        n = Notification.objects.create(
            recipient=alice,
            event_type="milestone.forecast_shifted",
            subject="Weekly digest",
            body="…",
            project=None,
            task=task,
        )
        data = NotificationSerializer(n, context={"member_project_ids": set()}).data
        assert data["task_id"] == str(task.pk)
