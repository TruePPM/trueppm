"""Celery tasks for the workspace app (ADR-0087 §Durable Execution).

- ``drain_invite_emails`` — every 30 s, sends queued invite emails via the
  transactional-outbox pattern (mirrors ``notifications.drain_notification_emails``).
  Respects a 5-min orphan window so it never races the invite-create transaction.
- ``purge_stale_invites`` — nightly, marks expired pending invites and deletes
  accepted/revoked/expired invites older than the retention window.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

EMAIL_MAX_RETRIES = 3
EMAIL_ORPHAN_WINDOW_MINUTES = 5  # ADR-0087 §Durable item 3 — matches the notification drain
EMAIL_BATCH_SIZE = 50
INVITE_RETENTION_DAYS = 30  # ADR-0087 §Durable item 6


@idempotent_task(
    lock_key_template="drain_invite_emails",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workspace.drain_invite_emails",
)
def drain_invite_emails(self: object) -> None:
    """Send queued workspace-invite emails (runs every 30 s via Beat)."""
    _do_drain_invite_emails()


@idempotent_task(
    lock_key_template="purge_stale_invites",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workspace.purge_stale_invites",
)
def purge_stale_invites(self: object) -> None:
    """Expire overdue pending invites; delete terminal invites past retention."""
    _do_purge_stale_invites()


# ---------------------------------------------------------------------------
# Drain — extracted for direct testability without Celery in the loop
# ---------------------------------------------------------------------------


def _do_drain_invite_emails() -> None:
    from django.utils import timezone

    from .models import WorkspaceInvite

    now = timezone.now()
    orphan_cutoff = now - timedelta(minutes=EMAIL_ORPHAN_WINDOW_MINUTES)

    pending = list(
        WorkspaceInvite.objects.filter(
            email_pending=True,
            email_sent_at__isnull=True,
            email_attempts__lt=EMAIL_MAX_RETRIES,
            created_at__lt=orphan_cutoff,
        )
        .select_related("invited_by")
        .order_by("created_at")[:EMAIL_BATCH_SIZE]
    )
    if not pending:
        return

    sent = 0
    failed = 0
    for invite in pending:
        try:
            ok = _send_invite_email(invite)
        except Exception:
            logger.exception("drain_invite_emails: unexpected error for invite %s", invite.pk)
            ok = False

        if ok:
            # Clearing email_token consumes the at-rest raw token — after a
            # successful send only the SHA-256 hash remains (ADR-0087 §4).
            WorkspaceInvite.objects.filter(pk=invite.pk).update(
                email_pending=False,
                email_sent_at=timezone.now(),
                email_token="",
            )
            sent += 1
        else:
            from django.db.models import F

            new_attempts = invite.email_attempts + 1
            update_fields: dict[str, object] = {
                "email_attempts": F("email_attempts") + 1,
                "email_failed_at": timezone.now(),
            }
            if new_attempts >= EMAIL_MAX_RETRIES:
                update_fields["email_pending"] = False
            WorkspaceInvite.objects.filter(pk=invite.pk).update(**update_fields)
            failed += 1

    logger.info("drain_invite_emails: sent=%d failed=%d candidates=%d", sent, failed, len(pending))


def _do_purge_stale_invites() -> None:
    from django.utils import timezone

    from .models import InviteStatus, WorkspaceInvite

    now = timezone.now()
    expired = WorkspaceInvite.objects.filter(
        status=InviteStatus.PENDING, expires_at__lt=now
    ).update(status=InviteStatus.EXPIRED, email_pending=False, email_token="")

    cutoff = now - timedelta(days=INVITE_RETENTION_DAYS)
    deleted, _ = WorkspaceInvite.objects.filter(
        status__in=[InviteStatus.ACCEPTED, InviteStatus.REVOKED, InviteStatus.EXPIRED],
        created_at__lt=cutoff,
    ).delete()
    if expired or deleted:
        logger.info("purge_stale_invites: expired=%d deleted=%d", expired, deleted)


# ---------------------------------------------------------------------------
# Email rendering
# ---------------------------------------------------------------------------


def _send_invite_email(invite: object) -> bool:
    """Render and send the invitation email. Returns True on SMTP success."""
    from django.conf import settings
    from django.core.mail import EmailMessage

    from .models import WorkspaceInvite

    inv: WorkspaceInvite = invite  # type: ignore[assignment]
    if not inv.email or not inv.email_token:
        return False

    subject, body = _render_invite_email(inv)
    from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@trueppm.local")
    msg = EmailMessage(subject=subject, body=body, from_email=from_email, to=[inv.email])
    try:
        msg.send(fail_silently=False)
    except Exception:
        logger.warning("drain_invite_emails: SMTP send failed for invite %s", inv.pk, exc_info=True)
        return False
    return True


def _render_invite_email(invite: object) -> tuple[str, str]:
    from django.conf import settings

    from .models import Workspace, WorkspaceInvite, WorkspaceRole

    inv: WorkspaceInvite = invite  # type: ignore[assignment]
    workspace_name = Workspace.load().name
    base = getattr(settings, "FRONTEND_BASE_URL", "").rstrip("/")
    accept_url = f"{base}/invite/accept?token={inv.email_token}"

    inviter = inv.invited_by
    inviter_name = (
        (inviter.get_full_name() or inviter.username) if inviter is not None else "An admin"
    )
    role_label = WorkspaceRole(inv.role).label

    subject = f"You've been invited to {workspace_name} on TruePPM"
    body = "\n".join(
        [
            f"{inviter_name} has invited you to join {workspace_name} as a {role_label}.",
            "",
            "Accept your invitation:",
            accept_url,
            "",
            f"This invitation expires on {inv.expires_at:%Y-%m-%d}.",
            "",
            "If you weren't expecting this, you can ignore this email.",
        ]
    )
    return subject, body
