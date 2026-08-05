"""Carry the refusal taxonomy to the caller that triggered it (ADR-0809, #2689).

The API models a genuine two-axis refusal taxonomy — ``AgentActionRefusalReason``
(identity | policy) and ``RefusalConstraint`` (which specific guard fired) — and
records it, hash-chained, on every refused agent call. None of it reached the
caller. An agent operator saw DRF's constant ``PermissionDenied.default_detail``
and had to make a *second*, separate call to ``GET /agent-actions/?constraint=…``
to learn why. "Computed, not guessed" names **refuse** as one of its four parts;
a system that fails without saying why is the worst outcome for the persona 0.4
is sold on.

Three design points, each load-bearing:

**The guards still return ``False``.** They are fail-closed by construction and
that is not worth trading for a richer body. Instead a denying guard *marks* the
request with the taxonomy, and this module's envelope is attached centrally by
:mod:`trueppm_api.core.exception_handlers`. A guard that forgets to mark still
denies — it simply denies with the generic detail, which is exactly the
pre-existing behavior.

**Disclosure is an allow-list, not a pass-through.** A constraint code is only
serialized if it is in :data:`DISCLOSABLE_CONSTRAINTS`. The two live producers
(``TOKEN_IDENTITY``, ``CAPABILITY_SCOPE``) describe the *caller's own token* and
disclose nothing about resources. The four reserved schedule constraints
(``GRAPH_VALIDATION``, ``SPRINT_SOVEREIGNTY``, ``ROLLUP_LOCK``,
``ENGINE_REFEREE``) describe the *plan*, and a constraint naming a task the caller
may not read is an information leak. They have no producer today; when 0.6 wires
them, adding each to the allow-list is a deliberate disclosure decision rather
than something that happens by default.

**Only token callers get the envelope.** A human JWT/session 403 is unchanged, so
this is not a contract change for the web client — the refusal envelope exists for
the agent surface that has no other channel.
"""

from __future__ import annotations

from typing import Any

from trueppm_api.apps.agents.models import (
    AgentActionRefusalReason,
    AgentActionVerdict,
    RefusalConstraint,
)

#: Request attribute carrying ``(reason, constraint)`` from the guard that denied.
#: Underscore-prefixed to match the existing ``_mcp_scope_filtered`` convention for
#: request-local markers set by a permission class and read after the fact.
REFUSAL_MARKER = "_trueppm_refusal"

#: Constraint codes safe to return to a caller that was just denied.
#:
#: Both members describe the caller's own credential, so disclosing them tells the
#: caller nothing they did not already supply. Every other member of
#: ``RefusalConstraint`` describes the *schedule*, and is deliberately absent:
#: naming ``sprint_sovereignty`` on a sprint the caller cannot read would leak the
#: existence and state of that sprint. Adding one here is a disclosure decision.
DISCLOSABLE_CONSTRAINTS: frozenset[str] = frozenset(
    {
        RefusalConstraint.TOKEN_IDENTITY,
        RefusalConstraint.CAPABILITY_SCOPE,
    }
)


def mark_refusal(request: Any, reason: str, constraint: str = "") -> None:
    """Record on *request* why this call is being refused.

    Called by a guard immediately before it returns ``False`` (or raises). Marking
    is advisory: an unmarked refusal still refuses, it just carries no taxonomy.
    The first mark wins — the guards are ANDed and evaluated in order, so the
    first one to deny is the one that actually decided.
    """

    if getattr(request, REFUSAL_MARKER, None) is None:
        setattr(request, REFUSAL_MARKER, (reason, constraint))


def refusal_marks(request: Any) -> tuple[str, str] | None:
    """Return ``(reason, constraint)`` marked on *request*, or ``None``."""

    marks = getattr(request, REFUSAL_MARKER, None)
    if isinstance(marks, tuple) and len(marks) == 2:
        return marks
    return None


def build_refusal_payload(reason: str, constraint: str = "") -> dict[str, str]:
    """The wire form of a refusal: verdict, reason, and (if disclosable) constraint.

    ``verdict`` is included even though it is constant for a refusal, so a client
    can branch on one field across the whole taxonomy rather than inferring the
    verdict from the presence of the envelope — and so the wire shape lines up with
    the ``AgentAction`` record it describes.
    """

    payload = {
        "verdict": str(AgentActionVerdict.REFUSED),
        "reason": str(reason or AgentActionRefusalReason.POLICY),
    }
    if constraint and constraint in DISCLOSABLE_CONSTRAINTS:
        payload["constraint"] = str(constraint)
    return payload
