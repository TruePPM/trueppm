"""Tests for the notifications Beat tasks — drain + archive (ADR-0075 §F)."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import Mention, Notification
from trueppm_api.apps.notifications.tasks import (
    ARCHIVE_AFTER_DAYS,
    EMAIL_MAX_RETRIES,
    EMAIL_ORPHAN_WINDOW_MINUTES,
    _do_archive,
    _do_drain_emails,
    _render_email,
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
    return User.objects.create_user(username="author", password="pw", email="author@example.com")


@pytest.fixture
def recipient(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw", email="alice@example.com")


@pytest.fixture
def project_members(
    project: Project, author: object, recipient: object
) -> dict[str, ProjectMembership]:
    return {
        "author": ProjectMembership.objects.create(project=project, user=author, role=Role.ADMIN),
        "alice": ProjectMembership.objects.create(
            project=project, user=recipient, role=Role.MEMBER
        ),
    }


@pytest.fixture
def comment(
    project: Project, project_members: dict[str, ProjectMembership], author: object
) -> TaskComment:
    task = Task.objects.create(project=project, name="Foundation work", duration=1)
    return TaskComment.objects.create(task=task, author=author, body="Hello @alice please review")


def _make_pending_notification(
    *,
    recipient: object,
    project: Project,
    comment: TaskComment,
    author: object,
    aged_minutes: int = 10,
    attempts: int = 0,
    sent: bool = False,
) -> Notification:
    """Build a Notification with backdated created_at so orphan-window filter passes."""
    mention = Mention.objects.create(
        mentioner=author,
        mentioned_user=recipient,
        task_comment=comment,
        project=project,
    )
    notif = Notification.objects.create(
        recipient=recipient,
        mention=mention,
        project=project,
        email_pending=True,
        email_attempts=attempts,
        email_sent_at=timezone.now() if sent else None,
    )
    # Backdate created_at so the orphan-window filter (5 min) is past.
    Notification.objects.filter(pk=notif.pk).update(
        created_at=timezone.now() - timedelta(minutes=aged_minutes)
    )
    notif.refresh_from_db()
    return notif


# ---------------------------------------------------------------------------
# _do_drain_emails — success + retry + cap + orphan-window
# ---------------------------------------------------------------------------


class TestDoDrainEmails:
    """drain_notification_emails business logic."""

    @pytest.mark.django_db
    def test_sends_pending_email_and_marks_sent(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        with patch("django.core.mail.EmailMessage.send", return_value=1):
            _do_drain_emails()
        notif.refresh_from_db()
        assert notif.email_pending is False
        assert notif.email_sent_at is not None
        assert notif.email_failed_at is None
        assert notif.email_attempts == 0

    @pytest.mark.django_db
    def test_skips_notification_inside_orphan_window(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        # created_at is < 5 min ago → drain MUST skip (avoids racing in-flight txn).
        _make_pending_notification(
            recipient=recipient,
            project=project,
            comment=comment,
            author=author,
            aged_minutes=EMAIL_ORPHAN_WINDOW_MINUTES - 1,
        )
        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()
        assert send.call_count == 0

    @pytest.mark.django_db
    def test_smtp_failure_increments_attempts_and_keeps_pending(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()
        notif.refresh_from_db()
        # First failure: attempts=1, still pending so the next tick retries.
        assert notif.email_attempts == 1
        assert notif.email_pending is True
        assert notif.email_failed_at is not None
        assert notif.email_sent_at is None

    @pytest.mark.django_db
    def test_max_retries_exhausted_clears_pending(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        # Seed with attempts already at max-1 so this tick pushes to max.
        notif = _make_pending_notification(
            recipient=recipient,
            project=project,
            comment=comment,
            author=author,
            attempts=EMAIL_MAX_RETRIES - 1,
        )
        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()
        notif.refresh_from_db()
        assert notif.email_attempts == EMAIL_MAX_RETRIES
        assert notif.email_pending is False  # given up — no further retries
        assert notif.email_sent_at is None
        assert notif.email_failed_at is not None

    @pytest.mark.django_db
    def test_recipient_without_email_skips_send(
        self, project: Project, comment: TaskComment, author: object
    ) -> None:
        no_email_user = User.objects.create_user(username="silent", password="pw", email="")
        ProjectMembership.objects.create(project=project, user=no_email_user, role=Role.MEMBER)
        notif = _make_pending_notification(
            recipient=no_email_user, project=project, comment=comment, author=author
        )
        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()
        assert send.call_count == 0
        notif.refresh_from_db()
        # No-email path counts as a soft failure — attempts increments.
        assert notif.email_attempts == 1
        assert notif.email_pending is True

    @pytest.mark.django_db
    def test_does_not_pick_up_already_sent(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        _make_pending_notification(
            recipient=recipient,
            project=project,
            comment=comment,
            author=author,
            sent=True,  # email_sent_at populated
        )
        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()
        assert send.call_count == 0


# ---------------------------------------------------------------------------
# _do_archive — 90-day window
# ---------------------------------------------------------------------------


class TestDoArchive:
    """archive_old_notifications business logic."""

    @pytest.mark.django_db
    def test_archives_read_notifications_past_threshold(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        mention = Mention.objects.create(
            mentioner=author, mentioned_user=recipient, task_comment=comment, project=project
        )
        notif = Notification.objects.create(
            recipient=recipient, mention=mention, project=project, is_read=True
        )
        # Backdate to just past the 90-day cutoff
        Notification.objects.filter(pk=notif.pk).update(
            created_at=timezone.now() - timedelta(days=ARCHIVE_AFTER_DAYS + 1)
        )
        _do_archive()
        notif.refresh_from_db()
        assert notif.is_archived is True

    @pytest.mark.django_db
    def test_unread_notifications_are_not_archived(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        mention = Mention.objects.create(
            mentioner=author, mentioned_user=recipient, task_comment=comment, project=project
        )
        notif = Notification.objects.create(
            recipient=recipient, mention=mention, project=project, is_read=False
        )
        Notification.objects.filter(pk=notif.pk).update(
            created_at=timezone.now() - timedelta(days=ARCHIVE_AFTER_DAYS + 30)
        )
        _do_archive()
        notif.refresh_from_db()
        assert notif.is_archived is False  # never auto-archive unread

    @pytest.mark.django_db
    def test_recent_notifications_are_not_archived(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        mention = Mention.objects.create(
            mentioner=author, mentioned_user=recipient, task_comment=comment, project=project
        )
        notif = Notification.objects.create(
            recipient=recipient, mention=mention, project=project, is_read=True
        )
        # 30 days old — well inside the 90-day window
        Notification.objects.filter(pk=notif.pk).update(
            created_at=timezone.now() - timedelta(days=30)
        )
        _do_archive()
        notif.refresh_from_db()
        assert notif.is_archived is False


# ---------------------------------------------------------------------------
# _render_email
# ---------------------------------------------------------------------------


class TestRenderEmail:
    """Email subject/body rendering for queued notifications."""

    @pytest.mark.django_db
    def test_individual_mention_subject_contains_mentioner_and_task_name(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        subject, _body = _render_email(notif)
        assert "author" in subject
        assert "Foundation work" in subject
        assert "mentioned you" in subject

    @pytest.mark.django_db
    def test_group_mention_subject_uses_group_name(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        mention = Mention.objects.create(
            mentioner=author,
            mentioned_user=None,
            mentioned_group_key="scrum-team",
            task_comment=comment,
            project=project,
        )
        notif = Notification.objects.create(
            recipient=recipient, mention=mention, project=project, email_pending=True
        )
        subject, _ = _render_email(notif)
        assert "@scrum-team" in subject

    @pytest.mark.django_db
    def test_body_includes_snippet_and_settings_link(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        _, body = _render_email(notif)
        assert "Hello @alice please review" in body
        assert "/me/settings/notifications/" in body

    @pytest.mark.django_db
    def test_soft_deleted_comment_returns_empty(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        comment.soft_delete(actor=author)
        subject, body = _render_email(notif)
        assert subject == ""
        assert body == ""
