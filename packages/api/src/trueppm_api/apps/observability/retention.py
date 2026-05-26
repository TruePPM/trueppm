"""Retention-window metadata and the settings→override resolver (ADR-0090).

This module is deliberately **import-clean**: it pulls in nothing from the
domain apps (webhooks, msproject, history, taskruns, sync), so those apps' purge
tasks can import :func:`resolve_retention` without creating an import cycle. The
binding of each window to its actual table/queryset lives in ``purge_registry``,
which is imported only on the admin/coordinator path — never by the app tasks.

``resolve_retention`` is the single source of truth for "how long is table X
kept right now": a ``RetentionPolicy`` override row if the operator has set one,
otherwise the ADR-0081 ``settings.*`` default. ``None`` means the purge is
disabled (unbounded retention) — preserved for any deployment that never opens
the editor.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from django.conf import settings


class RetentionSpec(TypedDict):
    """Static metadata for one operator-tunable retention window."""

    key: str
    label: str
    note: str
    unit: Literal["days", "hours"]
    default: int
    disablable: bool


# The five operational tables surfaced in the editor (ADR-0090 §A). Order is the
# display order in the policy table. ``key`` matches the ADR-0081 settings name;
# ``default`` mirrors ``settings/base.py`` so the resolver and the UI agree even
# before any override row exists. ``disablable`` is False only for sync batches,
# whose backend window is non-nullable.
RETENTION_SPECS: list[RetentionSpec] = [
    {
        "key": "HISTORY_RETENTION_DAYS",
        "label": "Event history",
        "note": "Activity and audit feed rows (object change history).",
        "unit": "days",
        "default": 90,
        "disablable": True,
    },
    {
        "key": "TASK_RUN_RETENTION_DAYS",
        "label": "Task runs",
        "note": "Completed background-job execution records.",
        "unit": "days",
        "default": 30,
        "disablable": True,
    },
    {
        "key": "TRUEPPM_WEBHOOK_RETENTION_DAYS",
        "label": "Webhook deliveries",
        "note": "Outbound webhook attempt log — terminal deliveries only.",
        "unit": "days",
        "default": 7,
        "disablable": True,
    },
    {
        "key": "TRUEPPM_IMPORT_RETENTION_DAYS",
        "label": "Import requests",
        "note": "MS Project import payloads — terminal requests only.",
        "unit": "days",
        "default": 7,
        "disablable": True,
    },
    {
        "key": "TRUEPPM_SYNC_BATCH_RETENTION_HOURS",
        "label": "Sync batches",
        "note": "Mobile sync idempotency rows. Cannot be disabled.",
        "unit": "hours",
        "default": 24,
        "disablable": False,
    },
]

RETENTION_KEYS: list[str] = [spec["key"] for spec in RETENTION_SPECS]
RETENTION_KEY_CHOICES = [(spec["key"], spec["label"]) for spec in RETENTION_SPECS]

_SPEC_BY_KEY: dict[str, RetentionSpec] = {spec["key"]: spec for spec in RETENTION_SPECS}


def spec_for(key: str) -> RetentionSpec:
    """Return the static metadata for ``key`` (raises KeyError if unknown)."""
    return _SPEC_BY_KEY[key]


def resolve_retention(key: str) -> int | None:
    """Resolve the effective retention window for ``key`` in its native unit.

    Returns the ``RetentionPolicy`` override if one exists (``None`` when that
    override is disabled), else the ADR-0081 ``settings.*`` value. ``None`` means
    the purge is disabled — the table is retained unbounded. The ``RetentionPolicy``
    import is local so this module stays free of model imports at load time
    (keeps the app-task → resolver dependency cycle-free).
    """
    from trueppm_api.apps.observability.models import RetentionPolicy

    spec = _SPEC_BY_KEY.get(key)
    fallback = getattr(settings, key, spec["default"] if spec else None)

    row = RetentionPolicy.objects.filter(key=key).first()
    if row is None:
        return fallback
    return row.value if row.enabled else None


def resolve_retention_map() -> dict[str, int | None]:
    """Resolve every retention window in a single query.

    Equivalent to calling :func:`resolve_retention` for each key, but fetches all
    ``RetentionPolicy`` overrides in one round-trip — used by the 10 s-polled System
    Health overview to avoid five separate point-lookups per poll.
    """
    from trueppm_api.apps.observability.models import RetentionPolicy

    rows = {row.key: row for row in RetentionPolicy.objects.all()}
    resolved: dict[str, int | None] = {}
    for spec in RETENTION_SPECS:
        key = spec["key"]
        row = rows.get(key)
        if row is None:
            resolved[key] = getattr(settings, key, spec["default"])
        else:
            resolved[key] = row.value if row.enabled else None
    return resolved
