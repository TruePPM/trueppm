"""Idempotent Celery task decorator with Redis distributed locking.

Provides ``@idempotent_task`` — a drop-in wrapper around ``@shared_task`` that
acquires a Redis lock before execution, extends it automatically via a daemon
thread, and handles contention via one of three strategies: retry, skip, or queue.

See ADR-0018 for design rationale.
"""

from __future__ import annotations

import functools
import logging
import threading
import uuid
from collections.abc import Callable
from typing import Any, Literal

import redis as redis_lib
from celery import shared_task
from django.conf import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lock key registry — catches duplicate templates at import time
# ---------------------------------------------------------------------------

_lock_key_registry: set[str] = set()


def _register_lock_key(template: str) -> None:
    """Register a lock key template; raise on duplicates."""
    if template in _lock_key_registry:
        raise ValueError(
            f"Duplicate idempotent_task lock_key_template: {template!r}. "
            "Two tasks sharing a lock key will silently deadlock each other."
        )
    _lock_key_registry.add(template)


# ---------------------------------------------------------------------------
# Lua scripts for atomic lock operations
# ---------------------------------------------------------------------------

# Compare-and-extend: only extend if the lock value matches our token.
# KEYS[1] = lock key, ARGV[1] = token, ARGV[2] = new TTL in seconds.
_EXTEND_SCRIPT = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return 0
"""

# Compare-and-delete: only delete if the lock value matches our token.
# KEYS[1] = lock key, ARGV[1] = token.
_RELEASE_SCRIPT = """
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
"""


# ---------------------------------------------------------------------------
# Lock extension thread
# ---------------------------------------------------------------------------


class _LockExtender:
    """Daemon thread that periodically extends a Redis lock."""

    def __init__(
        self,
        redis_client: redis_lib.Redis,
        lock_key: str,
        token: str,
        ttl: int,
        interval: int,
    ) -> None:
        self._redis = redis_client
        self._lock_key = lock_key
        self._token = token
        self._ttl = ttl
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name=f"lock-extend-{lock_key}"
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval + 1)

    def _run(self) -> None:
        extend = self._redis.register_script(_EXTEND_SCRIPT)
        while not self._stop.wait(timeout=self._interval):
            try:
                result = extend(keys=[self._lock_key], args=[self._token, self._ttl])
                if not result:
                    logger.warning(
                        "Lock extension failed for %s — lock was stolen or expired",
                        self._lock_key,
                    )
                    break
            except Exception:
                logger.exception("Lock extension error for %s", self._lock_key)
                break


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

ContentionStrategy = Literal["retry", "skip", "queue"]


def idempotent_task(
    lock_key_template: str,
    lock_ttl: int = 300,
    lock_extend_interval: int | None = None,
    on_contention: ContentionStrategy = "retry",
    queue_countdown: int = 10,
    max_queue_attempts: int = 5,
    **task_kwargs: Any,
) -> Callable[..., Any]:
    """Decorator that wraps a function as a Celery shared_task with Redis locking.

    Args:
        lock_key_template: Format string for the Redis lock key. Positional task
            args are available as ``{0}``, ``{1}``, etc. A static string (no
            placeholders) creates a global lock.
        lock_ttl: Lock TTL in seconds. The lock is auto-extended so this is a
            safety net, not a deadline.
        lock_extend_interval: Seconds between extension attempts. Defaults to
            ``lock_ttl // 3``.
        on_contention: What to do when the lock is held:
            - ``"retry"`` — re-queue with exponential backoff (Celery retry).
            - ``"skip"`` — log and discard the execution.
            - ``"queue"`` — re-queue with a fixed countdown.
        queue_countdown: Fixed countdown in seconds for ``on_contention="queue"``.
        max_queue_attempts: Max re-queue attempts for ``on_contention="queue"``
            (tracked via ``x-requeue-count`` header).
        **task_kwargs: Passed through to ``@shared_task`` (e.g. ``bind``,
            ``autoretry_for``, ``max_retries``).
    """
    if lock_extend_interval is None:
        lock_extend_interval = lock_ttl // 3

    _register_lock_key(lock_key_template)

    # Force bind=True so the wrapper receives the Celery task instance as self.
    task_kwargs["bind"] = True

    def decorator(fn: Callable[..., Any]) -> Any:
        @functools.wraps(fn)
        def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
            redis_client: redis_lib.Redis = redis_lib.from_url(settings.REDIS_URL)
            lock_key = lock_key_template.format(*args)
            token = uuid.uuid4().hex

            # Attempt to acquire an exclusive lock.
            acquired = redis_client.set(lock_key, token, nx=True, ex=lock_ttl)
            if not acquired:
                return _handle_contention(
                    self,
                    args,
                    kwargs,
                    on_contention,
                    lock_key,
                    queue_countdown,
                    max_queue_attempts,
                )

            # Start the lock extension thread.
            extender = _LockExtender(
                redis_client,
                lock_key,
                token,
                lock_ttl,
                lock_extend_interval,
            )
            extender.start()
            try:
                return fn(self, *args, **kwargs)
            finally:
                extender.stop()
                # Release only if we still own the lock (compare-and-delete).
                release = redis_client.register_script(_RELEASE_SCRIPT)
                release(keys=[lock_key], args=[token])

        return shared_task(**task_kwargs)(wrapper)

    return decorator


def _handle_contention(
    self: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    strategy: ContentionStrategy,
    lock_key: str,
    queue_countdown: int,
    max_queue_attempts: int,
) -> None:
    """Handle lock contention according to the chosen strategy."""
    if strategy == "skip":
        logger.info(
            "idempotent_task(%s): lock held on %s, skipping",
            self.name,
            lock_key,
        )
        return

    if strategy == "queue":
        # Track re-queue count via task headers to prevent infinite loops.
        headers = (self.request.headers or {}) if hasattr(self.request, "headers") else {}
        requeue_count = int(headers.get("x-requeue-count", 0))
        if requeue_count >= max_queue_attempts:
            logger.warning(
                "idempotent_task(%s): max re-queue attempts (%d) reached for %s, dropping",
                self.name,
                max_queue_attempts,
                lock_key,
            )
            return
        logger.info(
            "idempotent_task(%s): lock held on %s, re-queuing in %ds (attempt %d/%d)",
            self.name,
            lock_key,
            queue_countdown,
            requeue_count + 1,
            max_queue_attempts,
        )
        self.apply_async(
            args=list(args),
            kwargs=kwargs,
            countdown=queue_countdown,
            headers={"x-requeue-count": requeue_count + 1},
        )
        return

    # strategy == "retry" — use Celery's built-in retry with backoff.
    logger.info(
        "idempotent_task(%s): lock held on %s, retrying via Celery",
        self.name,
        lock_key,
    )
    raise self.retry(countdown=queue_countdown, max_retries=self.max_retries)
