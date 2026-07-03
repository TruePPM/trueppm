"""Cursor pagination for the offline delta pull (#1013).

The delta pull (:class:`~trueppm_api.apps.sync.views.ProjectSyncView`) must not
materialize an entire project into one unbounded JSON response on a cold start
(``since=0``): a large project blows past the "500-task delta < 3s" mobile
target. This module pages the delta so each response carries at most
``page_size`` rows across all synced collections, and the client loops until the
cursor is exhausted.

Why a compound ``(table_index, server_version, id)`` keyset and not a scalar
``server_version`` ceiling
--------------------------------------------------------------------------------
``server_version`` is a **per-row edit counter**, not a global monotonic
sequence: every row starts at ``1`` on INSERT and increments by one on each save
of *that* row (see ``VersionedModel.save``). Many rows therefore share the same
version — on a cold start every freshly created row has ``server_version = 1``.
A scalar "return ``since < server_version <= ceiling``, then ``next_since =
ceiling``" cursor cannot bound page size in that case: to avoid splitting a
version (which would silently drop rows) it must return *all* rows at the
boundary version, and on cold start that is the whole project. It is either
unbounded or lossy.

The fix keys the cursor on the pair ``(server_version, id)`` within each
collection. ``id`` is a globally unique UUID, so ``(server_version, id)`` is a
**total order** even when every row shares a version — a page boundary can fall
between two rows of the same version without ambiguity. Collections are drained
in a fixed order, so each collection is a contiguous, non-overlapping segment of
the global stream. The result: **no row is skipped and no row is duplicated**
across pages, and every page is bounded by ``page_size``.

Concurrency during a multi-page pull is safe because ``server_version`` only ever
increases: a row edited mid-pull moves *forward* in ``(server_version, id)``
order, so a not-yet-reached row is delivered later and an already-delivered row
is re-delivered under WatermelonDB upsert semantics — never lost.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from django.db.models import Q
from rest_framework.exceptions import ValidationError

if TYPE_CHECKING:
    from django.db.models import QuerySet

# A single sync source: (collection_name, base_queryset, serializer_class). The
# base queryset already carries the project scope, the ``server_version__gt=since``
# floor, and any RBAC/visibility filters (retro visibility, per-user time entries).
SyncSource = tuple[str, "QuerySet[Any]", Any]

# Callable that splits a materialized row list into WatermelonDB
# created/updated/deleted buckets (``ProjectSyncView._collect``).
CollectFn = Callable[[list[Any], Any], dict[str, Any]]


@dataclass(frozen=True)
class SyncCursor:
    """Position in the global ``(table_index, server_version, id)`` delta stream.

    ``row_id`` is ``None`` for a *fresh-table* cursor (resume at the top of
    ``sources[index]`` with only the ``since`` floor applied) and a UUID string
    for an *intra-table* cursor (resume strictly after ``(version, row_id)``
    within ``sources[index]``). Keeping the two cases distinct avoids emitting a
    ``id > ''`` predicate that Postgres would reject when casting to ``uuid``.
    """

    index: int
    version: int
    row_id: str | None

    def encode(self) -> str:
        """Serialize to an opaque, URL-safe token for the response envelope."""
        raw = json.dumps(
            {"i": self.index, "v": self.version, "id": self.row_id},
            separators=(",", ":"),
        )
        return base64.urlsafe_b64encode(raw.encode()).decode()

    @classmethod
    def decode(cls, token: str) -> SyncCursor:
        """Parse a client-supplied cursor token, rejecting anything malformed.

        The token is client-controlled, so every field is validated: a tampered
        or truncated token yields a 400 rather than an unhandled 500.
        """
        try:
            raw = base64.urlsafe_b64decode(token.encode())
            data = json.loads(raw)
            index = int(data["i"])
            version = int(data["v"])
            row_id = data["id"]
        except (binascii.Error, ValueError, KeyError, TypeError, UnicodeDecodeError) as err:
            raise ValidationError({"cursor": "Malformed pagination cursor."}) from err
        if index < 0 or version < 0 or (row_id is not None and not isinstance(row_id, str)):
            raise ValidationError({"cursor": "Malformed pagination cursor."})
        return cls(index=index, version=version, row_id=row_id)


def paginate_changes(
    sources: list[SyncSource],
    *,
    cursor: SyncCursor | None,
    page_size: int,
    collect: CollectFn,
) -> tuple[dict[str, Any], SyncCursor | None, bool]:
    """Return one page of the delta: ``(changes, next_cursor, has_more)``.

    ``changes`` always contains every collection key (empty buckets for
    collections this page does not touch) so the response shape is stable across
    pages. ``next_cursor`` is ``None`` exactly when the delta is fully drained
    (``has_more`` is then ``False``); the client loops until then.

    Each source is fetched ``ORDER BY server_version, id`` with ``LIMIT
    page_size + 1`` (the extra row detects whether the collection still has more
    beyond this page). Collections are drained in list order; a collection is
    fully drained before the next one is touched, so the pages partition the
    global stream without gaps or overlap.
    """
    changes: dict[str, Any] = {
        name: {"created": [], "updated": [], "deleted": []} for name, _, _ in sources
    }
    remaining = page_size
    start = cursor.index if cursor is not None else 0

    for i in range(start, len(sources)):
        name, qs, serializer_class = sources[i]

        # Intra-table resume: seek strictly past (version, row_id). A fresh-table
        # cursor (row_id is None) or the very first page applies only the
        # ``server_version__gt=since`` floor already baked into ``qs``.
        if cursor is not None and i == cursor.index and cursor.row_id is not None:
            qs = qs.filter(
                Q(server_version__gt=cursor.version)
                | Q(server_version=cursor.version, id__gt=cursor.row_id)
            )

        rows = list(qs.order_by("server_version", "id")[: remaining + 1])
        has_more_in_source = len(rows) > remaining
        rows = rows[:remaining]
        if rows:
            changes[name] = collect(rows, serializer_class)
        remaining -= len(rows)

        if has_more_in_source:
            # This collection still has rows; stop with an intra-table cursor.
            last = rows[-1]
            return changes, SyncCursor(i, last.server_version, str(last.pk)), True

        if remaining == 0:
            # Page is exactly full and this collection is drained. Resume at the
            # top of the next collection, or finish if this was the last one.
            if i + 1 < len(sources):
                return changes, SyncCursor(i + 1, 0, None), True
            return changes, None, False

    # Every remaining collection drained within the budget — delta exhausted.
    return changes, None, False
