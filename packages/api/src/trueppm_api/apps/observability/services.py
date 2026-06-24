"""Service layer for the retention policy editor + purge runs (ADR-0173).

Read/write helpers behind the ``/health/retention/*`` endpoints, plus the
durable dispatch of a manual/dry-run purge. Dispatch follows the house pattern:
create the ``PurgeRun`` row, then fire the coordinator in ``transaction.on_commit``
so the worker only adopts a row that has committed (ADR-0173 §Durable Execution).
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.observability.models import (
    PurgeRun,
    RetentionPolicy,
    RetentionSchedule,
)
from trueppm_api.apps.observability.purge_registry import (
    estimate_table_stats,
    get_purge_specs,
    spec_purge_for,
)
from trueppm_api.apps.observability.retention import (
    RETENTION_SPECS,
    spec_for,
)

logger = logging.getLogger(__name__)


def _resolve_for_display(key: str, policies: dict[str, RetentionPolicy]) -> tuple[int, bool]:
    """Return ``(value, enabled)`` to show in the editor for ``key``.

    An override row wins. Otherwise the ADR-0081 setting: a numeric value is
    shown enabled; a ``None`` (disabled) setting shows the spec default as the
    value with ``enabled=False`` so the input always has a sensible number to edit.
    Non-disablable windows (sync batches) are always enabled.
    """
    spec = spec_for(key)
    row = policies.get(key)
    if row is not None:
        value, enabled = row.value, row.enabled
    else:
        setting_value = getattr(settings, key, spec["default"])
        if setting_value is None:
            value, enabled = spec["default"], False
        else:
            value, enabled = setting_value, True
    if not spec["disablable"]:
        enabled = True
    return value, enabled


def get_retention_state() -> dict[str, Any]:
    """Build the full editor payload: policies, schedule, and the recent run log."""
    policies = {row.key: row for row in RetentionPolicy.objects.all()}
    db_tables_by_key = {spec.key: spec.db_tables for spec in get_purge_specs()}

    policy_rows: list[dict[str, Any]] = []
    for spec in RETENTION_SPECS:
        key = spec["key"]
        value, enabled = _resolve_for_display(key, policies)
        est_rows, est_bytes = estimate_table_stats(db_tables_by_key.get(key, ()))
        policy_rows.append(
            {
                "key": key,
                "label": spec["label"],
                "note": spec["note"],
                "unit": spec["unit"],
                "value": value,
                "enabled": enabled,
                "row_count": est_rows,
                "bytes": est_bytes,
            }
        )

    schedule, _ = RetentionSchedule.objects.get_or_create(singleton_key=1)
    runs = list(PurgeRun.objects.order_by("-started_at")[:7])

    return {"policies": policy_rows, "schedule": schedule, "runs": runs}


@transaction.atomic
def apply_retention_update(data: dict[str, Any]) -> None:
    """Persist policy overrides and/or schedule changes from the save-bar PATCH.

    Sync batches can't be disabled, so ``enabled`` is forced True for that key
    regardless of what the client sends (defensive — the UI already hides the toggle).
    """
    for item in data.get("policies", []):
        key = item["key"]
        enabled = True if not spec_for(key)["disablable"] else item["enabled"]
        RetentionPolicy.objects.update_or_create(
            key=key,
            defaults={"value": item["value"], "enabled": enabled},
        )

    schedule_data = data.get("schedule")
    if schedule_data:
        RetentionSchedule.objects.update_or_create(singleton_key=1, defaults=schedule_data)


def compute_impact(key: str, value: int) -> tuple[int, int | None]:
    """Rows (and best-effort bytes) that *would* become purge-eligible at ``value``.

    Backs the dirty-state "lowering this is irreversible" warning. A pure count —
    no rows are deleted (``dry_run=True`` with the proposed window as override).
    """
    from trueppm_api.apps.observability.purge_registry import estimate_freed_bytes

    spec = spec_purge_for(key)
    rows = spec.purge(dry_run=True, override_value=value)
    return rows, estimate_freed_bytes(spec.db_tables, rows)


def start_purge_run(*, dry_run: bool, trigger: str = PurgeRun.Trigger.MANUAL) -> PurgeRun:
    """Create a PurgeRun and dispatch the coordinator on commit (best-effort).

    Returns immediately with the ``running`` row so the API can hand back a
    ``run_id``; the worker fills in the result. If the broker is unreachable when
    the on-commit dispatch fires, the run is marked ``failed`` so the UI's polling
    log reflects it rather than hanging on ``running`` forever.
    """
    run = PurgeRun.objects.create(
        trigger=PurgeRun.Trigger.DRY_RUN if dry_run else trigger,
        state=PurgeRun.State.RUNNING,
    )

    def _dispatch() -> None:
        from trueppm_api.apps.observability.tasks import run_retention_purge

        try:
            run_retention_purge.delay(run_id=str(run.id), dry_run=dry_run)
        except Exception:
            logger.exception("start_purge_run: dispatch failed for PurgeRun %s", run.id)
            PurgeRun.objects.filter(id=run.id, state=PurgeRun.State.RUNNING).update(
                state=PurgeRun.State.FAILED,
                finished_at=timezone.now(),
                error="dispatch failed: task broker unavailable",
            )

    transaction.on_commit(_dispatch)
    return run
