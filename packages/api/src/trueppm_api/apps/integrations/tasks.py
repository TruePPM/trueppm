"""Celery workers for user-scoped external task sync (ADR-0097 §4).

Four tasks, all registered under short names for Beat (#319):

- ``external_sync`` — pull one ``ExternalSyncRequest``'s connection: fetch the
  owner's assigned items from the source, upsert them into ``ExternalWorkItem``,
  soft-remove any that vanished, and flip the connection to ``connected`` /
  ``auth_failed``. Idempotent under the row's ``@idempotent_task`` lock.
- ``drain_external_sync`` — 300 s outbox drain: dispatch stranded ``PENDING``
  rows and recover orphaned ``DISPATCHED`` ones (ADR-0097 §Durable Execution #2).
- ``poll_external_sources`` — low-frequency opt-in poll: enqueue a pull for every
  connection whose owner opted in (``config["poll_enabled"]``). Default-off, so
  this no-ops until a user turns polling on (ADR-0097 §4).
- ``purge_external_sync`` — nightly cleanup: hard-delete terminal outbox rows and
  long-stale ``ExternalWorkItem`` cache rows (ADR-0097 §Durable Execution #6).

Security (ADR-0097 §Resolution #2): the PAT and ``Authorization`` header never
reach a log line — only the source key, user id, and a scrubbed error class are
recorded. The pull can **never** mint a ``Task`` (the §2 read-only invariant).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.db import transaction
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

from .connections import STATUS_AUTH_FAILED, STATUS_CONNECTED
from .encryption import decrypt_secret
from .external_sources import (
    EXTERNAL_TASK_SOURCES,
    ExternalSourceAuthError,
    ExternalSourceError,
    ExternalWorkItemDTO,
)
from .models import (
    ExternalSyncRequest,
    ExternalSyncRequestReason,
    ExternalSyncRequestStatus,
    ExternalWorkItem,
    IntegrationCredential,
)

logger = logging.getLogger(__name__)

# Per-(user, source) cache cap (ADR-0097 §Decision #4 "bounded growth"). The
# frozen source ABC fetches a single ~100-item page, so this is a defensive DB
# bound rather than a routinely-hit limit; when a page ever exceeds it we keep
# the first CACHE_ITEM_CAP and drop the rest so the cache stays bounded.
CACHE_ITEM_CAP = 500

# Drain floor: a PENDING row younger than this was almost certainly just handed
# to on_commit dispatch, so the drain skips it to avoid a double-dispatch race
# (ADR-0097 §Durable Execution #3). Older PENDING rows are genuinely stranded.
_DRAIN_PENDING_FLOOR = timedelta(minutes=2)

# Orphan recovery: a DISPATCHED row this old outlived any real pull (the fetch
# is HTTP-timeout-bounded to a few seconds), so its worker died — reset it to
# PENDING for re-dispatch. Matches the scheduling drain's 10-minute window.
_DRAIN_ORPHAN_CUTOFF = timedelta(minutes=10)

# Retention windows for the nightly purge.
_OUTBOX_RETENTION = timedelta(days=7)
# Stale (vanished-from-Jira) items linger briefly so My Work can show a just-
# completed item, then are hard-deleted (ADR-0097 §5).
_STALE_ITEM_RETENTION = timedelta(days=7)


# ---------------------------------------------------------------------------
# external_sync — pull one connection
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="external_sync:{0}",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=25,
    time_limit=30,
    acks_late=True,
    reject_on_worker_lost=True,
    name="integrations.external_sync",
)
def external_sync(self: object, request_id: str) -> None:
    """Execute one queued external-source pull.

    Locked per request id so a duplicate dispatch (on_commit + drain racing)
    converges rather than double-fetching; ``on_contention="skip"`` drops the
    loser because the winner already did the work.
    """
    _do_sync(request_id)


def _do_sync(request_id: str) -> None:
    """Business logic for ``external_sync`` — extracted for direct testing.

    Loads and locks the outbox row, decrypts the owner's PAT, fetches their
    assigned items, upserts the cache, soft-removes anything that vanished, and
    marks the row ``DONE``/``DEAD``. Terminal rows (already ``DONE``/``DEAD``) are
    a no-op so a re-dispatch is safe.
    """
    now = timezone.now()
    with transaction.atomic():
        req = ExternalSyncRequest.objects.select_for_update().filter(id=request_id).first()
        if req is None:
            # Purged between dispatch and execution — nothing to do.
            return
        if req.status in (
            ExternalSyncRequestStatus.DONE,
            ExternalSyncRequestStatus.DEAD,
        ):
            # Already processed by the winning dispatch — idempotent skip.
            return

        cred = IntegrationCredential.objects.filter(
            user_id=req.user_id, provider=req.source
        ).first()
        source_cls = EXTERNAL_TASK_SOURCES.get(req.source)
        if cred is None or source_cls is None:
            # The connection was deleted (or its source de-registered) after the
            # pull was queued. Nothing to sync; retire the row.
            _mark_dead(req, "connection no longer exists")
            return

        try:
            secret = decrypt_secret(cred.secret_ciphertext)
        except Exception:
            # A corrupt/undecryptable ciphertext is not user-recoverable by a
            # retry; retire the row without leaking the plaintext into the log
            # (only user_id/source are interpolated below, never the value).
            logger.warning(
                "external_sync: stored connection data could not be decrypted "
                "for user=%s source=%s",
                req.user_id,
                req.source,
            )
            _mark_dead(req, "credential could not be decrypted")
            return

        try:
            items = source_cls().fetch_assigned_items(
                base_url=cred.base_url, secret=secret, config=cred.config or {}
            )
        except ExternalSourceAuthError:
            # 401/403: the token is dead. Flip the connection to auth_failed so My
            # Work shows "Reconnect", stop using the token, keep the last-good
            # cache (ADR-0097 §5). No retry loop on an auth failure.
            _set_connection_status(cred, STATUS_AUTH_FAILED)
            _mark_dead(req, "auth_failed")
            logger.info(
                "external_sync: auth failed for user=%s source=%s — connection flagged",
                req.user_id,
                req.source,
            )
            return
        except ExternalSourceError as exc:
            # Transient (5xx / timeout / rate-limit): keep the last-good cache and
            # retire this attempt. The user (or the next poll) re-triggers; the
            # cooldown keeps the retry cadence sane. No data is lost.
            _mark_dead(req, f"unreachable: {type(exc).__name__}")
            logger.info(
                "external_sync: source unreachable for user=%s source=%s (%s)",
                req.user_id,
                req.source,
                type(exc).__name__,
            )
            return

        _apply_pull(req.user_id, req.source, items, now)

        # Successful pull: stamp the connection and retire the row.
        cred.last_used_at = now
        _set_connection_status(cred, STATUS_CONNECTED, extra_save_fields=["last_used_at"])
        req.status = ExternalSyncRequestStatus.DONE
        req.last_error = ""
        req.save(update_fields=["status", "last_error"])


def _apply_pull(
    user_id: int,
    source: str,
    items: list[ExternalWorkItemDTO],
    now: datetime,
) -> None:
    """Upsert the fetched DTOs and soft-remove anything that vanished.

    Items are already sanitized (field caps + URL scheme) at the registry
    boundary. Capped at :data:`CACHE_ITEM_CAP` per (user, source). An
    ``external_id`` no longer returned by a *successful* pull is soft-removed
    (``is_stale=True``) — never hard-deleted here — so a transient partial
    response can never wipe the list (ADR-0097 §5).
    """
    capped = items[:CACHE_ITEM_CAP]
    seen: set[str] = set()
    for raw in capped:
        # Re-sanitize at the persistence boundary (idempotent): the OSS Jira
        # source already returns sanitized DTOs, but making *this* the enforcement
        # point means a future/Enterprise source that forgets ``.sanitized()``
        # still cannot land an over-long field or a ``javascript:``/``data:`` URL
        # in the cache — URLField scheme validation does not run on ``.save()``
        # (ADR-0097 §Resolution #4, defense in depth).
        dto = raw.sanitized()
        seen.add(dto.external_id)
        ExternalWorkItem.objects.update_or_create(
            user_id=user_id,
            source=source,
            external_id=dto.external_id,
            defaults={
                "external_url": dto.external_url,
                "title": dto.title,
                "external_status": dto.external_status,
                "display_bucket": dto.display_bucket,
                "due_date": dto.due_date,
                "last_synced_at": now,
                "is_stale": False,
            },
        )
    # Soft-remove cached rows for this connection that this pull did not return.
    stale_qs = ExternalWorkItem.objects.filter(user_id=user_id, source=source)
    if seen:
        stale_qs = stale_qs.exclude(external_id__in=seen)
    stale_qs.filter(is_stale=False).update(is_stale=True, last_synced_at=now)


def _set_connection_status(
    cred: IntegrationCredential,
    status: str,
    *,
    extra_save_fields: list[str] | None = None,
) -> None:
    """Write ``config["status"]`` on the credential row (the connection lifecycle).

    ``config`` is the ADR-0097 §2 reuse of ``IntegrationCredential`` — the
    connection's ``{account_email, jql, project_keys, status}`` live there. Only
    ``status`` (+ any ``extra_save_fields`` the caller already set) is persisted.
    """
    config = dict(cred.config or {})
    config["status"] = status
    cred.config = config
    cred.save(update_fields=["config", *(extra_save_fields or [])])


def _mark_dead(req: ExternalSyncRequest, error: str) -> None:
    """Retire an outbox row as ``DEAD`` with a scrubbed error note."""
    req.status = ExternalSyncRequestStatus.DEAD
    req.last_error = error[:512]
    req.save(update_fields=["status", "last_error"])


# ---------------------------------------------------------------------------
# drain_external_sync — outbox recovery
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="drain_external_sync",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="integrations.drain_external_sync",
)
def drain_external_sync(self: object) -> None:
    """Dispatch stranded PENDING rows and recover orphaned DISPATCHED ones.

    Runs every 300 s. The singleton lock + ``on_contention="skip"`` guarantee at
    most one drain at a time; the next Beat tick covers any dropped trigger.
    """
    _do_drain()


def _do_drain() -> None:
    """Business logic for ``drain_external_sync`` — extracted for testability."""
    now = timezone.now()

    recovered = ExternalSyncRequest.objects.filter(
        status=ExternalSyncRequestStatus.DISPATCHED,
        dispatched_at__lt=now - _DRAIN_ORPHAN_CUTOFF,
    ).update(status=ExternalSyncRequestStatus.PENDING, celery_task_id="")
    if recovered:
        logger.warning("drain_external_sync: recovered %d orphaned dispatched row(s)", recovered)

    # Only dispatch PENDING rows past the floor — younger ones were just handed to
    # on_commit dispatch and would double-fire (the per-request lock would drop
    # the loser, but skipping avoids the churn).
    pending = list(
        ExternalSyncRequest.objects.filter(
            status=ExternalSyncRequestStatus.PENDING,
            requested_at__lt=now - _DRAIN_PENDING_FLOOR,
        )
    )
    dispatched = 0
    for req in pending:
        try:
            result = external_sync.delay(str(req.id))
        except Exception:
            logger.warning(
                "drain_external_sync: broker unavailable — request %s stays pending",
                req.id,
            )
            continue
        ExternalSyncRequest.objects.filter(
            id=req.id, status=ExternalSyncRequestStatus.PENDING
        ).update(
            status=ExternalSyncRequestStatus.DISPATCHED,
            celery_task_id=result.id,
            dispatched_at=now,
        )
        dispatched += 1

    if dispatched or recovered:
        logger.info("drain_external_sync: dispatched=%d recovered=%d", dispatched, recovered)


# ---------------------------------------------------------------------------
# poll_external_sources — opt-in low-frequency poll
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="poll_external_sources",
    lock_ttl=60,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="integrations.poll_external_sources",
)
def poll_external_sources(self: object) -> None:
    """Enqueue a pull for every connection whose owner opted into polling.

    Default-off (ADR-0097 §4): a connection polls only when its ``config`` carries
    ``poll_enabled: true`` and it is not in ``auth_failed``. With no UI toggle yet
    this task is a wired-but-dormant hook — it fans out zero pulls today.
    """
    _do_poll()


def _do_poll() -> None:
    """Business logic for ``poll_external_sources`` — extracted for testability."""
    from .services import enqueue_external_sync

    source_keys = set(EXTERNAL_TASK_SOURCES.keys())
    if not source_keys:
        return
    # Push the opt-in gates into the DB so a default-off install scans (and
    # returns) ~zero rows each tick rather than every registered-source
    # credential: poll_enabled must be truthy and the connection must not be in
    # auth_failed. The Python re-check below is belt-and-suspenders for the rare
    # config shapes a JSON lookup can't express (e.g. poll_enabled stored as a
    # string). ``.iterator()` keeps memory flat if the opted-in set ever grows.
    candidates = (
        IntegrationCredential.objects.filter(provider__in=source_keys, config__poll_enabled=True)
        .exclude(config__status=STATUS_AUTH_FAILED)
        .iterator()
    )
    queued = 0
    for cred in candidates:
        config = cred.config or {}
        if not config.get("poll_enabled"):
            continue
        if config.get("status") == STATUS_AUTH_FAILED:
            continue
        try:
            enqueue_external_sync(
                cred.user_id, cred.provider, reason=ExternalSyncRequestReason.POLL
            )
        except ValueError:
            # provider not a live external source (e.g. a plain git PAT) — skip.
            continue
        queued += 1
    if queued:
        logger.info("poll_external_sources: enqueued %d poll(s)", queued)


# ---------------------------------------------------------------------------
# purge_external_sync — nightly cleanup
# ---------------------------------------------------------------------------


@idempotent_task(
    lock_key_template="purge_external_sync",
    lock_ttl=120,
    on_contention="skip",
    soft_time_limit=55,
    time_limit=90,
    acks_late=True,
    reject_on_worker_lost=True,
    name="integrations.purge_external_sync",
)
def purge_external_sync(self: object) -> None:
    """Hard-delete terminal outbox rows and long-stale cache rows (nightly)."""
    _do_purge()


def _do_purge() -> None:
    """Business logic for ``purge_external_sync`` — extracted for testability."""
    now = timezone.now()

    outbox_deleted, _ = ExternalSyncRequest.objects.filter(
        status__in=[ExternalSyncRequestStatus.DONE, ExternalSyncRequestStatus.DEAD],
        requested_at__lt=now - _OUTBOX_RETENTION,
    ).delete()

    # Stale items are kept briefly (so a just-completed item can show in My Work),
    # then reaped. Guard on last_synced_at so a row still within the grace window
    # survives.
    items_deleted, _ = ExternalWorkItem.objects.filter(
        is_stale=True,
        last_synced_at__lt=now - _STALE_ITEM_RETENTION,
    ).delete()

    if outbox_deleted or items_deleted:
        logger.info(
            "purge_external_sync: outbox=%d stale_items=%d",
            outbox_deleted,
            items_deleted,
        )
