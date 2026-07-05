"""Celery tasks for the notifications app (ADR-0075 §F durable-execution).

Three Beat-scheduled tasks:

- ``drain_notification_emails`` — every 30 s, finds Notification rows with
  ``email_pending=True`` older than the 5-min orphan window, renders an email
  for each, sends via SMTP, and updates delivery state. Best-effort — broker
  outage logs but doesn't propagate.

- ``archive_old_notifications`` — nightly, sets ``is_archived=True`` on any
  Notification older than 90 days that has ``is_read=True``. Keeps the
  index on ``(recipient, is_read, -created_at)`` shallow for the unread
  query path.

- ``detect_stale_tasks`` — nightly (ADR-0200), scans every project for
  non-terminal tasks that have sat in their current status past the project's
  ``stale_task_threshold_days`` (default 7) and nudges the assignee via the
  #639 event-notification rail. Idempotent: dedupes against existing unread
  ``task.stale`` notifications, so a re-run creates zero duplicates.
"""

from __future__ import annotations

import contextlib
import html
import logging
import textwrap
from datetime import timedelta
from typing import TYPE_CHECKING

from trueppm_api.core.idempotent import idempotent_task

if TYPE_CHECKING:
    from django.core.mail.backends.base import BaseEmailBackend

logger = logging.getLogger(__name__)


# Locked constants for email delivery — kept in this module so they're
# adjacent to the drain task that owns them.
EMAIL_MAX_RETRIES = 3
EMAIL_ORPHAN_WINDOW_MINUTES = 5  # ADR-0075 §F durable-execution checklist item 3
EMAIL_BATCH_SIZE = 50  # cap per drain tick — prevents one tick from monopolizing the worker
ARCHIVE_AFTER_DAYS = 90  # ADR-0075 §F item 6 — outbox cleanup

# Snippet rendering (#574, security review !306 LOW-1). SNIPPET_MAX_CHARS bounds
# the raw comment text before it's embedded in the email body; SNIPPET_WRAP_WIDTH
# hard-wraps it so a long unbroken string (a pasted URL, log line, or base64 blob)
# can't render as a single unbounded line in the recipient's mail client.
SNIPPET_MAX_CHARS = 280
SNIPPET_WRAP_WIDTH = 72  # classic plain-text convention; keeps quoted replies readable


@idempotent_task(
    lock_key_template="drain_notification_emails",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="notifications.drain_notification_emails",
)
def drain_notification_emails(self: object) -> None:
    """Send queued email notifications.

    Runs every 30 seconds via Celery Beat. Finds Notification rows where
    ``email_pending=True`` and ``email_sent_at IS NULL`` and ``email_attempts
    < EMAIL_MAX_RETRIES`` and ``created_at < (now - orphan_window)``.

    The orphan-window filter prevents racing the comment-create transaction —
    a Notification inserted inside a still-open atomic block isn't visible
    to this drain until commit AND has aged past the window. The 5-min value
    matches the webhook drain (ADR-0019).

    The singleton lock + ``on_contention="skip"`` ensures at most one drain
    runs at a time; the next Beat tick picks up anything missed.
    """
    _do_drain_emails()


@idempotent_task(
    lock_key_template="archive_old_notifications",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="notifications.archive_old_notifications",
)
def archive_old_notifications(self: object) -> None:
    """Archive read notifications older than 90 days.

    Runs nightly via Celery Beat. Sets ``is_archived=True`` on Notifications
    where ``is_read=True`` and ``created_at < (now - ARCHIVE_AFTER_DAYS)``.

    Archive is a soft state — rows stay in the table, are excluded from
    default list queries, and remain reachable via the explicit ``archived``
    filter. A future hard-purge for archived rows older than 365 days is
    operational concern (not in 0.2).
    """
    _do_archive()


@idempotent_task(
    lock_key_template="detect_stale_tasks",
    lock_ttl=300,
    on_contention="skip",
    soft_time_limit=110,
    time_limit=120,
    acks_late=True,
    reject_on_worker_lost=True,
    name="notifications.detect_stale_tasks",
)
def detect_stale_tasks(self: object) -> None:
    """Nudge assignees of stale non-terminal tasks (ADR-0200).

    Runs nightly via Celery Beat. Delegates to
    :func:`notifications.services.create_stale_task_notifications`, which owns the
    per-project threshold query, the unread dedupe, and the preference-gated fan-out.

    Idempotent by construction: the dedupe against existing unread ``task.stale``
    notifications means a broker retry, a manual re-queue, or the next nightly tick
    all create zero duplicates. The singleton lock (``on_contention="skip"``) also
    prevents two overlapping runs. A failed run is not retried — the tasks are still
    stale tomorrow, so silent re-attempt on the next tick is correct and avoids a
    retry storm (ADR-0200 §Durable Execution item 8).
    """
    from .services import create_stale_task_notifications

    created = create_stale_task_notifications()
    if created:
        logger.info("detect_stale_tasks: created %d stale-task notification(s)", created)


# ---------------------------------------------------------------------------
# Drain — extracted for direct testability without Celery in the loop
# ---------------------------------------------------------------------------


def _do_drain_emails() -> None:
    from django.utils import timezone

    from .models import Notification

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=EMAIL_ORPHAN_WINDOW_MINUTES)

    pending = list(
        Notification.objects.filter(
            email_pending=True,
            email_sent_at__isnull=True,
            email_attempts__lt=EMAIL_MAX_RETRIES,
            created_at__lt=orphan_cutoff,
        )
        .select_related("recipient", "mention", "mention__task_comment", "mention__mentioner")
        .order_by("created_at")[:EMAIL_BATCH_SIZE]
    )

    if not pending:
        return

    # Resolve the workspace transport + From identity ONCE per batch — the config
    # is constant across the batch, so building it per message would be N SMTP
    # connections + N single-row reads per tick (#712 perf, ADR-0213). A build
    # failure here (e.g. a corrupt row) falls back to the global backend inside
    # resolve_email_connection, so the batch never dead-letters on config alone.
    from .email_backend import (
        resolve_email_connection,
        resolve_from_email,
        resolve_reply_to,
    )
    from .models import WorkspaceEmailSettings

    email_settings = WorkspaceEmailSettings.load()
    connection = resolve_email_connection(email_settings)
    from_email = resolve_from_email(email_settings)
    reply_to = resolve_reply_to(email_settings)

    # Open the shared connection once so all N sends reuse one socket/TLS
    # handshake. Best-effort: if the transport is down, each per-message send
    # still attempts (and fails) on its own, preserving the attempt/retry count.
    try:
        connection.open()
    except Exception:
        logger.warning("drain_notification_emails: could not open mail transport", exc_info=True)

    sent = 0
    failed = 0
    try:
        for notif in pending:
            try:
                ok = _send_email_for_notification(
                    notif,
                    connection=connection,
                    from_email=from_email,
                    reply_to=reply_to,
                )
            except Exception:
                logger.exception(
                    "drain_notification_emails: unexpected error for notif %s", notif.pk
                )
                ok = False

            if ok:
                Notification.objects.filter(pk=notif.pk).update(
                    email_pending=False,
                    email_sent_at=timezone.now(),
                )
                sent += 1
            else:
                # Increment attempts atomically; on attempt N=max, clear
                # email_pending so the row is no longer eligible for retry.
                from django.db.models import F

                new_attempts = notif.email_attempts + 1
                update_fields: dict[str, object] = {
                    "email_attempts": F("email_attempts") + 1,
                    "email_failed_at": timezone.now(),
                }
                if new_attempts >= EMAIL_MAX_RETRIES:
                    update_fields["email_pending"] = False
                Notification.objects.filter(pk=notif.pk).update(**update_fields)
                failed += 1
    finally:
        with contextlib.suppress(Exception):
            connection.close()

    logger.info(
        "drain_notification_emails: sent=%d failed=%d candidates=%d",
        sent,
        failed,
        len(pending),
    )


def _do_archive() -> None:
    from django.utils import timezone

    from .models import Notification

    cutoff = timezone.now() - timedelta(days=ARCHIVE_AFTER_DAYS)
    archived = Notification.objects.filter(
        is_read=True,
        is_archived=False,
        created_at__lt=cutoff,
    ).update(is_archived=True)
    if archived:
        logger.info(
            "archive_old_notifications: archived %d row(s) older than %dd",
            archived,
            ARCHIVE_AFTER_DAYS,
        )


# ---------------------------------------------------------------------------
# Email rendering — minimal Diátaxis-friendly subject + plain-text body
# ---------------------------------------------------------------------------


def _send_email_for_notification(
    notif: object,
    *,
    connection: BaseEmailBackend | None = None,
    from_email: str | None = None,
    reply_to: list[str] | None = None,
) -> bool:
    """Render and send the email for a single Notification.

    Returns True on successful SMTP delivery, False on any failure (SMTP error,
    missing user email, missing source mention). The caller increments the
    attempt counter — this function is pure-attempt, no state mutation.

    The workspace transport (``connection``), ``from_email``, and ``reply_to``
    are resolved **once per drain batch** and passed in (#712 perf: the config is
    constant across a batch, so a per-message ``load()`` + SMTP connect would be
    50 redundant DB reads and SMTP/TLS handshakes per tick). When omitted they are
    resolved here so a direct/one-off caller still works.
    """
    from django.core.mail import EmailMessage

    from .email_backend import (
        resolve_email_connection,
        resolve_from_email,
        resolve_reply_to,
    )
    from .models import Notification

    notif_obj: Notification = notif  # type: ignore[assignment]
    recipient = notif_obj.recipient
    recipient_email = getattr(recipient, "email", "") or ""
    if not recipient_email:
        logger.warning(
            "drain_notification_emails: recipient %s has no email, skipping notif %s",
            getattr(recipient, "pk", "?"),
            notif_obj.pk,
        )
        return False

    # A notification is mention-sourced OR event-sourced (#639, ADR-0085 §3);
    # _render_email handles both shapes and returns ("", "") if neither yields
    # renderable content (e.g. the source comment was deleted).
    subject, body = _render_email(notif_obj)
    if not subject or not body:
        return False

    # Dynamic transport + From identity from the workspace SMTP config (#712,
    # ADR-0213). Falls back to the global backend / DEFAULT_FROM_EMAIL when the
    # workspace transport is unconfigured (cloud), so this is a no-op for installs
    # that never touch the writable config.
    if connection is None:
        connection = resolve_email_connection()
    if from_email is None:
        from_email = resolve_from_email()
    if reply_to is None:
        reply_to = resolve_reply_to()
    msg = EmailMessage(
        subject=subject,
        body=body,
        from_email=from_email,
        to=[recipient_email],
        reply_to=reply_to or None,
        headers=_unsubscribe_headers() or None,
        connection=connection,
    )
    try:
        msg.send(fail_silently=False)
    except Exception:
        logger.warning(
            "drain_notification_emails: SMTP send failed for notif %s",
            notif_obj.pk,
            exc_info=True,
        )
        return False
    return True


def _render_email(notif: object) -> tuple[str, str]:
    """Render a Notification into (subject, body) plain-text strings.

    Kept deliberately minimal — the UI is the primary surface; email is a
    secondary "ping the inbox" channel for users who opt in (default OFF).
    A richer HTML template lands when the executive-digest issue ships
    (trueppm-enterprise#112).
    """
    from .models import Notification

    notif_obj: Notification = notif  # type: ignore[assignment]
    mention = notif_obj.mention
    if mention is None:
        # Event-sourced notification (#639): the subject/body were rendered at
        # dispatch time and frozen on the row. Empty subject => nothing to send.
        return notif_obj.subject, notif_obj.body

    mentioner = mention.mentioner
    mentioner_name = (
        mentioner.get_full_name() or mentioner.username if mentioner is not None else "Someone"
    )

    comment = mention.task_comment
    if comment is None or comment.is_deleted:
        return "", ""

    task = comment.task
    task_name = task.name if task else "a task"
    snippet = _sanitize_snippet(comment.body or "")

    if mention.mentioned_group_key:
        subject = f"{mentioner_name} mentioned @{mention.mentioned_group_key} on {task_name}"
    else:
        subject = f"{mentioner_name} mentioned you on {task_name}"

    body_lines = [
        f'{mentioner_name} mentioned you in a comment on "{task_name}":',
        "",
        snippet,
        "",
        "Open the task in TruePPM to reply or acknowledge.",
        "",
        "—",
        "You can change which notifications send email at /me/settings/notifications/.",
    ]
    body = "\n".join(body_lines)
    return subject, body


def _sanitize_snippet(raw: str) -> str:
    """Bound and format a comment snippet for embedding in the plain-text email body.

    Truncates to ``SNIPPET_MAX_CHARS``, HTML-escapes as defense-in-depth (the
    body is sent as ``text/plain`` today, so this isn't an XSS vector, but
    escaping now means a future HTML template — e.g. the executive-digest work
    in trueppm-enterprise#112 — can reuse this helper without introducing a new
    escaping gap), and hard-wraps at ``SNIPPET_WRAP_WIDTH`` so a long unbroken
    string (a pasted URL, log line, or base64 blob) can't render as a single
    unbounded line in the recipient's mail client (#574, security review !306
    LOW-1). ``quote=False`` on the escape leaves straight/curly quotes and
    apostrophes untouched — those are common in ordinary prose and carry no
    markup risk in body text, only ``&``/``<``/``>`` do.
    """
    text = (raw or "").strip()
    if len(text) > SNIPPET_MAX_CHARS:
        text = text[:SNIPPET_MAX_CHARS].rstrip() + "..."
    escaped = html.escape(text, quote=False)
    return textwrap.fill(
        escaped,
        width=SNIPPET_WRAP_WIDTH,
        break_long_words=True,
        break_on_hyphens=False,
    )


def _unsubscribe_headers() -> dict[str, str]:
    """Build RFC 8058 ``List-Unsubscribe`` / ``List-Unsubscribe-Post`` headers.

    Points at the user's notification-preferences page rather than a bare,
    unauthenticated one-click endpoint — TruePPM has no per-notification
    unsubscribe token today, so this is "one click to the login-gated
    preferences page" rather than a true no-auth unsubscribe. Presence of both
    headers (even pointed at an authenticated page) is still the signal
    Gmail/Outlook bulk-sender heuristics check for at scale (#574, security
    review !306 LOW-1). Returns an empty dict — omitting the headers entirely —
    when the deployer hasn't configured ``FRONTEND_BASE_URL``, since a bare
    relative path is not a valid header value.
    """
    from django.conf import settings

    base = getattr(settings, "FRONTEND_BASE_URL", "").rstrip("/")
    if not base:
        return {}
    prefs_url = f"{base}/me/settings/notifications"
    return {
        "List-Unsubscribe": f"<{prefs_url}>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }
