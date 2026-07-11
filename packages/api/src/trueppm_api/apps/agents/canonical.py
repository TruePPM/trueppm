"""Canonical serialization + record hashing for the agent-action chain (ADR-0112 RC1).

This is the **single source of truth** for how an ``AgentAction`` is turned into the
bytes that get hashed. ``record_agent_action`` uses it to compute a new row's
``record_hash``; ``manage.py audit_verify`` uses the *same* function to recompute and
compare. If the two ever diverged, every existing chain would appear tampered — so the
canonicalization lives here, once, and both call it.

The canonical form deliberately excludes ``prev_hash`` and ``record_hash`` themselves:
``record_hash = sha256(prev_hash ‖ canonical(record))`` chains the predecessor's hash
*around* the canonical body, so the body must not contain the link fields.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.agents.models import AgentAction


def canonical_fields(action: AgentAction) -> dict[str, object]:
    """Return the tamper-relevant fields of ``action`` in a stable, hashable dict.

    Every field that defines *what happened* is included; the chain-link fields
    (``prev_hash``/``record_hash``) are not, because the hash wraps them around this
    body. FK ids are stringified so the JSON is deterministic across DB backends and
    UUID/int PK types.
    """

    return {
        "schema_version": action.schema_version,
        "sequence": action.sequence,
        "actor_kind": action.actor_kind,
        "actor_token_prefix": action.actor_token_prefix,
        "principal_id": str(action.principal_id) if action.principal_id else None,
        "action": action.action,
        "method": action.method,
        "object_type": action.object_type,
        "object_id": action.object_id,
        "project_id": str(action.project_id) if action.project_id else None,
        "capability_used": action.capability_used,
        "verdict": action.verdict,
        "refusal_reason": action.refusal_reason,
        "payload_hash": action.payload_hash,
        "engine_version": action.engine_version,
        # summary + source_ip are hashed too so the human-readable narrative and the
        # recorded origin are tamper-evident, not just the structured decision fields.
        "summary": action.summary,
        "source_ip": action.source_ip,
        # ISO-8601 with tz; the exact string is fixed at write time and rehashed here.
        "occurred_at": action.occurred_at.isoformat(),
    }


def canonical_json(fields: dict[str, object]) -> str:
    """Deterministic JSON: sorted keys, no incidental whitespace."""

    return json.dumps(fields, sort_keys=True, separators=(",", ":"))


def compute_record_hash(prev_hash: str, fields: dict[str, object]) -> str:
    """``sha256(prev_hash ‖ '\\n' ‖ canonical_json(fields))`` as lowercase hex.

    The newline separator domain-separates the (fixed-length hex) ``prev_hash`` from the
    canonical body so no body could ever be constructed to collide with a prev_hash
    boundary.
    """

    payload = f"{prev_hash}\n{canonical_json(fields)}".encode()
    return hashlib.sha256(payload).hexdigest()
