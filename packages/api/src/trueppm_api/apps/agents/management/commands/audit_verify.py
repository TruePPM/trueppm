"""``manage.py audit_verify`` — the OSS agent-action chain integrity self-check (ADR-0112 RC1).

Walks the append-only ``AgentAction`` chain in ``sequence`` order and, for each row,
recomputes ``record_hash`` from the *previous* row's ``record_hash`` and this row's
canonical body — the same ``compute_record_hash`` the recorder used. It reports the
first divergence and exits non-zero, so a team (or a cron/CI check) can detect whether
its own log was altered on its own instance. It **proves** nothing to an external
auditor — that is the Enterprise notarized/signed archive (#146); this command *detects*
local tampering.

Checks, per row:
  * ``sequence`` is gap-free and strictly increasing (a gap/reorder is a tamper signal);
  * ``prev_hash`` equals the predecessor's ``record_hash`` (the chain links);
  * ``record_hash`` recomputes from ``prev_hash ‖ canonical(record)`` (the row is intact).

If the oldest rows have been pruned (``manage.py audit_prune``, ADR-0361), the walk seeds
from the **latest** ``AgentActionCheckpoint`` — the last-deleted row's ``record_hash`` and
the sequence at which the retained chain resumes — instead of genesis. A prune leaves a
matching checkpoint, so the surviving tail still verifies; a deletion *without* a checkpoint
still surfaces as a break at the first surviving row. The checkpoint is an unauthenticated
continuity anchor, not a signature: this local self-check cannot detect a prune paired with a
*forged* checkpoint (an actor with DB write can set both) — proving to an external auditor
that history was not selectively truncated is the Enterprise notarized/signed archive (#146).

Exit status: 0 = chain intact (or empty); 1 = a break was found.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    GENESIS_PREV_HASH,
    AgentAction,
    AgentActionCheckpoint,
)


class Command(BaseCommand):
    help = "Verify the integrity of the append-only agent-action hash chain (ADR-0112)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--quiet",
            action="store_true",
            help="Suppress the per-run summary; only emit output on a detected break.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        quiet: bool = options["quiet"]

        # Re-anchor from the latest prune checkpoint if the oldest rows were pruned;
        # otherwise the chain still starts at genesis / sequence 1 (ADR-0361).
        checkpoint = AgentActionCheckpoint.objects.order_by("-pruned_through_sequence").first()
        if checkpoint is None:
            expected_prev = GENESIS_PREV_HASH
            expected_sequence = 1
            anchor = "genesis"
        else:
            expected_prev = checkpoint.pruned_through_hash
            expected_sequence = checkpoint.first_retained_sequence
            anchor = f"checkpoint @seq {checkpoint.pruned_through_sequence}"
        count = 0

        # Stream in chain order; .iterator() keeps memory flat for a long chain.
        for action in AgentAction.objects.order_by("sequence").iterator():
            if action.sequence != expected_sequence:
                raise CommandError(
                    f"Chain break at sequence {action.sequence} ({action.id}): "
                    f"expected sequence {expected_sequence} (gap or reorder)."
                )
            if action.prev_hash != expected_prev:
                raise CommandError(
                    f"Chain break at sequence {action.sequence} ({action.id}): "
                    f"prev_hash does not match the predecessor's record_hash."
                )
            recomputed = compute_record_hash(action.prev_hash, canonical_fields(action))
            if recomputed != action.record_hash:
                raise CommandError(
                    f"Chain break at sequence {action.sequence} ({action.id}): "
                    f"record_hash does not recompute — the row was altered."
                )

            expected_prev = action.record_hash
            expected_sequence += 1
            count += 1

        if not quiet:
            if count == 0:
                self.stdout.write(
                    self.style.SUCCESS(f"Agent-action chain empty (from {anchor}) — OK.")
                )
            else:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Agent-action chain intact — {count} records verified (from {anchor})."
                    )
                )
