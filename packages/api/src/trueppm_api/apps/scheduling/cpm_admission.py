"""Admission control for CPM passes run inside a request (#4657).

The schedule derivation, the driving chain and the program schedule each run a
full ``schedule()`` pass on the request thread, in the same process that serves
WebSockets. Their per-user throttles bound each account, not the process: enough
users at once could occupy every worker thread with CPM. This is the per-process
bound, the same shape as :mod:`.mc_admission` but with its own slot pool so a
running simulation does not make a derivation wait, or the reverse.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager

from django.conf import settings
from rest_framework import status
from rest_framework.response import Response

# A pass is well under a second at the supported size, so a short wait rides out an
# ordinary burst while keeping a queued request far from any ingress timeout.
CPM_SLOT_WAIT_SECONDS = 5.0

CPM_BUSY_RETRY_AFTER_SECONDS = 2

_slot_lock = threading.Lock()
_slot_semaphore: threading.BoundedSemaphore | None = None
_slot_semaphore_size: int | None = None


def _semaphore() -> threading.BoundedSemaphore | None:
    """The process-wide CPM slot pool, (re)built only when the setting changes."""
    global _slot_semaphore, _slot_semaphore_size
    size: int | None = getattr(settings, "CPM_ON_READ_MAX_CONCURRENT", None)
    if size is None:
        return None
    with _slot_lock:
        if _slot_semaphore is None or _slot_semaphore_size != size:
            _slot_semaphore = threading.BoundedSemaphore(max(1, size))
            _slot_semaphore_size = size
        return _slot_semaphore


@contextmanager
def cpm_slot() -> Iterator[bool]:
    """Hold one of this process's ``CPM_ON_READ_MAX_CONCURRENT`` CPM slots.

    Yields ``True`` once a slot is held, or ``False`` if none freed up within
    :data:`CPM_SLOT_WAIT_SECONDS`; the caller then returns
    :func:`cpm_busy_response` without computing.
    """
    sem = _semaphore()
    if sem is None:
        yield True
        return
    acquired = sem.acquire(timeout=CPM_SLOT_WAIT_SECONDS)
    try:
        yield acquired
    finally:
        if acquired:
            sem.release()


def cpm_busy_response() -> Response:
    """503 returned when no CPM slot frees up within the wait window."""
    msg = (
        "The server is already computing its maximum number of concurrent "
        "schedules. Retry in a few seconds."
    )
    return Response(
        {"code": "schedule_busy", "detail": msg},
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
        headers={"Retry-After": str(CPM_BUSY_RETRY_AFTER_SECONDS)},
    )
