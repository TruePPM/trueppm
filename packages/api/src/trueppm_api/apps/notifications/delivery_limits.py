"""Shared outbound-mail delivery limits for every send path (#2860, #2887).

``WorkspaceEmailSettings.max_recipients`` and ``throttle_per_min`` are workspace-wide
operator controls, but #2860 wired them into ``notifications.drain_notification_emails``
only. Three other paths mail on the same transport and consulted neither, so a throttle
dialed down to protect a rate-limited relay was still exposed to a bulk-invite burst
(#2887 item 3). This module is the one place both limits are interpreted, so every path
draws from the same budget:

* :func:`per_tick_cap` — how many queued rows *one* drain tick may claim. This is what
  ``max_recipients`` means since #2860: rows per drain tick, **not** addresses per
  message (every message TruePPM sends has exactly one recipient and no Cc/Bcc).
* :func:`reserve_send_budget` — a shared per-minute ceiling across *all* queued paths.
  A drain reserves before it queries and returns the unused remainder, so the
  notification drain and the invite drain cannot each spend the whole minute's
  allowance.
* :func:`note_unbudgeted_send` — the transactional one-off sends (password reset,
  export-ready) *charge* the budget without being refused by it. Refusing a
  password-reset mail because a batch of invites spent the minute would be a worse
  failure than briefly exceeding a soft rate, so those sends always go; charging them
  means the queued drains yield to them rather than stacking on top.

Two deliberate fail-safes, because a rate limit that can stop mail permanently is worse
than one that occasionally over-delivers:

* A per-tick share that integer-divides to zero is raised to one. ``throttle_per_min=1``
  would otherwise never drain a single row.
* If the shared-budget cache round-trip raises at all, the reservation is granted in
  full and a warning is logged. The budget is an advisory smoothing control; a Valkey
  blip must not wedge the mail queue.

The budget lives in the Django cache (Valkey in production) rather than the database
because it is per-minute, disposable, and read/written by every worker: a durable table
would add write amplification to buy durability nothing here needs. Its key is the
wall-clock minute, so it self-expires and needs no reset path.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

# Rows one drain tick may claim when the operator has set no ``max_recipients``.
# Also the hard ceiling on ``max_recipients`` itself — the tick runs under a 25 s
# soft time limit, so an unbounded batch would be killed mid-flight, re-queueing
# rows whose sends already happened. The serializer rejects a larger value rather
# than silently clamping it (#2887 item 2).
EMAIL_MAX_BATCH_SIZE = 50

# Back-compat alias — ``notifications.tasks.EMAIL_BATCH_SIZE`` was the public name
# of this constant before it moved here.
EMAIL_BATCH_SIZE = EMAIL_MAX_BATCH_SIZE

_BUDGET_KEY_PREFIX = "trueppm:email:budget"
# Three minutes: long enough that a tick which starts at :59.9 still finds its own
# minute's counter, short enough that stale keys never accumulate.
_BUDGET_TTL_SECONDS = 180


def beat_ticks_per_minute(task_name: str, *, default: int = 2) -> int:
    """Ticks per minute for ``task_name``, read from ``CELERY_BEAT_SCHEDULE``.

    ``throttle_per_min`` is a per-*minute* rate, but a drain can only enforce a
    per-*tick* cap, so the two are related by the beat cadence. That divisor used to
    be a hand-copied ``EMAIL_DRAIN_TICKS_PER_MINUTE = 2`` with a "keep in step" comment
    and nothing enforcing it — change the beat schedule and ``throttle_per_min``
    silently starts meaning something else (#2887 item 4). Deriving it from the
    schedule removes the second copy entirely.

    A cadence slower than once a minute yields ``1``, which *under*-delivers (the tick
    may spend a full minute's allowance but runs less often than once a minute). That
    is the safe direction for a rate limit.

    Args:
        task_name: The dotted Celery task name as it appears in the schedule entry.
        default: Returned when the task is absent from the schedule or its entry uses
            a form with no fixed second count (a ``crontab``).

    Returns:
        Ticks per minute, never below 1.
    """
    schedule_map: dict[str, Any] = getattr(settings, "CELERY_BEAT_SCHEDULE", {}) or {}
    for entry in schedule_map.values():
        if str(entry.get("task", "")) != task_name:
            continue
        schedule = entry.get("schedule")
        if isinstance(schedule, timedelta):
            seconds = schedule.total_seconds()
        elif isinstance(schedule, (int, float)) and not isinstance(schedule, bool):
            seconds = float(schedule)
        else:
            return max(1, default)
        if seconds <= 0:
            return max(1, default)
        return max(1, int(60 // seconds))
    return max(1, default)


def per_tick_cap(
    email_settings: Any,
    *,
    ticks_per_minute: int,
    fallback: int = EMAIL_MAX_BATCH_SIZE,
) -> int:
    """Rows this tick may claim, honoring both operator delivery limits.

    ``max_recipients`` caps a single tick outright; ``throttle_per_min`` is divided by
    the beat cadence to get this tick's share. The tighter of the two wins, and
    ``fallback`` bounds both so no configuration can hand one tick an unbounded batch.

    Args:
        email_settings: Any object exposing ``max_recipients`` / ``throttle_per_min``
            (the ``WorkspaceEmailSettings`` singleton in production).
        ticks_per_minute: From :func:`beat_ticks_per_minute` for the calling drain.
        fallback: Cap applied when the operator has set no ``max_recipients``.

    Returns:
        A positive row count. A sub-tick throttle still yields 1 — see the module
        docstring on why zero is the worse failure.
    """
    caps = [fallback]
    max_recipients = int(getattr(email_settings, "max_recipients", 0) or 0)
    if max_recipients > 0:
        caps.append(max_recipients)
    throttle_per_min = int(getattr(email_settings, "throttle_per_min", 0) or 0)
    if throttle_per_min > 0:
        caps.append(max(1, throttle_per_min // max(1, ticks_per_minute)))
    return min(caps)


def _budget_key(now: Any = None) -> str:
    """Cache key for the current wall-clock minute's shared send budget."""
    stamp = (now or timezone.now()).strftime("%Y%m%d%H%M")
    return f"{_BUDGET_KEY_PREFIX}:{stamp}"


class SendBudget:
    """A reservation against the shared per-minute outbound-mail budget.

    ``granted`` is how many messages the caller may attempt. A caller that attempts
    fewer must hand the remainder back with :meth:`release`, or the unspent
    reservation starves the other paths for the rest of the minute.
    """

    __slots__ = ("_key", "granted")

    def __init__(self, granted: int, key: str | None = None) -> None:
        self.granted = granted
        self._key = key

    def release(self, unused: int) -> None:
        """Return ``unused`` unspent slots to the minute's budget."""
        if unused <= 0 or self._key is None:
            return
        _adjust(self._key, -unused)


def _adjust(key: str, delta: int) -> int | None:
    """Add ``delta`` to ``key``, returning the new value or None if the cache balked.

    ``cache.incr``/``decr`` raise ``ValueError`` when the key has expired between the
    ``add`` and the increment, which is a normal minute-boundary race rather than a
    fault — hence the broad catch. Never propagates: a cache fault must not stop mail.
    """
    from django.core.cache import cache

    try:
        if delta >= 0:
            return int(cache.incr(key, delta))
        return int(cache.decr(key, -delta))
    except Exception:
        logger.warning(
            "email delivery budget: cache adjust failed (key=%s delta=%d) — "
            "the per-minute throttle is not being enforced this tick",
            key,
            delta,
        )
        return None


def reserve_send_budget(limit_per_min: int, requested: int) -> SendBudget:
    """Reserve up to ``requested`` slots from the shared per-minute send budget.

    Args:
        limit_per_min: ``throttle_per_min``. ``0`` (the shipped default) means no
            throttle, and the request is granted in full without touching the cache.
        requested: How many messages the caller intends to attempt this tick.

    Returns:
        A :class:`SendBudget` whose ``granted`` may be less than ``requested`` — or
        zero, when another path has already spent the minute. Zero is safe: the key is
        the wall-clock minute, so the next minute grants again without any reset.
    """
    if requested <= 0:
        return SendBudget(0)
    if limit_per_min <= 0:
        return SendBudget(requested)

    from django.core.cache import cache

    key = _budget_key()
    try:
        cache.add(key, 0, _BUDGET_TTL_SECONDS)
    except Exception:
        logger.warning(
            "email delivery budget: cache unavailable — granting %d unthrottled", requested
        )
        return SendBudget(requested)

    spent = _adjust(key, requested)
    if spent is None:
        return SendBudget(requested)

    overshoot = spent - limit_per_min
    if overshoot <= 0:
        return SendBudget(requested, key=key)
    granted = max(0, requested - overshoot)
    _adjust(key, -(requested - granted))
    return SendBudget(granted, key=key if granted else None)


def note_unbudgeted_send(limit_per_min: int, count: int = 1) -> None:
    """Charge a transactional one-off send against the minute's budget.

    Unlike :func:`reserve_send_budget` this never refuses — see the module docstring.
    Charging it means the queued drains see a smaller remaining allowance, so a burst
    of password resets tightens the drains instead of stacking on top of them.
    """
    if limit_per_min <= 0 or count <= 0:
        return
    from django.core.cache import cache

    key = _budget_key()
    try:
        cache.add(key, 0, _BUDGET_TTL_SECONDS)
    except Exception:
        return
    _adjust(key, count)


def workspace_throttle_per_min() -> int:
    """Read ``throttle_per_min`` off the singleton, or 0 if it cannot be read.

    Convenience for the synchronous send paths, which have no settings object in hand
    and must never fail because a delivery *limit* could not be looked up.
    """
    try:
        from .models import WorkspaceEmailSettings

        return int(WorkspaceEmailSettings.load().throttle_per_min or 0)
    except Exception:  # pragma: no cover — guard, not behavior
        return 0
