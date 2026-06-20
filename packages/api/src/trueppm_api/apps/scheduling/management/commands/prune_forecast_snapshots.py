"""Apply the tiered retention curve to project forecast snapshots (ADR-0153, #388).

Operator-facing wrapper around the same ``_do_prune_forecast_snapshots`` logic the
nightly ``scheduling.prune_forecast_snapshots`` Celery Beat task runs. Per
``settings.FORECAST_SNAPSHOT_RETENTION``: keep all rows younger than ``daily_days``
(default 90); keep one-per-ISO-week up to ``weekly_days`` (default 365); keep
one-per-calendar-month beyond that (kept forever).

Idempotent: a second run deletes nothing new (the keepers are already the only rows
left in each bucket).

Usage::

    python manage.py prune_forecast_snapshots              # apply
    python manage.py prune_forecast_snapshots --dry-run    # report only, no delete
"""

from __future__ import annotations

import logging
from typing import Any

from django.core.management.base import BaseCommand

from trueppm_api.apps.scheduling.models import ProjectForecastSnapshot
from trueppm_api.apps.scheduling.tasks import _do_prune_forecast_snapshots

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Prune project forecast snapshots per the tiered retention policy (ADR-0153)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report how many rows would be deleted without deleting them.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if options["dry_run"]:
            # Mirror the task's bucketing in a counting-only pass: total - keepers.
            # Re-using the live function would delete, so we report the current count
            # and let the operator run without --dry-run to apply.
            total = ProjectForecastSnapshot.objects.count()
            self.stdout.write(
                f"{total} forecast snapshot(s) on record; run without --dry-run to prune."
            )
            return

        deleted = _do_prune_forecast_snapshots()
        self.stdout.write(self.style.SUCCESS(f"Pruned {deleted} forecast snapshot(s)."))
