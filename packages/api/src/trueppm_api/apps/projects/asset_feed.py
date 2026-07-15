"""Unified project/program Assets aggregator (ADR-0215, #971).

A read-only aggregator that merges two heterogeneous task-nested sources into one
newest-first ``AssetItem`` feed:

- ``TaskAttachment`` (``apps.projects.models``) — a file XOR an external URL.
- ``TaskLink`` (``apps.integrations.models``) — a git/cloud-file external link
  (#970/#571), where ``custom_title``, ``labels``, ``provider``, ``status`` and
  ``preview_type`` live.

Why a Python k-way merge and not a SQL ``UNION``
------------------------------------------------
The two tables live in different apps with dissimilar columns (one is a
``VersionedModel``, one is not), so a single ``UNION`` would force a
lowest-common-denominator projection and a brittle second hydrate pass. Instead
each source is filtered + ordered ``created_at DESC, id DESC`` at the DB with a
bounded ``LIMIT page_size + 1`` scan, and the two bounded lists are merge-sorted
in Python on the shared total-order key. Worst case loads ``2 × page_size`` rows
per page — bounded regardless of program size, and with **no silent truncation**
(the CLAUDE.md "no silent caps" rule forbids a ``LIMIT 500``-style cap).

Why a ``(created_at, rank, id)`` keyset
---------------------------------------
``created_at`` can collide **across** the two tables and ``id`` (a random UUIDv4)
is only unique **within** a table, so a timestamp-only cursor is lossy on a
cross-table tie. The strict total order is the triple ``(created_at DESC,
rank ASC, id DESC)``: ``rank`` (a fixed integer per source — file 0, link 1)
disambiguates two rows in *different* tables sharing an exact ``created_at``, and
``id`` disambiguates two rows in the *same* table. This partitions the merged
stream into pages with no gap and no duplicate — the same guarantee the unified
changelog (``history/changelog.py``) documents for its cross-table cursor. UUID
ordering is consistent between Postgres (byte compare) and Python
(``UUID.int``), so the DB keyset predicate and the in-memory sort agree.

Permission model (ADR-0215): both sources gate on the parent project's
membership (``IsProjectMember``) via their ``project_id`` property — there is no
finer object-level ACL. The endpoints pass the already-authorized project id set,
so this module trusts ``project_ids`` and never re-checks membership.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from django.db.models import Q
from django.urls import reverse
from rest_framework import serializers
from rest_framework.exceptions import ValidationError

if TYPE_CHECKING:
    from collections.abc import Iterable

    from django.db.models import QuerySet

KIND_FILE = "file"
KIND_LINK = "link"
KINDS: frozenset[str] = frozenset({KIND_FILE, KIND_LINK})

# Fixed source ranks — encoded in the cursor and MUST stay stable (see module
# docstring). File sorts before link on an exact ``created_at`` tie.
_RANK_FILE = 0
_RANK_LINK = 1

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
# DoS guard: a pathological ``q`` cannot force an unbounded trigram/ILIKE scan.
MAX_Q_LEN = 100


@dataclass(frozen=True)
class AssetCursor:
    """Position in the ``(created_at, rank, id)`` total order (ADR-0215).

    Encoded as an opaque, URL-safe base64 JSON token, mirroring the changelog and
    sync cursors. The token is client-controlled, so every field is validated on
    decode — a tampered or truncated token yields a 400, not an unhandled 500.
    """

    created_at: datetime
    rank: int
    id: uuid.UUID

    def encode(self) -> str:
        raw = json.dumps(
            {"d": self.created_at.isoformat(), "r": self.rank, "id": str(self.id)},
            separators=(",", ":"),
        )
        return base64.urlsafe_b64encode(raw.encode()).decode()

    @classmethod
    def decode(cls, token: str) -> AssetCursor:
        from django.utils.dateparse import parse_datetime

        try:
            raw = base64.urlsafe_b64decode(token.encode())
            data = json.loads(raw)
            parsed = parse_datetime(str(data["d"]))
            if parsed is None:
                raise ValueError("bad date")
            rank = int(data["r"])
            row_id = uuid.UUID(str(data["id"]))
        except (binascii.Error, ValueError, KeyError, TypeError, UnicodeDecodeError) as err:
            raise ValidationError({"cursor": "Malformed pagination cursor."}) from err
        if rank not in (_RANK_FILE, _RANK_LINK):
            raise ValidationError({"cursor": "Malformed pagination cursor."})
        return cls(created_at=parsed, rank=rank, id=row_id)


def _cursor_filter(rank: int, cursor: AssetCursor) -> Q:
    """Keyset predicate resuming strictly *after* ``cursor`` for one source.

    "After" = older in the newest-first total order. With the source's fixed
    ``rank`` known as a constant, the cross-table tie-break collapses to a simple
    per-source predicate (identical derivation to ``changelog._cursor_filter``):

    * rank > cursor.rank  → every same-``created_at`` row is older  → ``<= cd``
    * rank == cursor.rank → tie-break within the table on ``id``
    * rank < cursor.rank  → same-``created_at`` rows here are newer  → already sent
    """
    cd = cursor.created_at
    if rank > cursor.rank:
        return Q(created_at__lte=cd)
    if rank == cursor.rank:
        return Q(created_at__lt=cd) | Q(created_at=cd, id__lt=cursor.id)
    return Q(created_at__lt=cd)


def _sources_for_kind(kind: str | None) -> list[str]:
    if kind == KIND_FILE:
        return [KIND_FILE]
    if kind == KIND_LINK:
        return [KIND_LINK]
    return [KIND_FILE, KIND_LINK]


def _file_queryset(
    project_ids: Iterable[Any], *, q: str | None, assignee_id: Any | None = None
) -> QuerySet[Any]:
    """DB-filtered, N+1-safe ``TaskAttachment`` source queryset (ADR-0215 §2)."""
    from trueppm_api.apps.projects.models import TaskAttachment

    qs = TaskAttachment.objects.filter(
        is_deleted=False, task__project_id__in=list(project_ids)
    ).select_related("task", "task__project", "uploaded_by")
    if assignee_id is not None:
        # The ``mine`` filter (ADR-0428) — assets on tasks assigned to the caller.
        # Scoped to ``Task.assignee`` only, matching ``MeWorkView`` semantics; there
        # is no ``?user=`` escape hatch, so it can never widen to another user.
        qs = qs.filter(task__assignee_id=assignee_id)
    if q:
        # ``q`` is a shared filter — applied to BOTH sources so it never silently
        # drops matches from one side (ADR-0215 risk). A file's searchable text is
        # its display title candidates (external_title / file_name) plus its URL.
        qs = qs.filter(
            Q(external_title__icontains=q)
            | Q(file_name__icontains=q)
            | Q(external_url__icontains=q)
        )
    return qs


def _link_queryset(
    project_ids: Iterable[Any],
    *,
    q: str | None,
    label: str | None,
    provider: str | None,
    assignee_id: Any | None = None,
) -> QuerySet[Any]:
    """DB-filtered, N+1-safe ``TaskLink`` source queryset (ADR-0215 §2)."""
    from trueppm_api.apps.integrations.models import TaskLink

    qs = TaskLink.objects.filter(
        is_deleted=False, task__project_id__in=list(project_ids)
    ).select_related("task", "task__project")
    if assignee_id is not None:
        # The ``mine`` filter (ADR-0428) — see ``_file_queryset``. Same assignee-only
        # scoping applied to the link source so ``mine`` never drops one side.
        qs = qs.filter(task__assignee_id=assignee_id)
    if q:
        # Same shared ``q`` filter, mapped to a link's searchable text: its display
        # title candidates (custom_title / title) plus the URL.
        qs = qs.filter(Q(custom_title__icontains=q) | Q(title__icontains=q) | Q(url__icontains=q))
    if label:
        # ArrayField membership — an exact label, not a substring.
        qs = qs.filter(labels__contains=[label])
    if provider:
        qs = qs.filter(provider=provider)
    return qs


def _display_name(user: Any) -> str:
    full = f"{getattr(user, 'first_name', '')} {getattr(user, 'last_name', '')}".strip()
    return full or getattr(user, "username", "") or ""


def _file_item(row: Any) -> dict[str, Any]:
    """Serialize one ``TaskAttachment`` into the unified ``AssetItem`` shape."""
    is_external = bool(row.external_url)
    # Files never expose the raw storage path; the download is produced on demand
    # via the existing signed-url action (reused, not re-implemented). External-URL
    # attachments surface their URL directly and have no download target.
    download_url: str | None = None
    if not is_external:
        download_url = reverse(
            "project-task-attachments-signed-url",
            kwargs={
                "project_pk": str(row.task.project_id),
                "task_pk": str(row.task_id),
                "pk": str(row.id),
            },
        )
    uploaded_by = row.uploaded_by
    return {
        "kind": KIND_FILE,
        "id": str(row.id),
        "title": row.external_title or row.file_name,
        "url": row.external_url or None,
        "download_url": download_url,
        "provider": None,
        "status": None,
        "preview_type": None,
        "labels": [],
        "task": {"id": str(row.task_id), "name": row.task.name},
        "added_by": (
            {"id": str(uploaded_by.pk), "display_name": _display_name(uploaded_by)}
            if uploaded_by is not None
            else None
        ),
        "added_at": row.created_at,
    }


def _link_item(row: Any) -> dict[str, Any]:
    """Serialize one ``TaskLink`` into the unified ``AssetItem`` shape."""
    return {
        "kind": KIND_LINK,
        "id": str(row.id),
        # Display precedence mirrors the task drawer: custom_title → title → url.
        "title": row.custom_title or row.title or row.url,
        "url": row.url,
        "download_url": None,
        "provider": row.provider,
        "status": row.status,
        "preview_type": row.preview_type or None,
        "labels": list(row.labels or []),
        "task": {"id": str(row.task_id), "name": row.task.name},
        # TaskLink has no uploader column — accountability is deferred to the
        # Enterprise audit trail (unlike TaskAttachment.uploaded_by).
        "added_by": None,
        "added_at": row.created_at,
    }


def build_asset_feed(
    project_ids: Iterable[Any],
    *,
    kind: str | None = None,
    label: str | None = None,
    provider: str | None = None,
    q: str | None = None,
    assignee_id: Any | None = None,
    cursor: AssetCursor | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> tuple[list[dict[str, Any]], AssetCursor | None]:
    """Build one newest-first page of the unified Assets feed (ADR-0215).

    Args:
        project_ids: the readable project ids to aggregate over. An empty
            iterable yields an empty page (the program and workspace endpoints
            pass the caller's readable projects — none means an empty list,
            never a leak).
        kind: restrict to ``"file"`` or ``"link"`` (default: both).
        label: restrict links to those carrying this exact label (link-only).
        provider: restrict links to this provider (link-only).
        q: case-insensitive substring matched against each source's title/url.
            Applied to **both** sources so a match is never dropped from one side.
        assignee_id: the ``mine`` filter (ADR-0428) — restrict to assets on tasks
            assigned to this user id. Applied to **both** sources. ``None`` means
            no assignee restriction.
        cursor: keyset position; ``None`` starts at the newest row.
        page_size: rows per page (clamped to ``[1, MAX_PAGE_SIZE]``).

    Returns:
        ``(items, next_cursor)``. ``next_cursor`` is ``None`` when the stream is
        exhausted. Each item is a plain dict in the ``AssetItem`` shape.
    """
    page_size = max(1, min(int(page_size), MAX_PAGE_SIZE))
    project_ids = list(project_ids)
    if not project_ids:
        return [], None

    q = (q or "").strip()[:MAX_Q_LEN] or None
    label = (label or "").strip() or None
    provider = (provider or "").strip() or None

    # (sort_key, rank, item) where sort_key = (created_at, rank, id_uuid).
    entries: list[tuple[tuple[datetime, int, uuid.UUID], dict[str, Any]]] = []
    for source in _sources_for_kind(kind):
        # ``label`` and ``provider`` are link-only concepts — a file can never
        # carry either, so a filter on them excludes the file source entirely
        # (skip the query rather than run one that returns nothing).
        if source == KIND_FILE and (label or provider):
            continue

        if source == KIND_FILE:
            qs = _file_queryset(project_ids, q=q, assignee_id=assignee_id)
            rank = _RANK_FILE
            to_item = _file_item
        else:
            qs = _link_queryset(
                project_ids, q=q, label=label, provider=provider, assignee_id=assignee_id
            )
            rank = _RANK_LINK
            to_item = _link_item

        if cursor is not None:
            qs = qs.filter(_cursor_filter(rank, cursor))

        rows = list(qs.order_by("-created_at", "-id")[: page_size + 1])
        for row in rows:
            entries.append(((row.created_at, rank, row.id), to_item(row)))

    # Newest-first total order: created_at DESC, rank ASC, id DESC. ``-rank`` and
    # ``id.int`` compose into a single tuple sorted descending.
    entries.sort(key=lambda item: (item[0][0], -item[0][1], item[0][2].int), reverse=True)

    has_more = len(entries) > page_size
    page = entries[:page_size]
    next_cursor: AssetCursor | None = None
    if has_more and page:
        key = page[-1][0]
        next_cursor = AssetCursor(created_at=key[0], rank=key[1], id=key[2])

    return [item for _, item in page], next_cursor


# ---------------------------------------------------------------------------
# Serializers (read-only — the aggregator already merged/ordered/shaped the rows;
# these render the dicts and document the shape for OpenAPI).
# ---------------------------------------------------------------------------


class AssetTaskRefSerializer(serializers.Serializer[Any]):
    """The owning task reference on an asset row (click-through target)."""

    id = serializers.CharField()
    name = serializers.CharField()


class AssetUserSerializer(serializers.Serializer[Any]):
    """Minimal actor representation — who added the asset (files only)."""

    id = serializers.CharField()
    display_name = serializers.CharField()


class AssetItemSerializer(serializers.Serializer[Any]):
    """One unified asset — a file (``TaskAttachment``) or a link (``TaskLink``).

    The instance is a plain dict from :func:`build_asset_feed`. Link-only fields
    (``provider``/``status``/``preview_type``) are null on files; ``labels`` is
    ``[]`` on files; ``download_url`` is the signed-url action target on stored
    files and null on external-URL attachments and links; ``added_by`` is null on
    links (``TaskLink`` has no uploader).
    """

    kind = serializers.ChoiceField(choices=[KIND_FILE, KIND_LINK])
    id = serializers.CharField()
    title = serializers.CharField(allow_blank=True)
    url = serializers.CharField(allow_null=True)
    download_url = serializers.CharField(allow_null=True)
    provider = serializers.CharField(allow_null=True)
    status = serializers.CharField(allow_null=True)
    preview_type = serializers.CharField(allow_null=True)
    labels = serializers.ListField(child=serializers.CharField())
    task = AssetTaskRefSerializer()
    added_by = AssetUserSerializer(allow_null=True)
    added_at = serializers.DateTimeField()


class AssetFeedResponseSerializer(serializers.Serializer[Any]):
    """Response envelope for the unified Assets feed (ADR-0215)."""

    results = AssetItemSerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True)
