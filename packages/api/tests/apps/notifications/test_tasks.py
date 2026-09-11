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
# Queued mail for a deactivated recipient (#3523)
# ---------------------------------------------------------------------------


class TestDeactivatedRecipientRetirement:
    """Rows queued *before* off-boarding must not drain — and must not park.

    This drain is the single egress for every notification email in OSS (mention,
    stale-task, event and digest rails all funnel through it), so the account axis is
    closed here once rather than at each producer.
    """

    @pytest.mark.django_db
    def test_pending_row_for_a_deactivated_recipient_is_never_sent(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        User.objects.filter(pk=recipient.pk).update(is_active=False)

        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_sent_at is None

    @pytest.mark.django_db
    def test_the_row_is_retired_rather_than_left_pending(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        """Excluding it from the query alone would age it into ``queued_aging``.

        ``observability.selectors.notification_email_signals`` reads
        ``email_pending=True`` past an hour as "Beat is dead, the worker is gone, or
        the transport cannot be built" — a permanent System Health false alarm. The
        row has to reach a terminal state, not sit in the backlog.

        The transport is mocked as **down** on purpose. With a succeeding send the
        unfixed drain also lands on ``email_pending=False`` — by delivering the mail —
        so the assertion would hold on the broken build and prove nothing. Failing the
        send separates "retired without sending" from "sent".
        """
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        User.objects.filter(pk=recipient.pk).update(is_active=False)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")) as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_pending is False
        assert notif.email_sent_at is None

    @pytest.mark.django_db
    def test_retirement_is_not_recorded_as_a_delivery_failure(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        """``failed_recent`` must not count an off-boarding as a broken mail relay.

        That signal is ``email_pending=False`` AND ``email_attempts >=
        EMAIL_MAX_RETRIES`` AND a recent ``email_failed_at``. Retirement writes only
        the first, so stamping either of the others would report a personnel change
        as an outage.

        Seeded one attempt below the ceiling and run against a **dead** transport, so
        that on the unfixed drain this row burns its last retry and lands on exactly
        the ``failed_recent`` state being asserted against. With a succeeding send the
        assertions would hold on the broken build too and prove nothing.
        """
        notif = _make_pending_notification(
            recipient=recipient,
            project=project,
            comment=comment,
            author=author,
            attempts=EMAIL_MAX_RETRIES - 1,
        )
        User.objects.filter(pk=recipient.pk).update(is_active=False)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()

        notif.refresh_from_db()
        assert notif.email_pending is False  # retired
        assert notif.email_attempts == EMAIL_MAX_RETRIES - 1  # no retry burned
        assert notif.email_failed_at is None  # not a delivery failure

    @pytest.mark.django_db
    def test_the_inbox_row_itself_survives(
        self, recipient: object, project: Project, comment: TaskComment, author: object
    ) -> None:
        """Only the outbound channel is closed. The durable record is not deleted —
        it is unreadable anyway, because ``is_active=False`` closes every credential
        path (JWT, session, PAT) that could open the inbox.

        Stated for the record: this one **passes on the unfixed build too**, and is
        meant to. It is not a repro — it is the ceiling on the fix, pinning that a
        later "purge the deactivated user's notifications" reading of #3523 would be
        a behavior change, not a tightening of this one.
        """
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        User.objects.filter(pk=recipient.pk).update(is_active=False)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()

        assert Notification.objects.filter(pk=notif.pk).exists()

    @pytest.mark.django_db
    def test_an_active_recipients_queued_mail_still_drains(
        self,
        recipient: object,
        project: Project,
        comment: TaskComment,
        author: object,
    ) -> None:
        """The retirement pass must claim only the deactivated recipient's rows."""
        offboarded = User.objects.create_user(username="gone", password="pw", email="gone@x.io")
        ProjectMembership.objects.create(project=project, user=offboarded, role=Role.MEMBER)
        dead = _make_pending_notification(
            recipient=offboarded, project=project, comment=comment, author=author
        )
        live = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        offboarded.is_active = False
        offboarded.save(update_fields=["is_active"])

        with patch("django.core.mail.EmailMessage.send", return_value=1) as send:
            _do_drain_emails()

        assert send.call_count == 1
        live.refresh_from_db()
        dead.refresh_from_db()
        assert live.email_sent_at is not None
        assert dead.email_sent_at is None
        assert dead.email_pending is False


# ---------------------------------------------------------------------------
# Queued mail for a recipient revoked from the notification's project (#3675)
# ---------------------------------------------------------------------------


class TestRevokedMembershipRetirement:
    """A member removed *during* the retry window must not still get mailed.

    ``_render_email``/``_send_email_for_notification`` read ``subject``/``body``
    straight off the frozen row and never consult ``_recipient_can_see_project``
    (#3510) — that fix only reaches the REST read path. This drain is the
    unguarded egress #3675 tracks.
    """

    @pytest.mark.django_db
    def test_pending_row_for_a_revoked_recipient_is_never_sent(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        ProjectMembership.objects.filter(project=project, user=recipient).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_sent_at is None

    @pytest.mark.django_db
    def test_the_row_is_retired_rather_than_left_pending(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        """Excluding it from the query alone would age it into ``queued_aging``
        (see ``TestDeactivatedRecipientRetirement`` — same reasoning, membership
        axis). The transport is mocked as down so a broken build that skips the
        membership check but happens to fail SMTP for another reason doesn't
        pass this by accident; only a fix that actively retires the row lands on
        ``email_pending=False`` with no send attempted.
        """
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        ProjectMembership.objects.filter(project=project, user=recipient).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")) as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_pending is False
        assert notif.email_sent_at is None

    @pytest.mark.django_db
    def test_retirement_is_not_recorded_as_a_delivery_failure(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        """``failed_recent`` must not count a privacy suppression as a broken relay.

        Seeded one attempt below the ceiling and run against a dead transport, so
        on the unfixed drain this row burns its last retry and lands on exactly
        the ``failed_recent`` state being asserted against.
        """
        notif = _make_pending_notification(
            recipient=recipient,
            project=project,
            comment=comment,
            author=author,
            attempts=EMAIL_MAX_RETRIES - 1,
        )
        ProjectMembership.objects.filter(project=project, user=recipient).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()

        notif.refresh_from_db()
        assert notif.email_pending is False  # retired
        assert notif.email_attempts == EMAIL_MAX_RETRIES - 1  # no retry burned
        assert notif.email_failed_at is None  # not a delivery failure

    @pytest.mark.django_db
    def test_the_inbox_row_itself_survives(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        """Only the outbound email channel is closed; the durable in-app record
        (already redacted on read by #3510) is not deleted."""
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        ProjectMembership.objects.filter(project=project, user=recipient).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()

        assert Notification.objects.filter(pk=notif.pk).exists()

    @pytest.mark.django_db
    def test_a_current_members_queued_mail_still_drains(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        """Guard against over-blocking: the retirement pass must claim only the
        revoked recipient's rows, not every pending row in the project."""
        removed = User.objects.create_user(username="gone", password="pw", email="gone@x.io")
        ProjectMembership.objects.create(project=project, user=removed, role=Role.MEMBER)
        revoked = _make_pending_notification(
            recipient=removed, project=project, comment=comment, author=author
        )
        current = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        ProjectMembership.objects.filter(project=project, user=removed).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send", return_value=1) as send:
            _do_drain_emails()

        assert send.call_count == 1
        current.refresh_from_db()
        revoked.refresh_from_db()
        assert current.email_sent_at is not None
        assert revoked.email_sent_at is None
        assert revoked.email_pending is False

    @pytest.mark.django_db
    def test_project_scoped_but_never_a_member_row_is_suppressed(
        self,
        project: Project,
        comment: TaskComment,
        author: object,
    ) -> None:
        """No ``ProjectMembership`` row at all (never a member) must behave the
        same as a soft-deleted one — the predicate is "current member", not
        "not explicitly revoked"."""
        outsider = User.objects.create_user(username="outsider", password="pw", email="o@x.io")
        notif = _make_pending_notification(
            recipient=outsider, project=project, comment=comment, author=author
        )

        with patch("django.core.mail.EmailMessage.send") as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_pending is False
        assert notif.email_failed_at is None

    @pytest.mark.django_db
    def test_account_scoped_row_with_no_project_still_drains(
        self,
        recipient: object,
        author: object,
    ) -> None:
        """A row with no owning project (ADR-0663 account-scoped digest shape)
        has no membership boundary to check and must not be swept up."""
        notif = Notification.objects.create(
            recipient=recipient,
            project=None,
            event_type="digest.weekly",
            subject="Your weekly digest",
            body="Nothing to report.",
            email_pending=True,
        )
        Notification.objects.filter(pk=notif.pk).update(
            created_at=timezone.now() - timedelta(minutes=10)
        )

        with patch("django.core.mail.EmailMessage.send", return_value=1) as send:
            _do_drain_emails()

        assert send.call_count == 1
        notif.refresh_from_db()
        assert notif.email_sent_at is not None

    @pytest.mark.django_db
    def test_smtp_failure_then_revocation_then_retry_is_suppressed(
        self,
        recipient: object,
        project: Project,
        project_members: dict[str, ProjectMembership],
        comment: TaskComment,
        author: object,
    ) -> None:
        """The exact retry-window shape from #3675: a transient SMTP failure widens
        the window during which a mid-flight revocation can land, and the retry
        must re-check membership rather than mail on the original, stale grant."""
        notif = _make_pending_notification(
            recipient=recipient, project=project, comment=comment, author=author
        )
        with patch("django.core.mail.EmailMessage.send", side_effect=OSError("smtp down")):
            _do_drain_emails()
        notif.refresh_from_db()
        assert notif.email_attempts == 1
        assert notif.email_pending is True  # still eligible for retry

        ProjectMembership.objects.filter(project=project, user=recipient).update(is_deleted=True)

        with patch("django.core.mail.EmailMessage.send", return_value=1) as send:
            _do_drain_emails()

        assert send.call_count == 0
        notif.refresh_from_db()
        assert notif.email_pending is False  # suppressed, not retried
        assert notif.email_sent_at is None
        assert notif.email_attempts == 1  # no additional retry burned


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
    """RFC 2369 List-Unsubscribe header construction."""

    def test_returns_headers_when_frontend_base_url_configured(self, settings: object) -> None:
        settings.FRONTEND_BASE_URL = "https://ppm.example.com"
        assert _unsubscribe_headers() == {
            "List-Unsubscribe": "<https://ppm.example.com/me/settings/notifications>",
        }

    def test_never_advertises_rfc8058_one_click(self, settings: object) -> None:
        """``List-Unsubscribe-Post`` promises an unauthenticated POST handler (#2887).

        There is none — the URL is a login-gated SPA route with no unauthenticated
        POST anywhere in ``notifications/urls.py``. Gmail's and Yahoo's bulk-sender
        checks *exercise* the POST, so advertising it without a conforming endpoint
        hurts deliverability rather than helping it. This assertion is the guard
        against re-adding the header before the signed token and endpoint exist.
        """
        settings.FRONTEND_BASE_URL = "https://ppm.example.com"
        assert "List-Unsubscribe-Post" not in _unsubscribe_headers()

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
        assert "List-Unsubscribe-Post" not in sent.extra_headers

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
