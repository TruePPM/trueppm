"""Cursor pagination for the offline delta pull (#1013).

The delta pull (:class:`~trueppm_api.apps.sync.views.ProjectSyncView`) must not
materialize an entire project into one unbounded JSON response on a cold start
(``since=0``): a large project blows past the "500-task delta < 3s" mobile
target. This module pages the delta so each response carries at most
``page_size`` rows across all synced collections, and the client loops until the
cursor is exhausted.

Why a compound ``(table_index, version, id)`` keyset and not a scalar ceiling
--------------------------------------------------------------------------------
Rows share version values. Under the project sync cursor (``sync_seq``,
ADR-0686) every row written in one batch draws the same value, and the program
slice (ADR-0747) allocates from one installation-wide counter, so ties are rarer
there but still possible across a single transaction's writes. A
scalar "return ``since < version <= ceiling``, then ``next_since = ceiling``"
cursor cannot bound page size in either case: to avoid splitting a version (which
would silently drop rows) it must return *all* rows at the boundary version, and
on a cold start that is the whole project. It is either unbounded or lossy.

The fix keys the cursor on the pair ``(version, id)`` within each collection.
``id`` is a globally unique UUID, so ``(version, id)`` is a **total order** even
when every row shares a version — a page boundary can fall between two rows of
the same version without ambiguity. Collections are drained in a fixed order, so
each collection is a contiguous, non-overlapping segment of the global stream.
The result: **no row is skipped and no row is duplicated** across pages, and
every page is bounded by ``page_size``.

Concurrency during a multi-page pull is safe because the version field only ever
increases: a row edited mid-pull moves *forward* in ``(version, id)`` order, so a
not-yet-reached row is delivered later and an already-delivered row is
re-delivered under WatermelonDB upsert semantics — never lost.

That argument only holds for rows the drain can still *reach*. A row written into
a collection the cursor has already passed moves forward in a stream nobody is
reading any more, so the drain cannot deliver it — the client's next ``since``
has to stay low enough to catch it on the following pull. The watermark is
therefore a property of the **pull session**, not of the request: it is computed
once on the first (cursor-less) request, carried in the cursor as ``w``, and
echoed unchanged on every continuation page (#2568). Recomputing it per request
published a checkpoint above rows the session never returned, and the client
adopting the last page's value skipped them permanently.

The field is caller-supplied (``version_field``) rather than hard-coded, but both
sync endpoints now pass ``sync_seq``: the project pull draws it from its project's
sequence (ADR-0686) and the program pull from the installation-wide program
sequence (ADR-0747). The parameter stays because the ordering column and the
sources' ``__gt=since`` floor must agree, and making that agreement explicit at
each call site is what stops the two drifting apart — the program pull used to
default to ``server_version`` and carried the ordering defect #2498 fixed.
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
# base queryset already carries the project scope, the ``<version_field>__gt=since``
# floor, and any RBAC/visibility filters (retro visibility, per-user time entries).
SyncSource = tuple[str, "QuerySet[Any]", Any]

# Callable that splits a materialized row list into WatermelonDB
# created/updated/deleted buckets (``ProjectSyncView._collect``).
CollectFn = Callable[[list[Any], Any], dict[str, Any]]


@dataclass(frozen=True)
class SyncCursor:
    """Position in the global ``(table_index, version, id)`` delta stream.

    ``row_id`` is ``None`` for a *fresh-table* cursor (resume at the top of
    ``sources[index]`` with only the ``since`` floor applied) and a UUID string
    for an *intra-table* cursor (resume strictly after ``(version, row_id)``
    within ``sources[index]``). Keeping the two cases distinct avoids emitting a
    ``id > ''`` predicate that Postgres would reject when casting to ``uuid``.

    ``watermark`` pins the checkpoint the whole drain must report as
    ``timestamp`` (#2568). It is the session's state, not the page's: the view
    computes it once on the cursor-less first request and thereafter reads it
    back off the cursor instead of re-querying, so the client can never adopt a
    checkpoint above a row the session had already paged past.
    """

    index: int
    version: int
    row_id: str | None
    watermark: int

    def encode(self) -> str:
        """Serialize to an opaque, URL-safe token for the response envelope."""
        raw = json.dumps(
            {"i": self.index, "v": self.version, "id": self.row_id, "w": self.watermark},
            separators=(",", ":"),
        )
        return base64.urlsafe_b64encode(raw.encode()).decode()

    @classmethod
    def decode(cls, token: str) -> SyncCursor:
        """Parse a client-supplied cursor token, rejecting anything malformed.

        The token is client-controlled, so every field is validated: a tampered
        or truncated token yields a 400 rather than an unhandled 500. ``w`` is
        validated exactly like ``i`` and ``v`` — required, integral, and
        non-negative — because the view returns it verbatim as the checkpoint the
        client adopts, which makes a junk value a data-loss vector rather than a
        cosmetic one.

        ``OverflowError`` is caught alongside the rest because Python's ``json``
        accepts the non-standard literals ``Infinity``, ``-Infinity`` and
        overflowing floats such as ``1e400``, and ``int()`` rejects them with an
        ``ArithmeticError`` rather than the ``ValueError`` the other bad inputs
        raise. Without it a one-token request reached an unhandled 500 — and this
        endpoint is deliberately unthrottled (``get_throttles`` returns ``[]``
        for GET), so that was a free error-log amplifier for any member.

        A token minted before ``w`` existed carries no such key and is rejected
        as malformed. That costs a drain straddling the deploy one 400; the
        client restarts it at the same unchanged ``since`` and loses nothing.
        """
        try:
            raw = base64.urlsafe_b64decode(token.encode())
            data = json.loads(raw)
            index = int(data["i"])
            version = int(data["v"])
            row_id = data["id"]
            watermark = int(data["w"])
        except (
            binascii.Error,
            ValueError,
            KeyError,
            TypeError,
            OverflowError,
            UnicodeDecodeError,
        ) as err:
            raise ValidationError({"cursor": "Malformed pagination cursor."}) from err
        if (
            index < 0
            or version < 0
            or watermark < 0
            or (row_id is not None and not isinstance(row_id, str))
        ):
            raise ValidationError({"cursor": "Malformed pagination cursor."})
        return cls(index=index, version=version, row_id=row_id, watermark=watermark)


def paginate_changes(
    sources: list[SyncSource],
    *,
    cursor: SyncCursor | None,
    page_size: int,
    collect: CollectFn,
    watermark: int,
    version_field: str = "server_version",
) -> tuple[dict[str, Any], SyncCursor | None, bool]:
    """Return one page of the delta: ``(changes, next_cursor, has_more)``.

    ``changes`` always contains every collection key (empty buckets for
    collections this page does not touch) so the response shape is stable across
    pages. ``next_cursor`` is ``None`` exactly when the delta is fully drained
    (``has_more`` is then ``False``); the client loops until then.

    Each source is fetched ``ORDER BY <version_field>, id`` with ``LIMIT
    page_size + 1`` (the extra row detects whether the collection still has more
    beyond this page). Collections are drained in list order; a collection is
    fully drained before the next one is touched, so the pages partition the
    global stream without gaps or overlap.

    ``version_field`` must be the same column the caller used for its
    ``__gt=since`` floor — mixing the two (ordering on ``sync_seq`` while
    filtering ``server_version``) would page a stream the floor does not bound.

    ``watermark`` is stamped unchanged into every emitted cursor so the caller can
    read the session checkpoint back off a continuation cursor rather than
    recomputing it per page (#2568). It is threaded through here, not derived
    here, because only the caller knows which sequence its ``since`` is drawn
    from.
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
        # ``<version_field>__gt=since`` floor already baked into ``qs``.
        if cursor is not None and i == cursor.index and cursor.row_id is not None:
            qs = qs.filter(
                Q(**{f"{version_field}__gt": cursor.version})
                | Q(**{version_field: cursor.version, "id__gt": cursor.row_id})
            )

        rows = list(qs.order_by(version_field, "id")[: remaining + 1])
        has_more_in_source = len(rows) > remaining
        rows = rows[:remaining]
        if rows:
            changes[name] = collect(rows, serializer_class)
        remaining -= len(rows)

        if has_more_in_source:
            # This collection still has rows; stop with an intra-table cursor.
            last = rows[-1]
            return (
                changes,
                SyncCursor(i, getattr(last, version_field), str(last.pk), watermark),
                True,
            )

        if remaining == 0:
            # Page is exactly full and this collection is drained. Resume at the
            # top of the next collection, or finish if this was the last one.
            if i + 1 < len(sources):
                return changes, SyncCursor(i + 1, 0, None, watermark), True
            return changes, None, False

    # Every remaining collection drained within the budget — delta exhausted.
    return changes, None, False
