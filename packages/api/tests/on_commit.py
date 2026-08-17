"""Savepoint-safe capture of ``transaction.on_commit()`` callbacks (#2945).

Django's ``TestCase.captureOnCommitCallbacks`` — which is also exactly what
pytest-django's ``django_capture_on_commit_callbacks`` fixture hands back — records
``start_count = len(connection.run_on_commit)`` on entry and, on exit, harvests
``run_on_commit[start_count:]``.

That index slice is only correct while the list never *shrinks*.
``BaseDatabaseWrapper.savepoint_rollback()`` removes every entry that was registered
while the savepoint it unwinds was active, so when

- the list is already non-empty at entry (fixtures such as ``project`` and ``webhook``
  create rows through broadcast paths that register callbacks), and
- anything inside the block unwinds a savepoint that owned those earlier entries (a
  caught ``IntegrityError`` in a nested ``atomic()``, a handled DRF exception),

the callback the test cares about is appended at an index *below* ``start_count``. The
slice then comes back empty and the assertion fails as a baffling ``0 == 1`` while the
request under test returned a perfectly clean ``202``. Nothing about it is
deterministic: it only fires when test-shard membership happens to seat the right
neighbour first, which is why it surfaced as a flake on an unrelated MR.

Tracking the *identity* of the entries present at entry removes the dependence on both
the entry state and on the list length being monotonic — anything not seen before is
ours, wherever in the list it landed.

Test modules get this through the ``django_capture_on_commit_callbacks`` fixture, which
``tests/conftest.py`` overrides to return :func:`capture_on_commit_callbacks`. Django
``TestCase`` subclasses, which bypass the fixture system, import it directly and must
use it in place of ``self.captureOnCommitCallbacks``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from django.db import DEFAULT_DB_ALIAS, connections

logger = logging.getLogger(__name__)

__all__ = ["capture_on_commit_callbacks"]


@contextmanager
def capture_on_commit_callbacks(
    *, using: str = DEFAULT_DB_ALIAS, execute: bool = False
) -> Iterator[list[Callable[[], None]]]:
    """Capture callbacks registered inside the block, identified rather than sliced.

    Signature, yielded list, and the ``execute`` re-scan loop (a callback may itself
    register further callbacks) all match Django's, so it is a drop-in replacement.
    """
    connection = connections[using]
    callbacks: list[Callable[[], None]] = []
    # Strong refs, not just ids: a dropped tuple's id() could otherwise be recycled
    # onto a callback registered later in the same block and be mistaken for old.
    seen_entries: list[Any] = list(connection.run_on_commit)
    seen_ids: set[int] = {id(entry) for entry in seen_entries}
    try:
        yield callbacks
    finally:
        while True:
            new_entries = [e for e in connection.run_on_commit if id(e) not in seen_ids]
            if not new_entries:
                break
            seen_entries.extend(new_entries)
            seen_ids.update(id(entry) for entry in new_entries)
            for entry in new_entries:
                # Django 5.2 entries are (savepoint_ids, callback, robust).
                callback, robust = entry[1], entry[2]
                callbacks.append(callback)
                if not execute:
                    continue
                if robust:
                    # Mirrors Django: a robust callback's failure is logged and
                    # swallowed, exactly as it would be on a real commit.
                    try:
                        callback()
                    except Exception as exc:
                        logger.error(
                            "Error calling %s in on_commit() (%s).",
                            callback.__qualname__,
                            exc,
                            exc_info=True,
                        )
                else:
                    callback()
