"""``manage.py audit_prune`` — chain-aware, admin-triggered pruning of the agent-action log.

The ``AgentAction`` hash chain (ADR-0112) is append-only and grows unbounded. This command
is the OSS operator lever to bound it (ADR-0361): it deletes a contiguous **prefix** of the
oldest rows and writes an ``AgentActionCheckpoint`` so ``manage.py audit_verify`` still
verifies the surviving tail. It is **admin-triggered, never automatic** — OSS ships no Beat
schedule for it; automatic/enforced retention, legal hold, and the off-server archive are the
Enterprise layer (ADR-0112 §3, #146).

Exactly one window is required:
  * ``--before <ISO-8601>`` — delete rows older than the given timestamp;
  * ``--keep-days <N>`` — delete rows older than N days;
  * ``--keep-last <K>`` — keep the newest K rows, delete the rest.

It is a **dry-run by default** and only reports the eligible count and resulting anchor;
``--commit`` performs the deletion (prompting for confirmation unless ``--yes`` is given).
So it can never silently or accidentally delete audit history.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from trueppm_api.apps.agents.services import prune_agent_actions


class Command(BaseCommand):
    help = "Prune the oldest agent-action rows, re-anchoring the hash chain (ADR-0361)."

    def add_arguments(self, parser: Any) -> None:
        window = parser.add_mutually_exclusive_group(required=True)
        window.add_argument(
            "--before",
            type=str,
            help="Delete rows with occurred_at before this ISO-8601 date/datetime.",
        )
        window.add_argument("--keep-days", type=int, help="Delete rows older than this many days.")
        window.add_argument(
            "--keep-last", type=int, help="Keep the newest K rows; delete the rest."
        )
        parser.add_argument(
            "--commit",
            action="store_true",
            help="Actually delete the rows. Without this the command is a dry-run.",
        )
        parser.add_argument(
            "--yes",
            action="store_true",
            help="Skip the interactive confirmation prompt on --commit.",
        )
        parser.add_argument(
            "--actor",
            type=str,
            default=None,
            help="Username to attribute the prune to (recorded on the checkpoint).",
        )

    def _parse_before(self, raw: str) -> datetime:
        """Parse ``--before`` into an aware datetime, accepting a bare date or a datetime."""
        parsed = parse_datetime(raw)
        if parsed is None:
            as_date = parse_date(raw)
            if as_date is not None:
                parsed = datetime(as_date.year, as_date.month, as_date.day)
        if parsed is None:
            raise CommandError(f"--before: could not parse '{raw}' as an ISO-8601 date/datetime.")
        if timezone.is_naive(parsed):
            parsed = timezone.make_aware(parsed)
        return parsed

    def handle(self, *args: Any, **options: Any) -> None:
        before = self._parse_before(options["before"]) if options.get("before") else None
        keep_days: int | None = options.get("keep_days")
        keep_last: int | None = options.get("keep_last")
        commit: bool = options["commit"]
        actor = self._resolve_actor(options.get("actor"))

        # Dry-run first so we can show the operator exactly what --commit would do.
        preview = prune_agent_actions(
            before=before, keep_days=keep_days, keep_last=keep_last, commit=False
        )

        if preview.eligible == 0:
            self.stdout.write(self.style.SUCCESS("Nothing to prune — no rows match the window."))
            return

        summary = (
            f"{preview.eligible} row(s) eligible → would prune through sequence "
            f"{preview.cutoff_sequence}; chain re-anchors at sequence "
            f"{preview.first_retained_sequence}."
        )

        if not commit:
            self.stdout.write(summary)
            self.stdout.write(
                self.style.WARNING("Dry-run only. Re-run with --commit to delete these rows.")
            )
            return

        if not options["yes"]:
            confirm = input(f"{summary}\nDelete {preview.eligible} row(s)? [y/N] ").strip().lower()
            if confirm not in {"y", "yes"}:
                self.stdout.write(self.style.WARNING("Aborted — nothing deleted."))
                return

        # Pin the previewed cutoff so appends between preview and commit cannot enlarge a
        # relative window and delete more than the operator confirmed.
        try:
            result = prune_agent_actions(
                through_sequence=preview.cutoff_sequence, commit=True, actor=actor
            )
        except Exception as exc:  # a legal-hold receiver (Enterprise) may veto the prune
            raise CommandError(f"Prune aborted — nothing deleted: {exc}") from exc

        self.stdout.write(
            self.style.SUCCESS(
                f"Pruned {result.deleted} row(s) through sequence {result.cutoff_sequence}; "
                f"checkpoint written. Chain now starts at sequence "
                f"{result.first_retained_sequence}."
            )
        )

    def _resolve_actor(self, username: str | None) -> Any | None:
        """Resolve ``--actor`` to a user, or ``None`` when unset (the checkpoint allows NULL)."""
        if not username:
            return None
        user_model = get_user_model()
        try:
            return user_model.objects.get(username=username)
        except user_model.DoesNotExist as exc:
            raise CommandError(f"--actor: no user with username '{username}'.") from exc
