"""Re-anchor bundled sample programs to today (#3481, ADR-1175).

Usage::

    python manage.py shift_sample_dates [--program <id>] [--dry-run]

The command-line half of the "Shift dates to today" banner action. It exists so a
long-lived demo deployment can keep its sample current from a scheduled job it
owns — a Kubernetes CronJob alongside the existing demo-seed Job, say — rather
than every self-hosted install acquiring a Celery beat that silently rewrites
rows nobody asked it to touch.

That is the deliberate shape of ADR-1175 Decision 1: **no global beat ships**. An
operator who wants automatic re-anchoring opts into it visibly, in their own
manifests, where a failure is theirs to see.

Idempotent, like the endpoint: a sample already within a week of today reports
"already current" and writes nothing, so running this nightly is safe.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.projects.seed.reanchor import (
    NoAnchorRecorded,
    NotASampleProgram,
    shift_sample_dates,
    whole_week_delta,
)


class Command(BaseCommand):
    help = "Shift bundled sample programs' dates forward to today."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--program",
            help="Shift only this program id. Default: every sample program on the install.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would move without writing anything.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        from django.utils import timezone

        programs = self._resolve_programs(options.get("program"))
        if not programs:
            self.stdout.write("No sample programs found; nothing to do.")
            return

        today = timezone.localdate()
        for program in programs:
            label = f"{program.name!r} ({program.pk})"

            if options["dry_run"]:
                # Reported from the same helper the shift uses, so the dry run
                # cannot disagree with the real thing about how far it would move.
                if program.sample_anchor_date is None:
                    self.stdout.write(
                        self.style.WARNING(f"  {label}: no anchor recorded — reload it instead.")
                    )
                    continue
                days = whole_week_delta(program.sample_anchor_date, today)
                if days == 0:
                    self.stdout.write(f"  {label}: already current.")
                else:
                    self.stdout.write(f"  {label}: would move forward {days} days.")
                continue

            try:
                report = shift_sample_dates(program)
            except NotASampleProgram as exc:
                # Only reachable via --program: the default query already filters
                # to programs holding a sample project.
                raise CommandError(f"{label}: {exc}") from exc
            except NoAnchorRecorded:
                self.stdout.write(
                    self.style.WARNING(
                        f"  {label}: loaded before date shifting existed, so its original "
                        f"dates are not recorded. Remove and reload it to get current dates."
                    )
                )
                continue

            if report.shifted:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"  {label}: moved forward {report.days} days — "
                        f"{report.rows_shifted} records across {report.projects} project(s). "
                        f"Schedules re-queued."
                    )
                )
            else:
                self.stdout.write(f"  {label}: already current.")

    def _resolve_programs(self, program_id: str | None) -> list[Program]:
        if program_id:
            program = Program.objects.filter(pk=program_id).first()
            if program is None:
                raise CommandError(f"No program with id {program_id!r}.")
            return [program]
        # Sample-ness lives on Project, not Program — a program is demo data when
        # it holds at least one is_sample project (the same test remove_sample and
        # the banner use).
        return list(
            Program.objects.filter(
                pk__in=Project.objects.filter(is_sample=True, is_deleted=False).values("program")
            ).order_by("name")
        )
