"""Agent-action recording service (ADR-0112 RC1, #1805).

``record_agent_action`` is the single writer of the hash chain. It allocates the next
per-instance ``sequence``, links to the predecessor's ``record_hash``, writes the
append-only ``AgentAction`` row, and advances the chain head — all under one
``select_for_update`` on the singleton ``AgentActionChainHead`` so two concurrent
callers cannot interleave the chain (ADR-0112's mechanism (a): the lock also protects
the hash linkage, which a bare DB sequence would not). The ``agent_action_recorded``
signal is dispatched in ``on_commit`` so it fires only once the row and its link are
durable.

The write is **fail-closed**: it runs inside the request's atomic block, so if the
append fails the whole request rolls back rather than serving an un-audited read — an
audit substrate must never return a read it could not record.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionCheckpoint,
    AgentActionRefusalDetail,
    AgentActionVerdict,
    AgentActorKind,
)
from trueppm_api.apps.agents.signals import agent_action_prune_requested, agent_action_recorded

if TYPE_CHECKING:
    from datetime import datetime

    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import ProjectApiToken


def _safe_ip(value: str | None) -> str | None:
    """Return ``value`` only if it parses as a valid IP address, else ``None``.

    Guards the fail-closed save: a forgeable ``X-Forwarded-For`` (which may carry a
    hostname or garbage) must never raise on ``GenericIPAddressField`` and turn a valid
    read into a 500.
    """

    if not value:
        return None
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return None
    return value


def engine_version() -> str:
    """The trueppm-scheduler version at decision time — the answer-stamp engine anchor.

    Resolved from the installed package metadata (never drifts from the wheel). Falls
    back to ``"unknown"`` so a metadata hiccup can never break the audited request.
    """

    try:
        from trueppm_scheduler import __version__

        return str(__version__)
    except Exception:
        return "unknown"


def hash_request_payload(request: Request) -> str:
    """sha256 over the canonicalized request payload — the per-request reproducibility hash.

    Hashes the method, path, sorted query parameters, and the request body when present
    (a read usually has none). Never includes headers, so no token material is hashed.
    Total by construction — a malformed body is hashed as its raw bytes, never raised.
    """

    parts: dict[str, Any] = {
        "method": request.method,
        "path": request.path,
        "query": sorted(request.GET.items()),
    }
    body = getattr(request, "body", b"") or b""
    if body:
        parts["body_sha256"] = hashlib.sha256(body).hexdigest()
    canonical = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def record_agent_action(
    *,
    actor_kind: str = AgentActorKind.MCP_TOKEN,
    actor_token: ProjectApiToken | None,
    principal: Any | None,
    action: str,
    method: str,
    capability_used: str,
    verdict: str,
    payload_hash: str,
    refusal_reason: str = "",
    refusal_constraint: str = "",
    projected_impact: dict[str, Any] | None = None,
    object_type: str = "",
    object_id: str = "",
    project_id: Any | None = None,
    summary: str = "",
    source_ip: str | None = None,
    engine_version_str: str | None = None,
    occurred_at: datetime | None = None,
) -> AgentAction:
    """Append one hash-chained ``AgentAction`` row and advance the chain head.

    Serializes on the singleton chain head so the ``sequence`` is gap-free and each row
    links to the true predecessor. Must be called inside a DB transaction (the request's
    ATOMIC_REQUESTS block, or an explicit ``transaction.atomic``); the ``on_commit``
    signal fires on the outermost commit.

    When ``verdict`` is a refusal and ``refusal_constraint`` is given, a non-hashed
    :class:`AgentActionRefusalDetail` side-car is created **in the same atomic block**
    (ADR-0421, #1850) so the constraint that fired and the projected impact commit
    together with the chain row — the two can never diverge. ``projected_impact`` is
    ``{}`` for the current MCP-scope/identity producers (no schedule impact); the 0.6
    gated-write producers populate it. The side-car is telemetry only; it is not part of
    the hashed record, so it never affects ``audit_verify``.
    """

    if verdict != AgentActionVerdict.REFUSED:
        # refusal_reason/constraint are meaningful only for a refusal; never persist a
        # dangling one (a non-refusal must not carry a refusal side-car either).
        refusal_reason = ""
        refusal_constraint = ""

    occurred = occurred_at or timezone.now()
    token_prefix = actor_token.token_prefix if actor_token is not None else ""
    resolved_engine = engine_version_str or engine_version()
    # Sanitize the client IP: a spoofed/malformed X-Forwarded-For must not raise on the
    # GenericIPAddressField save and 500 an otherwise-valid (fail-closed) read.
    safe_ip = _safe_ip(source_ip)

    with transaction.atomic():
        # Lock the chain head for the duration of the append so the predecessor link and
        # the sequence allocation are atomic against any concurrent recorder.
        head = AgentActionChainHead.objects.select_for_update().get(pk=1)
        sequence = head.last_sequence + 1
        prev_hash = head.last_record_hash

        entry = AgentAction(
            schema_version=AgentAction._meta.get_field("schema_version").default,
            actor_kind=actor_kind,
            actor_token=actor_token,
            actor_token_prefix=token_prefix,
            principal=principal if getattr(principal, "pk", None) else None,
            action=action,
            method=(method or "")[:8],
            object_type=object_type or "",
            object_id=str(object_id or "")[:64],
            project_id=project_id,
            capability_used=capability_used or "",
            verdict=verdict,
            refusal_reason=refusal_reason,
            payload_hash=payload_hash,
            engine_version=resolved_engine,
            sequence=sequence,
            prev_hash=prev_hash,
            summary=summary or "",
            source_ip=safe_ip,
            occurred_at=occurred,
        )
        entry.record_hash = compute_record_hash(prev_hash, canonical_fields(entry))
        entry.save(force_insert=True)

        head.last_sequence = sequence
        head.last_record_hash = entry.record_hash
        head.save(update_fields=["last_sequence", "last_record_hash", "updated_at"])

        # Non-hashed telemetry side-car (ADR-0421): same atomic block as the chain
        # append so the detail and its row commit or roll back together. Only for a
        # refusal that names a constraint — an allowed read never carries one.
        if verdict == AgentActionVerdict.REFUSED and refusal_constraint:
            AgentActionRefusalDetail.objects.create(
                action=entry,
                constraint=refusal_constraint,
                projected_impact=projected_impact or {},
            )

    transaction.on_commit(lambda: agent_action_recorded.send(sender=AgentAction, action=entry))
    return entry


@dataclass(frozen=True)
class PruneResult:
    """Outcome of a :func:`prune_agent_actions` call (dry-run or committed).

    ``eligible`` is the number of rows the window selects; ``deleted`` is how many were
    actually removed (0 on a dry-run). ``cutoff_sequence`` / ``cutoff_hash`` are the
    prune floor — the highest sequence removed and its ``record_hash`` (the anchor a
    ``checkpoint`` re-seeds ``audit_verify`` from). All ``None`` when nothing was eligible.
    """

    eligible: int
    deleted: int
    committed: bool
    cutoff_sequence: int | None
    cutoff_hash: str | None
    first_retained_sequence: int | None
    checkpoint_id: str | None


def _resolve_cutoff(
    head: AgentActionChainHead,
    *,
    before: datetime | None,
    keep_days: int | None,
    keep_last: int | None,
) -> int:
    """Resolve a window into a **prefix** cutoff sequence (delete rows ``<=`` the result).

    Count-based (``keep_last``) keeps the newest K by sequence. Age-based
    (``before`` / ``keep_days``) deletes the longest contiguous prefix whose rows are
    **all** older than the cutoff — it stops at the first (lowest-sequence) row that is not
    old enough, so a row younger than the cutoff is never deleted and the surviving chain
    can never gain a mid-chain gap even if ``occurred_at`` is slightly out of sequence order.
    """

    if keep_last is not None:
        # Newest K rows by sequence survive; everything at or below the floor is pruned.
        return head.last_sequence - keep_last

    cutoff_at = timezone.now() - timedelta(days=keep_days) if keep_days is not None else before
    first_not_old = (
        AgentAction.objects.filter(occurred_at__gte=cutoff_at).order_by("sequence").first()
    )
    if first_not_old is None:
        # Every row is older than the cutoff — the prefix is the whole chain.
        return head.last_sequence
    return first_not_old.sequence - 1


def prune_agent_actions(
    *,
    before: datetime | None = None,
    keep_days: int | None = None,
    keep_last: int | None = None,
    through_sequence: int | None = None,
    commit: bool = False,
    actor: Any | None = None,
) -> PruneResult:
    """Chain-aware prune of the oldest ``AgentAction`` rows (ADR-0361, OSS admin-triggered).

    Deletes a contiguous **prefix** (lowest sequences) selected by exactly one window and,
    when it actually removes rows, writes an immutable :class:`AgentActionCheckpoint` so
    ``audit_verify`` re-anchors from the last-deleted row's ``record_hash`` instead of
    genesis. Runs under the chain-head ``select_for_update`` so it serializes against
    ``record_agent_action`` and concurrent prunes. With ``commit=False`` (the default) it is
    a dry-run: it reports the eligible count and resulting anchor without deleting or
    checkpointing. A receiver of ``agent_action_prune_requested`` may raise to veto the whole
    prune (the Enterprise legal-hold seam) — fail-closed inside the atomic block.

    ``through_sequence`` pins the cutoff to an explicit sequence instead of resolving a
    window. The command uses it to commit exactly the prefix it previewed, so rows appended
    between the dry-run and the ``--commit`` cannot enlarge a relative (``keep_last`` /
    ``keep_days``) cutoff and delete more than the operator confirmed.
    """

    given = [v for v in (before, keep_days, keep_last, through_sequence) if v is not None]
    if len(given) != 1:
        raise ValueError("Provide exactly one of before, keep_days, keep_last, through_sequence.")
    if keep_last is not None and keep_last < 0:
        raise ValueError("keep_last must be non-negative.")
    if keep_days is not None and keep_days < 0:
        raise ValueError("keep_days must be non-negative.")

    with transaction.atomic():
        # Same lock the writer takes: serializes prune vs. append and prune vs. prune, and
        # keeps the rows at/below the cutoff stable (appends only add rows above the head).
        head = AgentActionChainHead.objects.select_for_update().get(pk=1)
        cutoff_sequence = (
            through_sequence
            if through_sequence is not None
            else _resolve_cutoff(head, before=before, keep_days=keep_days, keep_last=keep_last)
        )

        qs = AgentAction.objects.filter(sequence__lte=cutoff_sequence)
        eligible = qs.count()
        if eligible == 0:
            return PruneResult(0, 0, False, None, None, None, None)

        # The last-deleted row's record_hash is the anchor the surviving tail links to.
        cutoff_row = AgentAction.objects.get(sequence=cutoff_sequence)
        cutoff_hash = cutoff_row.record_hash
        first_retained = cutoff_sequence + 1

        if not commit:
            return PruneResult(
                eligible, 0, False, cutoff_sequence, cutoff_hash, first_retained, None
            )

        # Legal-hold veto point — a receiver raising here rolls back the whole prune.
        agent_action_prune_requested.send(
            sender=AgentAction,
            cutoff_sequence=cutoff_sequence,
            cutoff_at=timezone.now(),
            actor=actor,
        )

        deleted, _ = qs.delete()
        checkpoint = AgentActionCheckpoint.objects.create(
            pruned_through_sequence=cutoff_sequence,
            pruned_through_hash=cutoff_hash,
            first_retained_sequence=first_retained,
            pruned_count=deleted,
            pruned_by=actor if getattr(actor, "pk", None) else None,
            created_at=timezone.now(),
        )
        return PruneResult(
            eligible,
            deleted,
            True,
            cutoff_sequence,
            cutoff_hash,
            first_retained,
            str(checkpoint.id),
        )
