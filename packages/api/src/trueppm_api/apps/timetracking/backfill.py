"""Frozen data-migration helpers for the timetracking app.

Each function here is a **snapshot** of logic a migration runs, copied rather than
imported from live modules (``review``, ``services``) so a later change to those
modules cannot rewrite what an old migration does. Deliberately not kept in sync.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta
from typing import Any


def backfill_submission_digests(submission_model: Any, entry_model: Any) -> int:
    """Stamp ``entries_digest`` on submitted weeks that predate timesheet review.

    A week submitted before ADR-1495 carries ``status='submitted'`` (the column's
    default) and an empty digest, so approve would compare the live entries against
    ``""`` and refuse it forever with a misleading "changed since submit". Hashing the
    entries as they stand at upgrade is the honest baseline: nothing guarded the week
    before, so what is there now is what the reviewer will see and approve.

    The hash is a frozen copy of ``review.week_digest`` as of migration 0006. Returns
    the number of rows stamped.
    """
    stamped = 0
    rows = submission_model.objects.filter(status="submitted", entries_digest="")
    for sub in rows.iterator():
        entries = (
            entry_model.objects.filter(
                user_id=sub.user_id,
                is_deleted=False,
                # engine-boundary-ok: calendar bookkeeping, not schedule math
                entry_date__range=(sub.week_start, sub.week_start + timedelta(days=6)),
            )
            .order_by("id")
            .values_list("id", "task_id", "entry_date", "minutes", "category")
        )
        h = hashlib.sha256()
        for r in entries:
            h.update("|".join(str(v) for v in r).encode())
            h.update(b"\n")
        sub.entries_digest = h.hexdigest()
        sub.save(update_fields=["entries_digest"])
        stamped += 1
    return stamped
