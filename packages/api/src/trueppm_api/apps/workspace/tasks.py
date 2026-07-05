"""Celery tasks for the workspace app (ADR-0087 §Durable Execution).

- ``drain_invite_emails`` — every 30 s, sends queued invite emails via the
  transactional-outbox pattern (mirrors ``notifications.drain_notification_emails``).
  Respects a 5-min orphan window so it never races the invite-create transaction.
- ``purge_stale_invites`` — nightly, marks expired pending invites and deletes
  accepted/revoked/expired invites older than the retention window.
- ``run_workspace_export`` — builds a full-workspace archive for one job and emails
  the owner; idempotent + bounded retries (ADR-0174).
- ``drain_workspace_exports`` — every 30 s, re-dispatches export jobs orphaned by a
  broker outage at ``on_commit`` (5-min orphan window).
- ``purge_expired_exports`` — nightly, deletes export jobs past their link expiry and
  their stored archives.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)

EMAIL_MAX_RETRIES = 3
EMAIL_ORPHAN_WINDOW_MINUTES = 5  # ADR-0087 §Durable item 3 — matches the notification drain
EMAIL_BATCH_SIZE = 50
INVITE_RETENTION_DAYS = 30  # ADR-0087 §Durable item 6

EXPORT_MAX_RETRIES = 3  # ADR-0174 §Durable item 8
EXPORT_ORPHAN_WINDOW_MINUTES = 5  # ADR-0174 §Durable item 3
EXPORT_DRAIN_BATCH_SIZE = 10
DEFAULT_EXPORT_RETENTION_DAYS = 7  # ADR-0174 §Durable item 6


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

            from .models import InviteStatus

            new_attempts = invite.email_attempts + 1
            update_fields: dict[str, object] = {
                "email_attempts": F("email_attempts") + 1,
                "email_failed_at": timezone.now(),
            }
            if new_attempts >= EMAIL_MAX_RETRIES:
                # Terminal failure: stop draining, clear the raw token regardless so
                # it does not linger at rest once the send path has given up, and
                # mark the invite FAILED so it is visibly dead (an admin re-invites).
                # The previous code left email_token populated forever on a row that
                # would never send — exactly the at-rest retention the hash design
                # exists to avoid (ADR-0087 §4).
                update_fields["email_pending"] = False
                update_fields["email_token"] = ""
                update_fields["status"] = InviteStatus.FAILED
            WorkspaceInvite.objects.filter(pk=invite.pk).update(**update_fields)
            failed += 1

    logger.info("drain_invite_emails: sent=%d failed=%d candidates=%d", sent, failed, len(pending))


# ---------------------------------------------------------------------------
# Workspace export (ADR-0174, #641)
# ---------------------------------------------------------------------------


@shared_task(  # type: ignore[untyped-decorator]
    bind=True,
    max_retries=EXPORT_MAX_RETRIES,
    soft_time_limit=600,
    time_limit=660,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workspace.run_workspace_export",
)
def run_workspace_export(self: object, job_id: str) -> None:
    """Build the full-workspace archive for ``job_id`` and email the owner.

    Idempotent: claims the job under ``select_for_update`` and no-ops unless it is
    ``pending``/``running``, so a duplicate delivery (broker retry, drain re-dispatch)
    cannot produce two archives. Transient failures retry up to ``EXPORT_MAX_RETRIES``
    (the job stays ``running`` so a retry is allowed); on exhaustion the job is marked
    ``failed`` and the owner can request a fresh export.
    """
    # Claim the job (idempotency gate).
    from django.db import transaction
    from django.utils import timezone

    from .export import build_and_store_archive
    from .models import ExportJobStatus, WorkspaceExportJob

    with transaction.atomic():
        job = WorkspaceExportJob.objects.select_for_update().filter(pk=job_id).first()
        if job is None:
            logger.warning("run_workspace_export: job %s not found", job_id)
            return
        if job.status not in (ExportJobStatus.PENDING, ExportJobStatus.RUNNING):
            logger.info("run_workspace_export: job %s already %s, skipping", job_id, job.status)
            return
        job.status = ExportJobStatus.RUNNING
        job.started_at = timezone.now()
        job.celery_task_id = getattr(getattr(self, "request", None), "id", "") or ""
        job.save(update_fields=["status", "started_at", "celery_task_id"])

    try:
        storage_path, size = build_and_store_archive(job_id)
    except Exception as exc:
        retries = getattr(getattr(self, "request", None), "retries", 0)
        if retries < EXPORT_MAX_RETRIES:
            logger.warning("run_workspace_export: job %s failed, retrying", job_id, exc_info=True)
            raise self.retry(exc=exc, countdown=10 * (2**retries)) from exc  # type: ignore[attr-defined]
        logger.exception("run_workspace_export: job %s failed permanently", job_id)
        WorkspaceExportJob.objects.filter(pk=job_id).update(
            status=ExportJobStatus.FAILED,
            error_detail=str(exc)[:2000],
            completed_at=timezone.now(),
        )
        return

    retention = _export_retention_days()
    expires_at = timezone.now() + timedelta(days=retention) if retention is not None else None
    WorkspaceExportJob.objects.filter(pk=job_id).update(
        status=ExportJobStatus.SUCCESS,
        file_path=storage_path,
        file_size=size,
        expires_at=expires_at,
        completed_at=timezone.now(),
        error_detail="",
    )
    _send_export_ready_email(job_id)


@idempotent_task(
    lock_key_template="drain_workspace_exports",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workspace.drain_workspace_exports",
)
def drain_workspace_exports(self: object) -> None:
    """Re-dispatch export jobs stuck in ``pending`` (broker down at on_commit)."""
    _do_drain_workspace_exports()


@idempotent_task(
    lock_key_template="purge_expired_exports",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="workspace.purge_expired_exports",
)
def purge_expired_exports(self: object) -> None:
    """Delete export jobs past their link expiry, and their stored archives."""
    _do_purge_expired_exports()


def _export_retention_days() -> int | None:
    from django.conf import settings

    return getattr(settings, "TRUEPPM_EXPORT_RETENTION_DAYS", DEFAULT_EXPORT_RETENTION_DAYS)


def _do_drain_workspace_exports() -> None:
    from django.utils import timezone

    from .models import ExportJobStatus, WorkspaceExportJob

    orphan_cutoff = timezone.now() - timedelta(minutes=EXPORT_ORPHAN_WINDOW_MINUTES)
    stuck = list(
        WorkspaceExportJob.objects.filter(
            status=ExportJobStatus.PENDING,
            celery_task_id="",
            created_at__lt=orphan_cutoff,
        ).order_by("created_at")[:EXPORT_DRAIN_BATCH_SIZE]
    )
    if not stuck:
        return
    for job in stuck:
        try:
            run_workspace_export.delay(str(job.id))
        except Exception:  # pragma: no cover - broker still down, next tick retries
            logger.warning("drain_workspace_exports: broker still unavailable for %s", job.id)
            break
    logger.info("drain_workspace_exports: re-dispatched %d job(s)", len(stuck))


def _do_purge_expired_exports() -> None:
    from django.core.files.storage import default_storage
    from django.utils import timezone

    from .models import WorkspaceExportJob

    retention = _export_retention_days()
    if retention is None:  # retention disabled — keep archives indefinitely
        return
    expired = WorkspaceExportJob.objects.filter(expires_at__lt=timezone.now())
    count = 0
    for job in expired.iterator():
        if job.file_path:
            try:
                default_storage.delete(job.file_path)
            except OSError:  # pragma: no cover - storage drift, still drop the row
                logger.warning("purge_expired_exports: could not delete file for %s", job.id)
        job.delete()
        count += 1
    if count:
        logger.info("purge_expired_exports: deleted %d expired export(s)", count)


def _send_export_ready_email(job_id: str) -> bool:
    """Notify the owner their export is ready. Best-effort (returns success)."""
    from django.core.mail import EmailMessage

    from .models import WorkspaceExportJob

    job = WorkspaceExportJob.objects.select_related("requested_by").filter(pk=job_id).first()
    if job is None or job.requested_by is None or not job.requested_by.email:
        return False

    subject, body = _render_export_email(job)
    from trueppm_api.apps.notifications.email_backend import (
        resolve_email_connection,
        resolve_from_email,
    )

    # Send on the workspace SMTP transport (#712, ADR-0211); no-op fall back to
    # the global backend when unconfigured.
    msg = EmailMessage(
        subject=subject,
        body=body,
        from_email=resolve_from_email(),
        to=[job.requested_by.email],
        connection=resolve_email_connection(),
    )
    try:
        msg.send(fail_silently=False)
    except Exception:
        logger.warning("export ready email failed for job %s", job_id, exc_info=True)
        return False
    return True


def _render_export_email(job: object) -> tuple[str, str]:
    from django.conf import settings

    from .models import Workspace

    workspace_name = Workspace.load().name
    base = getattr(settings, "FRONTEND_BASE_URL", "").rstrip("/")
    # The link lands on the danger page, which fetches the job and offers an
    # authenticated download — we never email a raw, unauthenticated archive URL.
    download_url = f"{base}/settings/workspace/danger"
    subject = f"Your {workspace_name} export is ready"
    body = "\n".join(
        [
            f"Your full export of {workspace_name} has finished and is ready to download.",
            "",
            "Download it from the workspace danger zone:",
            download_url,
            "",
            "The download link expires after a few days; request a new export if it lapses.",
        ]
    )
    return subject, body


def _do_purge_stale_invites() -> None:
    from django.utils import timezone

    from .models import InviteStatus, WorkspaceInvite

    now = timezone.now()
    expired = WorkspaceInvite.objects.filter(
        status=InviteStatus.PENDING, expires_at__lt=now
    ).update(status=InviteStatus.EXPIRED, email_pending=False, email_token="")

    cutoff = now - timedelta(days=INVITE_RETENTION_DAYS)
    deleted, _ = WorkspaceInvite.objects.filter(
        status__in=[
            InviteStatus.ACCEPTED,
            InviteStatus.REVOKED,
            InviteStatus.EXPIRED,
            InviteStatus.FAILED,
        ],
        created_at__lt=cutoff,
    ).delete()
    if expired or deleted:
        logger.info("purge_stale_invites: expired=%d deleted=%d", expired, deleted)


# ---------------------------------------------------------------------------
# Email rendering
# ---------------------------------------------------------------------------


def _send_invite_email(invite: object) -> bool:
    """Render and send the invitation email. Returns True on SMTP success."""
    from django.core.mail import EmailMessage

    from .models import WorkspaceInvite

    inv: WorkspaceInvite = invite  # type: ignore[assignment]
    if not inv.email or not inv.email_token:
        return False

    subject, body = _render_invite_email(inv)
    from trueppm_api.apps.notifications.email_backend import (
        resolve_email_connection,
        resolve_from_email,
    )

    # Send on the workspace SMTP transport (#712, ADR-0211); no-op fall back to
    # the global backend when unconfigured.
    msg = EmailMessage(
        subject=subject,
        body=body,
        from_email=resolve_from_email(),
        to=[inv.email],
        connection=resolve_email_connection(),
    )
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
