"""Resume cursor for Beat sweeps that can overrun their Celery soft time limit.

A sweep that walks every item in a fixed ``order_by`` and is cut off by
``SoftTimeLimitExceeded`` would reprocess the same head every run and never reach
the tail (#4420). Persisting the last completed item's pk lets the next run start
just after it and wrap around, so successive runs together cover every item.

Why the cache and not a model: the cursor is disposable scheduling state. Losing
it only restarts the sweep from the head, which is the pre-#4420 behavior, so no
table or migration is warranted. It is best-effort: a cache outage must never
fail the sweep it is meant to help.

Cursors compare as ``str(pk)``. That is correct for UUID primary keys (the
canonical lowercase dashed form sorts bytewise like PostgreSQL's ``uuid``); do not
use this for integer pks.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import TypeVar

from django.core.cache import cache

logger = logging.getLogger(__name__)

T = TypeVar("T")

_CURSOR_TTL_SECONDS = 7 * 24 * 3600


def _key(sweep: str) -> str:
    return f"sweep-cursor:{sweep}"


def rotate_after_cursor(sweep: str, items: Sequence[T], key: Callable[[T], object]) -> list[T]:
    """Return ``items`` (already sorted by ``key``) starting after the saved cursor.

    Items at or before the cursor are appended at the end so the whole set is
    still visited. With no cursor, or a cursor past the end, the order is unchanged.

    ``key`` must return a UUID primary key (or its string form): cursors compare as
    ``str(pk)``, which mis-orders integers ("10" < "9"). Raises ``TypeError`` for an
    integer key so a future caller fails loudly instead of silently skipping items.
    """
    if items and isinstance(key(items[0]), int):
        raise TypeError("rotate_after_cursor requires UUID (string-sortable) keys, not int")
    try:
        cursor = cache.get(_key(sweep))
    except Exception:
        logger.warning("sweep cursor read failed for %s", sweep, exc_info=True)
        return list(items)
    if not cursor:
        return list(items)
    start = next((i for i, item in enumerate(items) if str(key(item)) > cursor), len(items))
    if start >= len(items):
        return list(items)
    return list(items[start:]) + list(items[:start])


def save_cursor(sweep: str, last_done_pk: object) -> None:
    """Record the last item a truncated sweep completed."""
    try:
        cache.set(_key(sweep), str(last_done_pk), _CURSOR_TTL_SECONDS)
    except Exception:
        logger.warning("sweep cursor write failed for %s", sweep, exc_info=True)


def clear_cursor(sweep: str) -> None:
    """Drop the cursor after a sweep finishes within its limit."""
    try:
        cache.delete(_key(sweep))
    except Exception:
        logger.warning("sweep cursor clear failed for %s", sweep, exc_info=True)
