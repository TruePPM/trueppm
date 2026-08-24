"""Celery workers for user-scoped external task sync (ADR-0097 §4).

Four tasks, all registered under short names for Beat (#319):

- ``external_sync`` — pull one ``ExternalSyncRequest``'s connection: fetch the
  owner's assigned items from the source, upsert them into ``ExternalWorkItem``,
  soft-remove any that vanished, and flip the connection to ``connected`` /
  ``auth_failed`` / ``invalid_filter``. Idempotent under the row's
  ``@idempotent_task`` lock.
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
from typing import Any

from django.db import models, transaction
from django.utils import timezone

from trueppm_api.core.idempotent import idempotent_task

from .connections import (
    STATUS_AUTH_FAILED,
    STATUS_CONNECTED,
    STATUS_INVALID_FILTER,
    SYNC_FAILURE_REASONS,
    SYNC_REASON_AUTH_FAILED,
    SYNC_REASON_DECRYPT_FAILED,
    SYNC_REASON_INVALID_FILTER,
    SYNC_REASON_RATE_LIMITED,
    SYNC_REASON_UNREACHABLE,
)
from .encryption import decrypt_secret
from .external_sources import (
    EXTERNAL_TASK_SOURCES,
    ExternalFetchResult,
    ExternalSourceAuthError,
    ExternalSourceConfigError,
    ExternalSourceError,
    ExternalSourceRateLimited,
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

# The ``config["last_sync"]["reason"]`` vocabulary is defined in ``connections``
# — beside the read surface that serves it, so that surface can validate against
# it without importing back into this module. Re-exported here because this is
# the only module that *writes* it, and every writer should reach for it by name.
__all__ = [
    "SYNC_FAILURE_REASONS",
    "SYNC_REASON_AUTH_FAILED",
    "SYNC_REASON_DECRYPT_FAILED",
    "SYNC_REASON_INVALID_FILTER",
    "SYNC_REASON_RATE_LIMITED",
    "SYNC_REASON_UNREACHABLE",
    "drain_external_sync",
    "external_sync",
    "poll_external_sources",
    "purge_external_sync",
]

# Drain floor: a PENDING row younger than this was almost certainly just handed
# to on_commit dispatch, so the drain skips it to avoid a double-dispatch race
# (ADR-0097 §Durable Execution #3). Older PENDING rows are genuinely stranded.
_DRAIN_PENDING_FLOOR = timedelta(minutes=2)

# Orphan recovery: a DISPATCHED row this old outlived any real pull (the fetch
# is HTTP-timeout-bounded to a few seconds), so its worker died — reset it to
# PENDING for re-dispatch. Matches the scheduling drain's 10-minute window.
_DRAIN_ORPHAN_CUTOFF = timedelta(minutes=10)

# Rate-limit backoff (#2924). Used when a 429 carries no usable ``Retry-After``;
# a header value always wins. Clamped at the top end so a source answering with an
# absurd Retry-After (or a clock-skewed HTTP-date) cannot park a pull for hours.
_RATE_LIMIT_DEFAULT_BACKOFF = timedelta(seconds=60)
_RATE_LIMIT_MAX_BACKOFF = timedelta(minutes=15)

# How many times one pull may be re-queued for rate limiting before it retires.
# Bounds the loop for a source that 429s indefinitely; the user's next manual
# refresh (or the poll) starts a fresh row, so this is not a permanent give-up.
_MAX_RATE_LIMIT_ATTEMPTS = 3

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
            _record_failed_pull(cred, SYNC_REASON_DECRYPT_FAILED, now)
            _mark_dead(req, "credential could not be decrypted")
            return

        try:
            result = source_cls().fetch_assigned_items_result(
                base_url=cred.base_url, secret=secret, config=cred.config or {}
            )
        except ExternalSourceAuthError:
            # 401/403: the token is dead. Flip the connection to auth_failed so My
            # Work shows "Reconnect", stop using the token, keep the last-good
            # cache (ADR-0097 §5). No retry loop on an auth failure.
            _set_connection_status(
                cred,
                STATUS_AUTH_FAILED,
                last_sync=_failed_outcome(SYNC_REASON_AUTH_FAILED, now),
            )
            _mark_dead(req, "auth_failed")
            logger.info(
                "external_sync: auth failed for user=%s source=%s — connection flagged",
                req.user_id,
                req.source,
            )
            return
        except ExternalSourceConfigError:
            # The stored filter cannot be scoped safely (a project key that is not
            # a project key, or a JQL whose parentheses do not balance — both are
            # reachable on rows written before those values were validated). A
            # retry can never fix it, and the alternative to refusing is pulling
            # wider than the owner selected, so flag the connection with a state
            # whose remedy is the connect wizard and stop. Must precede the generic
            # ExternalSourceError arm below — this is a subclass of it.
            _set_connection_status(
                cred,
                STATUS_INVALID_FILTER,
                last_sync=_failed_outcome(SYNC_REASON_INVALID_FILTER, now),
            )
            _mark_dead(req, "invalid_filter")
            logger.info(
                "external_sync: stored filter unusable for user=%s source=%s — connection flagged",
                req.user_id,
                req.source,
            )
            return
        except ExternalSourceRateLimited as exc:
            # 429: the source told us WHEN to come back, so re-queue against that
            # clock instead of dead-lettering (#2924). Before this the row was
            # marked DEAD "unreachable" and the owner saw a broken connection for
            # what is a routine, self-healing condition. Deliberately does NOT
            # touch the connection status: the credential is valid and the host is
            # reachable, so flagging it would send the user to re-issue a token
            # that was never the problem. Must precede the generic arm below —
            # this is a subclass of it.
            _requeue_rate_limited(req, exc.retry_after, now, cred=cred)
            return
        except ExternalSourceError as exc:
            # Transient (5xx / timeout): keep the last-good cache and retire this
            # attempt. The user (or the next poll) re-triggers; the cooldown keeps
            # the retry cadence sane. No data is lost.
            _record_failed_pull(cred, SYNC_REASON_UNREACHABLE, now)
            _mark_dead(req, f"unreachable: {type(exc).__name__}")
            logger.info(
                "external_sync: source unreachable for user=%s source=%s (%s)",
                req.user_id,
                req.source,
                type(exc).__name__,
            )
            return

        stored = _apply_pull(req.user_id, req.source, result.items, now)

        # Successful pull: stamp the connection with its outcome and retire the row.
        cred.last_used_at = now
        _set_connection_status(
            cred,
            STATUS_CONNECTED,
            last_sync=_successful_outcome(result, stored, now),
            extra_save_fields=["last_used_at"],
        )
        req.status = ExternalSyncRequestStatus.DONE
        req.last_error = ""
        req.save(update_fields=["status", "last_error"])


def _apply_pull(
    user_id: int,
    source: str,
    items: list[ExternalWorkItemDTO],
    now: datetime,
) -> int:
    """Upsert the fetched DTOs and soft-remove anything that vanished.

    Items are already sanitized (field caps + URL scheme) at the registry
    boundary. Capped at :data:`CACHE_ITEM_CAP` per (user, source). An
    ``external_id`` no longer returned by a *successful* pull is soft-removed
    (``is_stale=True``) — never hard-deleted here — so a transient partial
    response can never wipe the list (ADR-0097 §5).

    Returns:
        How many rows this pull actually stored (after the cap and after
        duplicate ``external_id``s collapse) — the "showing the first N" the
        owner is told about, so the number they see is the number that landed
        rather than the number the provider sent (#2925).
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
    return len(seen)


def _iso_z(value: datetime) -> str:
    """Serialize a timestamp the way DRF does, so one object has one spelling.

    ``config`` is a JSON column, so ``at`` is stored as a string and DRF's
    ``DateTimeField.to_representation`` passes a ``str`` straight through. Its
    sibling ``last_synced_at`` is a real ``DateTimeField`` and renders as
    ``…Z``, so a bare ``isoformat()`` would put ``…+00:00`` and ``…Z`` in the
    same response object. Both are valid RFC 3339 and no client breaks on it —
    it is just two spellings of one thing in one payload, which is the kind of
    inconsistency an integrator has to write a special case for.
    """
    return value.isoformat().replace("+00:00", "Z")


def _successful_outcome(result: ExternalFetchResult, stored: int, now: datetime) -> dict[str, Any]:
    """Describe a completed pull for ``config["last_sync"]`` (#2925).

    The truncation decision, in priority order, because each rung is a stronger
    claim than the next:

    1. The cache cap bit — more DTOs came back than we were willing to store.
       Tested against :data:`CACHE_ITEM_CAP` rather than ``stored < fetched``,
       because ``stored`` counts *distinct* ``external_id``s: a page containing a
       duplicate satisfies ``stored < fetched`` with no cap anywhere near, which
       would tell an owner their complete list is partial. De-duplication is not
       truncation.
    2. The provider reported a ``total`` larger than what we stored. Exact.
    3. No total, but the page came back **full**. A guess, and the weakest rung:
       a user with exactly ``page_size`` assigned items is indistinguishable from
       one with more. It is the conservative direction — over-reporting "there
       may be more" costs a line of UI, while under-reporting is the silent
       truncation this issue exists to end.

    ``total_available`` stays ``None`` when the source did not report one. The web
    must render that as "the first N" without a denominator rather than inventing
    a total — ``None`` here means *unknown*, never *zero*.
    """
    fetched = len(result.items)
    total = result.total_available
    if fetched > CACHE_ITEM_CAP:
        truncated = True
    elif total is not None:
        truncated = total > stored
    else:
        truncated = result.page_size is not None and fetched >= result.page_size
    return {
        "at": _iso_z(now),
        "ok": True,
        "reason": "",
        "fetched": fetched,
        "stored": stored,
        "total_available": total,
        "truncated": truncated,
    }


def _failed_outcome(reason: str, now: datetime) -> dict[str, Any]:
    """Describe a failed pull for ``config["last_sync"]`` (#2925).

    Counts are zero rather than absent so the shape is uniform for every reader —
    a failure did not store anything, and the last-good cache the owner is still
    being served is described by the *previous* successful outcome, not this one.
    ``reason`` is a :data:`SYNC_FAILURE_REASONS` token; see that constant for why
    it is never a formatted message.
    """
    return {
        "at": _iso_z(now),
        "ok": False,
        "reason": reason,
        "fetched": 0,
        "stored": 0,
        "total_available": None,
        "truncated": False,
    }


def _merge_config(
    cred: IntegrationCredential,
    updates: dict[str, Any],
    *,
    extra_save_fields: list[str] | None = None,
) -> None:
    """Merge keys into the credential's ``config`` under a row lock.

    ``config`` is one JSON column holding several independently-owned keys: the
    owner writes ``{jql, project_keys, account_email, deployment}`` from the
    connect wizard, and this worker writes ``{status, last_sync}``. A save from
    either side rewrites the **whole** column, so writing from the snapshot
    ``cred`` was loaded with — before an outbound fetch that can take seconds —
    silently reverts anything the owner changed while the pull was in flight.

    That is not a cosmetic lost update. ``project_keys`` is ANDed into the JQL
    (#2888) precisely so the filter narrows what leaves the provider, so reverting
    it *widens* the next pull past what the owner selected; and reinstating a
    stale ``status`` re-shows "Reconnect" on a connection the owner just repaired.

    So: re-read the row ``SELECT … FOR UPDATE`` immediately before the write, and
    merge only this module's own keys onto whatever is there now. The lock is
    taken *after* the fetch, never across it, so a slow provider cannot hold it.
    A row deleted mid-pull (the owner disconnected) is a no-op rather than a
    resurrection.
    """
    fresh = IntegrationCredential.objects.select_for_update().filter(pk=cred.pk).first()
    if fresh is None:
        return
    config = dict(fresh.config or {})
    config.update(updates)
    fresh.config = config
    # Fields the caller already set on its own instance (``last_used_at``) have to
    # be carried onto the locked row, which was loaded before they were assigned.
    for field in extra_save_fields or []:
        setattr(fresh, field, getattr(cred, field))
    fresh.save(update_fields=["config", *(extra_save_fields or [])])
    # Keep the caller's instance consistent with what was persisted, so a later
    # read off ``cred`` in the same call does not see the pre-merge snapshot.
    cred.config = config


def _record_failed_pull(cred: IntegrationCredential, reason: str, now: datetime) -> None:
    """Stamp a failure onto ``config["last_sync"]`` without touching ``status``.

    Used by the failure paths that deliberately leave the connection lifecycle
    alone — an unreachable host or an unreadable ciphertext is not ``auth_failed``
    and must not send the owner to re-issue a working token. The outcome is still
    recorded, because "connected, last synced 5 minutes ago" reading identically
    whether the last pull worked or not is the defect (#2925).
    """
    _merge_config(cred, {"last_sync": _failed_outcome(reason, now)})


def _set_connection_status(
    cred: IntegrationCredential,
    status: str,
    *,
    last_sync: dict[str, Any] | None = None,
    extra_save_fields: list[str] | None = None,
) -> None:
    """Write ``config["status"]`` on the credential row (the connection lifecycle).

    ``config`` is the ADR-0097 §2 reuse of ``IntegrationCredential`` — the
    connection's ``{account_email, jql, project_keys, status, last_sync}`` live
    there. Only ``status``, an optional ``last_sync`` outcome, and any
    ``extra_save_fields`` the caller already set are persisted — see
    :func:`_merge_config` for why the other keys are merged rather than rewritten.
    """
    updates: dict[str, Any] = {"status": status}
    if last_sync is not None:
        updates["last_sync"] = last_sync
    _merge_config(cred, updates, extra_save_fields=extra_save_fields)


def _requeue_rate_limited(
    req: ExternalSyncRequest,
    retry_after: float | None,
    now: datetime,
    *,
    cred: IntegrationCredential | None = None,
) -> None:
    """Put a rate-limited pull back in the PENDING pool behind a retry clock.

    ``Retry-After`` wins when the source sent a usable one; otherwise a default
    backoff applies. Either way the value is clamped to
    :data:`_RATE_LIMIT_MAX_BACKOFF` so a hostile or clock-skewed header cannot park
    the pull indefinitely.

    The row goes back to PENDING rather than staying DISPATCHED because PENDING is
    what the drain re-dispatches. That is safe against the partial-unique
    ``one pending per (user, source)`` constraint: this row *is* that connection's
    live pull — anything else that wanted one adopted it while it was in flight.

    Once the attempt budget is spent the row retires DEAD, so a source that 429s
    forever cannot cycle forever. That is not a permanent give-up: the owner's next
    manual refresh writes a fresh row.

    Only that terminal give-up is recorded as a failed outcome on the connection
    (#2925). A re-queue is not an outcome — the pull is still in flight, and
    writing "last pull: rate limited" for a request that succeeds forty seconds
    later would show the owner a failure that did not happen.
    """
    req.attempt_count += 1
    if req.attempt_count >= _MAX_RATE_LIMIT_ATTEMPTS:
        if cred is not None:
            _record_failed_pull(cred, SYNC_REASON_RATE_LIMITED, now)
        _mark_dead(req, f"rate_limited: retry budget spent after {req.attempt_count} attempt(s)")
        logger.info(
            "external_sync: rate-limit budget spent for user=%s source=%s",
            req.user_id,
            req.source,
        )
        return

    backoff = _RATE_LIMIT_DEFAULT_BACKOFF
    if retry_after is not None:
        backoff = timedelta(seconds=retry_after)
    backoff = min(backoff, _RATE_LIMIT_MAX_BACKOFF)

    req.status = ExternalSyncRequestStatus.PENDING
    req.next_attempt_at = now + backoff
    req.celery_task_id = ""
    req.dispatched_at = None
    req.last_error = f"rate_limited: retrying in {int(backoff.total_seconds())}s"[:512]
    req.save(
        update_fields=[
            "status",
            "next_attempt_at",
            "attempt_count",
            "celery_task_id",
            "dispatched_at",
            "last_error",
        ]
    )
    logger.info(
        "external_sync: rate limited for user=%s source=%s — re-queued in %ss (attempt %d)",
        req.user_id,
        req.source,
        int(backoff.total_seconds()),
        req.attempt_count,
    )


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
        ).filter(
            # A rate-limited row carries the clock the source itself gave us;
            # re-dispatching before it would just earn another 429 (#2924). Null
            # is the ordinary case and means "eligible now", so this narrows
            # nothing for any row that was never rate-limited.
            models.Q(next_attempt_at__isnull=True) | models.Q(next_attempt_at__lte=now)
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
    ``poll_enabled: true`` and it is in neither ``auth_failed`` nor
    ``invalid_filter``. With no UI toggle yet this task is a wired-but-dormant hook
    — it fans out zero pulls today.
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
    # credential: poll_enabled must be truthy and the connection must be in
    # neither auth_failed nor invalid_filter — the two states a retry cannot clear
    # without the user reconnecting, so polling them just burns a pull per tick.
    # The Python re-check below is belt-and-suspenders for the rare config shapes
    # a JSON lookup can't express (e.g. poll_enabled stored as a string).
    # ``.iterator()` keeps memory flat if the opted-in set ever grows.
    blocked_statuses = (STATUS_AUTH_FAILED, STATUS_INVALID_FILTER)
    candidates = (
        IntegrationCredential.objects.filter(provider__in=source_keys, config__poll_enabled=True)
        .exclude(config__status__in=blocked_statuses)
        .iterator()
    )
    queued = 0
    for cred in candidates:
        config = cred.config or {}
        if not config.get("poll_enabled"):
            continue
        if config.get("status") in blocked_statuses:
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
