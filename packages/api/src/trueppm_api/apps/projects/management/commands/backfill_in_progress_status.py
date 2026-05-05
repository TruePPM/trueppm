"""Backfill the date-gated NOT_STARTED → IN_PROGRESS auto-transition (#336).

Before #336 landed, setting `planned_start` on a NOT_STARTED task did not
auto-transition status across most entry points (only the gutter-promote
action did, briefly, on the frontend). This command finds rows that *should*
have been IN_PROGRESS under the new rule and corrects them in one pass so
the unified data model holds for existing data, not just new mutations.

Targeted rows: ``status=NOT_STARTED`` AND ``planned_start <= today``.

For each, the command:

- Sets ``status = IN_PROGRESS``.
- Sets ``actual_start = planned_start`` (preserving the historical date —
  same logic as ``TaskSerializer.update`` for past-dated planned_start).

Idempotent: a second run finds zero matches because the first run moved them
out of NOT_STARTED. Safe to run repeatedly during deployment rollout.

Usage::

    python manage.py backfill_in_progress_status              # apply
    python manage.py backfill_in_progress_status --dry-run    # preview only
"""

from __future__ import annotations

import logging
from typing import Any

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.projects.models import Task, TaskStatus

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = (
        "Backfill NOT_STARTED tasks with planned_start ≤ today to IN_PROGRESS, "
        "pinning actual_start to planned_start (#336)."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print the rows that would be updated without writing.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        today = timezone.localdate()
        candidates = Task.objects.filter(
            status=TaskStatus.NOT_STARTED,
            planned_start__lte=today,
        ).only("id", "name", "planned_start", "actual_start")

        count = candidates.count()
        if count == 0:
            self.stdout.write(self.style.SUCCESS("No tasks to backfill."))
            return

        self.stdout.write(
            f"Found {count} NOT_STARTED task(s) with planned_start ≤ {today.isoformat()}."
        )

        if options["dry_run"]:
            for t in candidates[:50]:
                self.stdout.write(f"  • {t.id} '{t.name}' planned_start={t.planned_start}")
            if count > 50:
                self.stdout.write(f"  … and {count - 50} more")
            self.stdout.write(self.style.WARNING("--dry-run: no changes written."))
            return

        # Bulk update inside a transaction; preserve actual_start when it's
        # already set (don't trample historical data) and never overwrite a
        # status that has somehow drifted out of NOT_STARTED between the
        # candidate query and the write.
        updated = 0
        with transaction.atomic():
            for t in candidates.select_for_update():
                if t.status != TaskStatus.NOT_STARTED:
                    continue  # raced; another writer moved this row already
                t.status = TaskStatus.IN_PROGRESS
                if not t.actual_start:
                    t.actual_start = t.planned_start
                t.save(update_fields=["status", "actual_start"])
                updated += 1

        self.stdout.write(self.style.SUCCESS(f"Backfilled {updated} task(s)."))
