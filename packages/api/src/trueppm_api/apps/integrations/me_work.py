"""My Work integration side-blocks (ADR-0097 §4, #1422).

Builds the ``external_items`` and ``external_sources`` first-page blocks that
``GET /api/v1/me/work/`` returns, so a contributor sees their read-only Jira
(and future-source) items alongside native TruePPM tasks in one feed.

Kept in the integrations app on purpose: the Apache-2.0 / read-only isolation
invariant (``ExternalWorkItem`` is a personal cache, never a ``Task``, ADR-0097
§2) lives here, and the projects app only calls :func:`me_work_external_blocks`
without ever touching ``ExternalWorkItem`` directly. Distinct from the standalone
``/me/external-items/`` endpoint (``connections.ExternalWorkItemSerializer``),
which predates #1422 and keeps its own field names; the web reads *this* block.
"""

from __future__ import annotations

import urllib.parse
from typing import Any

from django.db.models import Case, F, IntegerField, QuerySet, Value, When
from rest_framework import serializers

from .connections import STATUS_CONNECTED
from .external_sources import BUCKET_IN_PROGRESS, BUCKET_TODO, EXTERNAL_TASK_SOURCES
from .models import ExternalWorkItem, IntegrationCredential

# Bucket display-rank: in_progress first, then todo, then done — the order a
# contributor scans (what am I on now → what's next → what's finished). Applied
# as the secondary sort after the due-date cascade.
_BUCKET_RANK = Case(
    When(display_bucket=BUCKET_IN_PROGRESS, then=Value(0)),
    When(display_bucket=BUCKET_TODO, then=Value(1)),
    default=Value(2),
    output_field=IntegerField(),
)


class MeWorkExternalItemSerializer(serializers.Serializer[Any]):
    """One external work item in the My Work ``external_items`` block (#1422).

    Field names are the My Work contract (``source_type`` / ``key`` /
    ``status_category`` / ``synced_at`` / ``url``), distinct from the standalone
    ``/me/external-items/`` serializer that predates it — the web binds this
    block. Read-only throughout: an external item is a personal cache row, never
    a ``Task`` (ADR-0097 §2), so it carries no schedule/board/action fields.
    """

    id = serializers.UUIDField(read_only=True)
    # ``source_type`` is the cross-source discriminator ("jira", "github", …);
    # ``source="source"`` maps it onto the model's ``source`` column (a field
    # literally named ``source`` collides with DRF's internal ``Field.source``).
    source_type = serializers.CharField(source="source", read_only=True)
    key = serializers.CharField(source="external_id", read_only=True)
    title = serializers.CharField(read_only=True, allow_blank=True)
    external_status = serializers.CharField(read_only=True, allow_blank=True)
    status_category = serializers.CharField(source="display_bucket", read_only=True)
    due_date = serializers.DateField(read_only=True, allow_null=True)
    url = serializers.CharField(source="external_url", read_only=True, allow_blank=True)
    synced_at = serializers.DateTimeField(source="last_synced_at", read_only=True, allow_null=True)


def external_items_queryset(user: Any) -> QuerySet[ExternalWorkItem]:
    """Return the user's live external items, ordered for My Work (#1422).

    Ordering: ``due_date`` ascending with nulls last (dated work first, then
    undated), then bucket rank (in_progress → todo → done), then most-recently
    synced. The live set is bounded (≤500 per connected source, ADR-0097 §4 — a
    single OSS source today), so the trailing sort over the
    ``(user, is_stale, display_bucket)`` index range is cheap and needs no extra
    index. Strictly personal — filters ``user`` and hides soft-removed
    (``is_stale``) rows so no other user can ever see another user's items.
    """
    return (
        ExternalWorkItem.objects.filter(user=user, is_stale=False)
        .annotate(_bucket_rank=_BUCKET_RANK)
        .order_by(F("due_date").asc(nulls_last=True), "_bucket_rank", "-last_synced_at")
    )


def _site_url(base_url: str) -> str:
    """Extract the bare host ("truescope.atlassian.net") from a stored base URL."""
    if not base_url:
        return ""
    parsed = urllib.parse.urlparse(base_url if "//" in base_url else f"https://{base_url}")
    return (parsed.hostname or "").lower()


def external_source_summaries(user: Any) -> list[dict[str, Any]]:
    """Per-source freshness/status for the My Work ``external_sources`` block.

    One row per ``EXTERNAL_TASK_SOURCES`` provider the user has actually
    connected, so the UI can render a "Jira · synced 2 min ago" freshness line
    and swap to a "Reconnect" prompt when the #1419 pull worker flipped the
    connection to ``auth_failed`` (ADR-0097 §5). A single query over the user's
    credentials — no per-source round-trip.
    """
    source_keys = EXTERNAL_TASK_SOURCES.keys()
    creds = {
        c.provider: c
        for c in IntegrationCredential.objects.filter(user=user, provider__in=source_keys)
    }
    summaries: list[dict[str, Any]] = []
    for key in source_keys:
        row = creds.get(key)
        if row is None:
            continue  # only surface sources the user has connected
        source_cls = EXTERNAL_TASK_SOURCES.get(key)
        cfg = row.config or {}
        summaries.append(
            {
                "source_type": key,
                "label": getattr(source_cls, "label", key.title()),
                "site_url": _site_url(row.base_url),
                "status": cfg.get("status") or STATUS_CONNECTED,
                "last_synced_at": row.last_used_at,
            }
        )
    return summaries


def me_work_external_blocks(user: Any) -> dict[str, Any]:
    """Build the ``external_items`` + ``external_sources`` My Work side-blocks.

    Called once, on the first page of ``GET /me/work/`` (mirrors ``signals``).
    Both keys are always present (possibly empty lists) so the web binds one
    stable shape and can distinguish "no source connected" (empty
    ``external_sources``) from "connected, nothing assigned" (a source present
    with an empty ``external_items``).
    """
    items = list(external_items_queryset(user))
    return {
        "external_items": MeWorkExternalItemSerializer(items, many=True).data,
        "external_sources": external_source_summaries(user),
    }
