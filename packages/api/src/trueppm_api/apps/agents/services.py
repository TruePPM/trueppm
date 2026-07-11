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
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.agents.canonical import canonical_fields, compute_record_hash
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionVerdict,
    AgentActorKind,
)
from trueppm_api.apps.agents.signals import agent_action_recorded

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
    """

    if verdict != AgentActionVerdict.REFUSED:
        # refusal_reason is meaningful only for a refusal; never persist a dangling one.
        refusal_reason = ""

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

    transaction.on_commit(lambda: agent_action_recorded.send(sender=AgentAction, action=entry))
    return entry
