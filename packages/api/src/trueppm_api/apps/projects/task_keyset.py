"""Opt-in keyset (seek) pagination for ``GET /api/v1/tasks/`` (#3381).

Page-number pagination pays an ``OFFSET`` on every page: Postgres still builds,
and evaluates the per-task subquery annotations for, every row it then discards.
A whole-project Schedule load is ``ceil(N / page_size)`` such pages, so that term
sums to O(N²) — measured at 1.8 s for one ``OFFSET 31800`` page at 32,000 tasks
against 24 ms at ``OFFSET 0``. Keyset pagination replaces the offset with a
``WHERE (sort key) > (last row's sort key)`` seek, so every page costs what page 1
costs.

Why not DRF's ``CursorPagination``: it filters on the *leading* ordering field
only (the trap ``MeWorkPagination`` documents), and the Schedule's order is the
compound ``Task.Meta.ordering`` — ``(wbs_sort_key(wbs_path), name)`` — not ``id``.
The Schedule cannot switch to an ``id`` order and sort client-side: it numbers
WBS siblings by their index in the array the server returns
(``computeWbsCodes``), so the page order *is* the displayed order. This module
therefore seeks on the full row ``(wbs_sort_key(wbs_path), name, id)``; ``id`` is
appended only to make the order total, so it changes nothing but the relative
order of rows that tie on both other columns.

``wbs_sort_key`` is ``STRICT``, so a row with a ``NULL`` (or empty) ``wbs_path``
has a ``NULL`` key, and ``ASC`` sorts those last. A SQL row comparison involving a
``NULL`` is itself ``NULL``, so the seek predicate handles that tail explicitly
rather than letting those rows silently drop off the end of the walk.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from dataclasses import dataclass
from typing import Any

from django.contrib.postgres.fields import ArrayField
from django.db.models import BooleanField, F, Func, QuerySet, TextField
from rest_framework.exceptions import ValidationError
from rest_framework.request import Request

from trueppm_api.apps.projects.wbs_paths import WbsSortKey

#: Query parameter that opts a list request into keyset mode.
KEYSET_MODE_PARAM = "pagination"
KEYSET_MODE_VALUE = "keyset"
#: Query parameter carrying the opaque position token for pages after the first.
CURSOR_PARAM = "cursor"

#: Annotation carrying each row's sort key, read back to build the next cursor.
#: Named so it cannot collide with a serializer field.
_KEY_ANNOTATION = "_keyset_wbs_sort_key"

# Bounds on a decoded cursor. A real key has one element per WBS level, so 64
# levels and 512-character labels are far past anything ``ltree`` will hold in
# practice; the point is to refuse a crafted token before it reaches SQL as a
# multi-megabyte array parameter.
_MAX_KEY_LEVELS = 64
_MAX_LABEL_LENGTH = 512
_MAX_TOKEN_LENGTH = 16_384


def keyset_requested(request: Request) -> bool:
    """Whether the caller opted into keyset mode with ``?pagination=keyset``."""
    return request.query_params.get(KEYSET_MODE_PARAM) == KEYSET_MODE_VALUE


@dataclass(frozen=True)
class TaskCursor:
    """The sort-key position of the last row a page returned."""

    # A tuple, not a list: Django hashes an expression's constructor arguments
    # (``BaseExpression.identity``), and a frozen dataclass holding a list is
    # unhashable.
    key: tuple[str, ...] | None
    name: str
    id: uuid.UUID

    def encode(self) -> str:
        key = list(self.key) if self.key is not None else None
        payload = {"k": key, "n": self.name, "i": str(self.id)}
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def decode(cls, token: str) -> TaskCursor:
        """Parse a token, raising a 400 for anything this module did not mint.

        A cursor is a position, not a credential: every filter and the caller's
        RBAC scoping still apply to the seek, so a forged but well-formed cursor
        can only move the caller's own walk. The checks here exist to turn a
        malformed one into a 400 instead of a database error.
        """
        invalid = ValidationError({CURSOR_PARAM: ["Invalid cursor."]})
        if len(token) > _MAX_TOKEN_LENGTH:
            raise invalid
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
            payload = json.loads(raw)
        except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
            raise invalid from exc
        if not isinstance(payload, dict):
            raise invalid
        key, name, ident = payload.get("k"), payload.get("n"), payload.get("i")
        if key is not None and not (
            isinstance(key, list)
            and 0 < len(key) <= _MAX_KEY_LEVELS
            and all(isinstance(label, str) and len(label) <= _MAX_LABEL_LENGTH for label in key)
        ):
            raise invalid
        if not isinstance(name, str) or not isinstance(ident, str):
            raise invalid
        try:
            parsed_id = uuid.UUID(ident)
        except ValueError as exc:
            raise invalid from exc
        return cls(key=tuple(key) if key is not None else None, name=name, id=parsed_id)


# The SQL below is assembled only from compiled column expressions and fixed
# operators; every cursor value travels as a bound parameter.
# nosemgrep: extends-custom-expression
class _SeekAfter(Func):
    """``WHERE`` predicate selecting rows strictly after ``cursor`` in keyset order.

    Emitted as a row-value comparison so Postgres can use the
    ``(project, wbs_sort_key(wbs_path), name)`` index (``task_proj_wbs_sort_idx``)
    as an index condition on the ``(key, name)`` prefix instead of filtering a
    scan from the first row. A row whose key is ``NULL`` compares as ``NULL`` and
    is excluded, so the NULL-key tail is not reached through this predicate from
    a non-NULL cursor: ``keyset_page`` tops the page up with a separate query
    instead. Folding ``OR key IS NULL`` in here would cost the index condition on
    every page to serve a tail only the last page reaches.
    """

    output_field = BooleanField()

    def __init__(self, cursor: TaskCursor) -> None:
        super().__init__(WbsSortKey("wbs_path"), F("name"), F("id"))
        self.cursor = cursor

    def as_sql(  # type: ignore[override]
        self, compiler: Any, connection: Any, **extra_context: Any
    ) -> tuple[str, list[Any]]:
        compiled = [compiler.compile(expr) for expr in self.get_source_expressions()]
        (key_sql, key_params), (name_sql, name_params), (id_sql, id_params) = compiled
        column_params = [*key_params, *name_params, *id_params]
        cursor = self.cursor
        if cursor.key is None:
            # Already inside the NULL-key tail: only later NULL-key rows remain.
            sql = f"({key_sql} IS NULL AND ({name_sql}, {id_sql}) > (%s, %s::uuid))"
            return sql, [*column_params, cursor.name, str(cursor.id)]
        sql = f"(({key_sql}, {name_sql}, {id_sql}) > (%s::text[], %s, %s::uuid))"
        return sql, [*column_params, list(cursor.key), cursor.name, str(cursor.id)]


def keyset_page(
    queryset: QuerySet[Any, Any], cursor: TaskCursor | None, page_size: int
) -> tuple[list[Any], TaskCursor | None]:
    """Return one page in keyset order and the cursor for the page after it.

    Fetches ``page_size + 1`` rows so the existence of a next page is known
    without a ``COUNT`` — the whole point is that no request scans past its own
    page.
    """
    qs = queryset.annotate(
        **{_KEY_ANNOTATION: WbsSortKey("wbs_path", output_field=ArrayField(TextField()))}
    ).order_by(WbsSortKey("wbs_path").asc(), "name", "id")
    want = page_size + 1
    if cursor is None:
        rows = list(qs[:want])
    else:
        rows = list(qs.filter(_SeekAfter(cursor))[:want])
        if cursor.key is not None and len(rows) < want:
            # The non-NULL keys ran out on this page: continue into the NULL-key
            # tail, which ``ASC`` orders after them (see ``_SeekAfter``).
            null_tail = qs.filter(**{f"{_KEY_ANNOTATION}__isnull": True})
            rows += list(null_tail[: want - len(rows)])
    if len(rows) <= page_size:
        return rows, None
    rows = rows[:page_size]
    last = rows[-1]
    key = getattr(last, _KEY_ANNOTATION)
    return rows, TaskCursor(key=tuple(key) if key is not None else None, name=last.name, id=last.id)
