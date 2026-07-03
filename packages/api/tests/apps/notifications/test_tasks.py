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
    SNIPPET_MAX_CHARS,
    SNIPPET_WRAP_WIDTH,
    _do_archive,
    _do_drain_emails,
    _render_email,
    _sanitize_snippet,
    _unsubscribe_headers,
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


# ---------------------------------------------------------------------------
# _sanitize_snippet (#574, security review !306 LOW-1)
# ---------------------------------------------------------------------------


class TestSanitizeSnippet:
    """Bounding/escaping/wrapping of the comment snippet embedded in the email body."""

    def test_empty_input_returns_empty_string(self) -> None:
        assert _sanitize_snippet("") == ""

    def test_short_plain_text_is_returned_unchanged(self) -> None:
        text = "Hello world, this is a short comment."
        assert _sanitize_snippet(text) == text

    def test_long_input_is_truncated_with_ellipsis(self) -> None:
        raw = "a" * (SNIPPET_MAX_CHARS + 50)
        result = _sanitize_snippet(raw)
        flattened = result.replace("\n", "")
        # SNIPPET_MAX_CHARS of 'a' plus the "..." truncation marker, no more.
        assert flattened == "a" * SNIPPET_MAX_CHARS + "..."
        assert flattened.endswith("...")

    def test_long_unbroken_string_is_hard_wrapped(self) -> None:
        """A single unbroken (no-whitespace) run cannot render as one giant line."""
        # Stay under SNIPPET_MAX_CHARS so this exercises wrapping only, not truncation.
        raw = "x" * (SNIPPET_WRAP_WIDTH * 3)
        result = _sanitize_snippet(raw)
        lines = result.split("\n")
        assert len(lines) > 1
        assert all(len(line) <= SNIPPET_WRAP_WIDTH for line in lines)
        # No characters lost in the wrap itself (input is under the truncation cap).
        assert "".join(lines) == raw

    def test_ampersand_and_angle_brackets_are_escaped(self) -> None:
        raw = 'Check <script>alert(1)</script> & don\'t forget "quotes"'
        result = _sanitize_snippet(raw).replace("\n", " ")
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in result
        assert "&amp;" in result
        assert "<script>" not in result
        # quote=False: apostrophes/double-quotes are left as ordinary prose, not entities.
        assert "don't" in result
        assert '"quotes"' in result


# ---------------------------------------------------------------------------
# _unsubscribe_headers (#574, security review !306 LOW-1)
# ---------------------------------------------------------------------------


class TestUnsubscribeHeaders:
    """RFC 8058 List-Unsubscribe / List-Unsubscribe-Post header construction."""

    def test_returns_headers_when_frontend_base_url_configured(self, settings: object) -> None:
        settings.FRONTEND_BASE_URL = "https://ppm.example.com"
        assert _unsubscribe_headers() == {
            "List-Unsubscribe": "<https://ppm.example.com/me/settings/notifications>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }

    def test_strips_trailing_slash_on_base_url(self, settings: object) -> None:
        settings.FRONTEND_BASE_URL = "https://ppm.example.com/"
        headers = _unsubscribe_headers()
        assert headers["List-Unsubscribe"] == "<https://ppm.example.com/me/settings/notifications>"

    def test_omits_headers_when_frontend_base_url_unset(self, settings: object) -> None:
        settings.FRONTEND_BASE_URL = ""
        assert _unsubscribe_headers() == {}


# ---------------------------------------------------------------------------
# Sent email carries the unsubscribe headers end-to-end
# ---------------------------------------------------------------------------


class TestSentEmailHeaders:
    @pytest.mark.django_db
    def test_drained_email_carries_unsubscribe_headers(
        self,
        settings: object,
        recipient: object,
        project: Project,
        comment: TaskComment,
        author: object,
    ) -> None:
        from django.core import mail

        settings.FRONTEND_BASE_URL = "https://ppm.example.com"
        _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )

        _do_drain_emails()

        assert len(mail.outbox) == 1
        sent = mail.outbox[0]
        assert (
            sent.extra_headers["List-Unsubscribe"]
            == "<https://ppm.example.com/me/settings/notifications>"
        )
        assert sent.extra_headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"

    @pytest.mark.django_db
    def test_drained_email_has_no_unsubscribe_headers_when_unconfigured(
        self,
        settings: object,
        recipient: object,
        project: Project,
        comment: TaskComment,
        author: object,
    ) -> None:
        from django.core import mail

        settings.FRONTEND_BASE_URL = ""
        _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )

        _do_drain_emails()

        assert len(mail.outbox) == 1
        assert mail.outbox[0].extra_headers == {}
