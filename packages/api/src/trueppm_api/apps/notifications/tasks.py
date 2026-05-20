"""Celery tasks for the notifications app (ADR-0075 §F durable-execution).

Two Beat-scheduled tasks:

- ``drain_notification_emails`` — every 30 s, finds Notification rows with
  ``email_pending=True`` older than the 5-min orphan window, renders an email
  for each, sends via SMTP, and updates delivery state. Best-effort — broker
  outage logs but doesn't propagate.

- ``archive_old_notifications`` — nightly, sets ``is_archived=True`` on any
  Notification older than 90 days that has ``is_read=True``. Keeps the
  index on ``(recipient, is_read, -created_at)`` shallow for the unread
  query path.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


# Locked constants for email delivery — kept in this module so they're
# adjacent to the drain task that owns them.
EMAIL_MAX_RETRIES = 3
EMAIL_ORPHAN_WINDOW_MINUTES = 5  # ADR-0075 §F durable-execution checklist item 3
EMAIL_BATCH_SIZE = 50  # cap per drain tick — prevents one tick from monopolizing the worker
ARCHIVE_AFTER_DAYS = 90  # ADR-0075 §F item 6 — outbox cleanup


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

    sent = 0
    failed = 0
    for notif in pending:
        try:
            ok = _send_email_for_notification(notif)
        except Exception:
            logger.exception("drain_notification_emails: unexpected error for notif %s", notif.pk)
            ok = False

        if ok:
            Notification.objects.filter(pk=notif.pk).update(
                email_pending=False,
                email_sent_at=timezone.now(),
            )
            sent += 1
        else:
            # Increment attempts atomically; on attempt N=max, clear email_pending
            # so the row is no longer eligible for retry.
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


def _send_email_for_notification(notif: object) -> bool:
    """Render and send the email for a single Notification.

    Returns True on successful SMTP delivery, False on any failure (SMTP error,
    missing user email, missing source mention). The caller increments the
    attempt counter — this function is pure-attempt, no state mutation.
    """
    from django.conf import settings
    from django.core.mail import EmailMessage

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

    mention = notif_obj.mention
    if mention is None:
        logger.warning(
            "drain_notification_emails: notif %s has no source mention, skipping",
            notif_obj.pk,
        )
        return False

    subject, body = _render_email(notif_obj)
    if not subject or not body:
        return False

    from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@trueppm.local")
    msg = EmailMessage(
        subject=subject,
        body=body,
        from_email=from_email,
        to=[recipient_email],
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
        return "", ""

    mentioner = mention.mentioner
    mentioner_name = (
        mentioner.get_full_name() or mentioner.username if mentioner is not None else "Someone"
    )

    comment = mention.task_comment
    if comment is None or comment.is_deleted:
        return "", ""

    task = comment.task
    task_name = task.name if task else "a task"
    snippet = (comment.body or "")[:280]

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
