"""Unified project changelog aggregator (ADR-0199, #371).

A read-only aggregator that merges the project-scoped ``django-simple-history``
tables into one newest-first "what changed" stream. No new model, no data
migration — every event already has a durable home in a ``Historical*`` table.

Why a Python k-way merge and not a SQL ``UNION``
------------------------------------------------
The nine source tables have heterogeneous columns, so a single ``UNION`` would
force a lowest-common-denominator projection and is brittle against schema
drift. Instead each source is fetched ``ORDER BY history_date DESC, history_id
DESC`` with ``LIMIT page_size + 1`` (a bounded scan — never a query per row),
and the bounded lists are merge-sorted in Python on the global total-order key.

Why a ``(history_date, table_rank, history_id)`` keyset and not ``until``
------------------------------------------------------------------------
``history_date`` is a timestamp and can collide **across** tables; ``history_id``
is only unique **within** a table. A timestamp-only cursor (the ``until`` cursor
of the per-object history and board feeds) is therefore lossy across a cross-table
tie. The strict total order is the triple ``(history_date DESC, table_rank ASC,
history_id DESC)``: ``table_rank`` (a fixed integer per source) disambiguates two
rows in *different* tables sharing an exact ``history_date``, and ``history_id``
disambiguates two rows in the *same* table. This partitions the global stream
into pages with no gap and no duplicate — the same guarantee
``sync/pagination.py`` documents for ``(server_version, id)``.

Permission model (ADR-0199): every source's live GET is ``IsProjectMember``
(Viewer+), so membership is a sufficient row-inclusion gate — there is no
per-user sub-project ACL on any source (TimeEntry and the Retrospective models
carry per-user / team_visibility gates but have **no** ``HistoricalRecords``, so
they cannot appear here). Field redaction reuses the history app's
``_DIFF_EXCLUDED`` (which already drops ``blocked_reason`` per ADR-0124 and the
CPM outputs); ``history_user`` is gated to Owner/Admin via the view's
``hide_user`` context, and the ``user=`` filter is honored only for those callers.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from django.db.models import Q
from rest_framework.exceptions import ValidationError

if TYPE_CHECKING:
    from django.db.models import QuerySet

# django-simple-history ``history_type`` → the changelog's change-type vocabulary.
_HISTORY_TYPE_TO_CHANGE: dict[str, str] = {"+": "created", "~": "updated", "-": "deleted"}
_CHANGE_TO_HISTORY_TYPE: dict[str, str] = {v: k for k, v in _HISTORY_TYPE_TO_CHANGE.items()}

CHANGE_TYPES: frozenset[str] = frozenset(_CHANGE_TO_HISTORY_TYPE)

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


@dataclass(frozen=True)
class ChangelogSource:
    """One historical table wired into the unified changelog.

    ``rank`` is the source's fixed position in the total order — it is encoded in
    the cursor and MUST stay stable (reordering the source list would invalidate
    in-flight opaque cursors, which is acceptable for a short-lived pagination
    token but must be a deliberate change).
    """

    rank: int
    object_type: str
    label_field: str | None  # attribute on the historical row to use as the display label
    label_fallback: str  # used when label_field is None or the value is empty
    project_filter: str  # ORM lookup that scopes the historical rows to a project


def _sources() -> list[ChangelogSource]:
    """The ordered project-scoped historical sources (ADR-0199).

    Program and CeremonyTemplate are deliberately excluded (program-scoped, not
    project-scoped); Workspace is a singleton. TimeEntry and the Retrospective
    models are excluded because they have no ``HistoricalRecords`` table at all.
    """
    return [
        ChangelogSource(0, "task", "name", "Task", "project_id"),
        ChangelogSource(1, "sprint", "name", "Sprint", "project_id"),
        ChangelogSource(2, "risk", "title", "Risk", "project_id"),
        ChangelogSource(3, "dependency", None, "Dependency", "predecessor__project_id"),
        # HistoricalProject's ``pk`` is ``history_id``; the original project's PK
        # lives in the ``id`` column, so the project's own history is scoped by id.
        ChangelogSource(4, "project", "name", "Project", "id"),
        ChangelogSource(5, "task_recurrence", None, "Recurrence rule", "task__project_id"),
        ChangelogSource(6, "guardrail_policy", None, "Guardrail policy", "project_id"),
        ChangelogSource(7, "signal_privacy_policy", None, "Signal privacy policy", "project_id"),
        ChangelogSource(8, "decisions_policy", None, "Decisions policy", "project_id"),
    ]


def object_type_choices() -> list[str]:
    return [s.object_type for s in _sources()]


def _historical_model(object_type: str) -> Any:
    """Return the ``Historical*`` model class for a source's live model."""
    from trueppm_api.apps.projects.models import (
        Dependency,
        Project,
        ProjectDecisionsPolicy,
        ProjectGuardrailPolicy,
        ProjectSignalPrivacyPolicy,
        Risk,
        Sprint,
        Task,
        TaskRecurrenceRule,
    )

    live = {
        "task": Task,
        "sprint": Sprint,
        "risk": Risk,
        "dependency": Dependency,
        "project": Project,
        "task_recurrence": TaskRecurrenceRule,
        "guardrail_policy": ProjectGuardrailPolicy,
        "signal_privacy_policy": ProjectSignalPrivacyPolicy,
        "decisions_policy": ProjectDecisionsPolicy,
    }[object_type]
    # ``history`` is the django-simple-history manager, added dynamically to the
    # model class — not visible to the type checker on the VersionedModel base.
    return live.history.model  # type: ignore[attr-defined]


@dataclass(frozen=True)
class ChangelogCursor:
    """Position in the ``(history_date, table_rank, history_id)`` total order.

    Encoded as an opaque, URL-safe base64 JSON token, mirroring
    :class:`~trueppm_api.apps.sync.pagination.SyncCursor`. The token is
    client-controlled, so every field is validated on decode — a tampered or
    truncated token yields a 400 rather than an unhandled 500.
    """

    history_date: datetime
    rank: int
    history_id: int

    def encode(self) -> str:
        raw = json.dumps(
            {"d": self.history_date.isoformat(), "r": self.rank, "id": self.history_id},
            separators=(",", ":"),
        )
        return base64.urlsafe_b64encode(raw.encode()).decode()

    @classmethod
    def decode(cls, token: str) -> ChangelogCursor:
        from django.utils.dateparse import parse_datetime

        try:
            raw = base64.urlsafe_b64decode(token.encode())
            data = json.loads(raw)
            parsed = parse_datetime(str(data["d"]))
            if parsed is None:
                raise ValueError("bad date")
            rank = int(data["r"])
            history_id = int(data["id"])
        except (binascii.Error, ValueError, KeyError, TypeError, UnicodeDecodeError) as err:
            raise ValidationError({"cursor": "Malformed pagination cursor."}) from err
        if rank < 0:
            raise ValidationError({"cursor": "Malformed pagination cursor."})
        return cls(history_date=parsed, rank=rank, history_id=history_id)


def _cursor_filter(source: ChangelogSource, cursor: ChangelogCursor) -> Q:
    """The keyset predicate that resumes strictly *after* ``cursor`` for one source.

    "After" = older in the newest-first total order. With the source's fixed
    ``rank`` known as a constant, the cross-table tie-break collapses to a simple
    per-source predicate (see the module docstring for the derivation):

    * rank > cursor.rank  → every same-``history_date`` row is older  → ``<= cd``
    * rank == cursor.rank → tie-break within the table on ``history_id``
    * rank < cursor.rank  → same-``history_date`` rows here are newer  → already sent
    """
    cd = cursor.history_date
    if source.rank > cursor.rank:
        return Q(history_date__lte=cd)
    if source.rank == cursor.rank:
        return Q(history_date__lt=cd) | Q(history_date=cd, history_id__lt=cursor.history_id)
    return Q(history_date__lt=cd)


def _label_for(source: ChangelogSource, row: Any) -> str:
    if source.label_field is not None:
        value = getattr(row, source.label_field, None)
        if value:
            return str(value)
    return source.label_fallback


def _object_id_for(source: ChangelogSource, row: Any) -> str:
    """The id used for click-through. Policies point at their project (settings);
    every other source points at the object's own row."""
    if source.object_type in {"guardrail_policy", "signal_privacy_policy", "decisions_policy"}:
        return str(row.project_id)
    return str(row.id)


def build_project_changelog(
    project: Any,
    *,
    diff_fn: Any,
    cursor: ChangelogCursor | None = None,
    since: datetime | None = None,
    object_types: set[str] | None = None,
    change_types: set[str] | None = None,
    user_id: Any = None,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> tuple[list[dict[str, Any]], ChangelogCursor | None]:
    """Build one newest-first page of the unified changelog (ADR-0199).

    Args:
        project: the project whose history is aggregated.
        diff_fn: ``history.views._compute_diffs`` — injected to avoid an import
            cycle. It already applies the ``_DIFF_EXCLUDED`` field-redaction set
            (CPM outputs, sync internals, and ``blocked_reason`` per ADR-0124).
        cursor: keyset position; ``None`` starts at the newest row.
        since: inclusive lower bound on ``history_date``.
        object_types: restrict to these source ``object_type`` keys (default all).
        change_types: restrict to these change types (``created``/``updated``/``deleted``).
        user_id: restrict to a single ``history_user`` (honored by the caller only
            for Owner/Admin — see the view).
        page_size: rows per page (clamped to ``[1, MAX_PAGE_SIZE]``).

    Returns:
        ``(entries, next_cursor)``. ``next_cursor`` is ``None`` when the stream is
        exhausted. Each entry is a plain dict — see :func:`_row_to_entry`.
    """
    page_size = max(1, min(int(page_size), MAX_PAGE_SIZE))
    wanted_types = {s.strip() for s in object_types} if object_types else None
    history_types: set[str] | None = (
        {_CHANGE_TO_HISTORY_TYPE[c] for c in change_types} if change_types else None
    )

    entries: list[tuple[tuple[datetime, int, int], dict[str, Any]]] = []
    for source in _sources():
        if wanted_types is not None and source.object_type not in wanted_types:
            continue

        model = _historical_model(source.object_type)
        qs: QuerySet[Any] = model.objects.filter(**{source.project_filter: project.pk})
        if since is not None:
            qs = qs.filter(history_date__gte=since)
        if history_types is not None:
            qs = qs.filter(history_type__in=history_types)
        if user_id is not None:
            qs = qs.filter(history_user_id=user_id)
        if cursor is not None:
            qs = qs.filter(_cursor_filter(source, cursor))

        rows = list(
            qs.select_related("history_user").order_by("-history_date", "-history_id")[
                : page_size + 1
            ]
        )
        if not rows:
            continue

        # Diffs are paired within this source's batch (same model), so the
        # ``history_id``-keyed dict never collides across tables.
        diffs = diff_fn(rows, all_records=rows)
        for row in rows:
            entry = _row_to_entry(source, row, diffs)
            if entry is None:
                continue
            entries.append(((row.history_date, source.rank, row.history_id), entry))

    # Newest-first total order: history_date DESC, rank ASC, history_id DESC.
    entries.sort(key=lambda item: (item[0][0], -item[0][1], item[0][2]), reverse=True)

    has_more = len(entries) > page_size
    page = entries[:page_size]
    next_cursor: ChangelogCursor | None = None
    if has_more and page:
        key = page[-1][0]
        next_cursor = ChangelogCursor(history_date=key[0], rank=key[1], history_id=key[2])

    return [entry for _, entry in page], next_cursor


def _row_to_entry(
    source: ChangelogSource,
    row: Any,
    diffs: dict[int, list[dict[str, Any]]],
) -> dict[str, Any] | None:
    """Turn one historical row into a changelog entry, or ``None`` to drop it.

    An ``updated`` row whose entire diff is excluded fields (a pure CPM/sync bump)
    carries no team-readable signal and is dropped — matching the per-object
    history views. ``created`` / ``deleted`` rows are always kept (the change type
    is itself the signal) and carry an empty ``changes`` list to keep the feed
    scannable.
    """
    change_type = _HISTORY_TYPE_TO_CHANGE.get(row.history_type, "updated")
    changes: list[dict[str, Any]] = []
    if change_type == "updated":
        changes = diffs.get(row.history_id, [])
        if not changes:
            return None

    return {
        "id": f"{source.object_type}:{row.history_id}",
        "object_type": source.object_type,
        "object_id": _object_id_for(source, row),
        "object_label": _label_for(source, row),
        "change_type": change_type,
        "history_date": row.history_date,
        "history_user": row.history_user,
        "changes": changes,
    }
