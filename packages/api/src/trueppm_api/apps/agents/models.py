"""Agent-action audit models — the OSS hash-chained audit substrate (ADR-0112 RC1/RC2, #1805).

Every MCP/agent decision (a read, or a refusal) is recorded as one append-only
``AgentAction`` row. The rows form a **per-instance, hash-chained** log: each row
stores a monotonic ``sequence`` and ``record_hash = sha256(prev_hash ‖ canonical(record))``
where ``prev_hash`` is the predecessor row's ``record_hash``. A team can therefore
detect whether its own log was altered on its own instance via
``manage.py audit_verify`` — the OSS integrity self-check (the audit-log analog of the
answer-stamp hash). Org-scale compliance *evidence* (external notarization, a
cryptographic signature over the chain, retention policy, cross-instance trail) is the
Enterprise value-add (#146); this OSS log detects local tampering, it does not notarize.

RC2: the ``sequence`` and chain are **per-instance / per-workspace**, not per-tenant —
TruePPM is single-tenant/self-hosted. The chain head is a single row
(``AgentActionChainHead``); ``record_agent_action`` serializes appends with a
``select_for_update`` on it, so the chain is strictly gap-free and ordered.

Both models are plain ``models.Model`` (not ``VersionedModel``): append-only audit rows
are never synced to mobile and immutability makes ``server_version`` unnecessary — the
same rationale as ``ApiTokenAuditEntry`` and the ADR-0176 sprint-outcome snapshots.
"""

from __future__ import annotations

import hashlib
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

#: Schema version of the ``AgentAction`` record + the canonical hash input. Bumped only
#: on a breaking change to the chained field set or the canonicalization (which would be
#: a chain-format break). Enterprise receivers branch on this (ADR-0112 contract).
AGENT_ACTION_SCHEMA_VERSION = 1

#: The genesis ``prev_hash`` for the first row in a fresh chain. A fixed, versioned
#: domain-separated constant so the chain root is deterministic and reproducible across
#: instances (it is not secret — it anchors the chain, it does not authenticate it).
GENESIS_PREV_HASH = hashlib.sha256(b"trueppm/agents/agent-action/genesis/v1").hexdigest()


class AgentActorKind(models.TextChoices):
    """What kind of actor performed the action.

    Phase 0 (#1805) only ever records ``MCP_TOKEN`` — a personal ``mcp:read`` API
    token acting on the MCP read surface. The fuller first-class agent-actor kinds
    arrive with #1063 (0.5); the field exists now so the vocabulary is stable.
    """

    MCP_TOKEN = "mcp_token", "MCP token"


class AgentActionVerdict(models.TextChoices):
    """The decision outcome recorded for the action (ADR-0112 RC1)."""

    ALLOWED = "allowed", "Allowed"
    REFUSED = "refused", "Refused"
    REQUIRES_APPROVAL = "requires_approval", "Requires approval"


class AgentActionRefusalReason(models.TextChoices):
    """Why a ``REFUSED`` action was refused (ADR-0112 RC1).

    ``IDENTITY`` — no/invalid actor (a revoked or expired token was presented).
    ``POLICY`` — actor known, but a capability/permission (or, later, an approval)
    was denied. Recorded from day one so the log answers *why* a decision went the
    way it did, not merely *that* it did.
    """

    IDENTITY = "identity", "Identity"
    POLICY = "policy", "Policy"


class RefusalConstraint(models.TextChoices):
    """Which constraint fired for a refusal (ADR-0421, #1850).

    A **finer** axis than ``AgentActionRefusalReason`` (identity|policy): the coarse
    reason answers *which layer* refused, this answers *which specific guard*. Recorded
    on the non-hashed ``AgentActionRefusalDetail`` side-car so it is queryable for
    engineering triage ("show me every ``graph_validation`` refusal") without touching
    the hash-chained record. The vocabulary is forward-compatible by addition — the two
    ``*_scope``/``*_identity`` codes have live producers today; the remaining four are
    reserved for the 0.6 gated-write producers (ADR-0362 §7) so those slot in with no
    schema change.
    """

    CAPABILITY_SCOPE = "capability_scope", "Capability scope"
    TOKEN_IDENTITY = "token_identity", "Token identity"
    # Reserved for the 0.6 gated-write surface (ADR-0362 §4 refusal-engine v1); no
    # producer emits these yet — the enum reserves the codes so they slot in later.
    GRAPH_VALIDATION = "graph_validation", "Graph validation"
    SPRINT_SOVEREIGNTY = "sprint_sovereignty", "Sprint sovereignty"
    ROLLUP_LOCK = "rollup_lock", "Rollup lock"
    ENGINE_REFEREE = "engine_referee", "Engine referee"


class AgentActionChainHead(models.Model):
    """Singleton head of the per-instance hash chain (ADR-0112 RC2).

    Holds the last allocated ``sequence`` and the last row's ``record_hash`` so a new
    append reads the predecessor link under a single ``select_for_update`` lock. The row
    is seeded (id=1, sequence=0, hash=genesis) by the initial migration so the service
    can ``select_for_update().get(pk=1)`` without a create race on the first request.
    """

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    last_sequence = models.BigIntegerField(
        default=0,
        help_text="Highest sequence allocated so far (0 before the first record).",
    )
    last_record_hash = models.CharField(
        max_length=64,
        default=GENESIS_PREV_HASH,
        help_text="record_hash of the most recent AgentAction — the next row's prev_hash.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agents_agent_action_chain_head"
        constraints = [
            # Enforce the singleton at the DB level: only id=1 may exist.
            models.CheckConstraint(
                condition=Q(id=1),
                name="agent_action_chain_head_singleton",
            ),
        ]

    def __str__(self) -> str:
        return f"AgentActionChainHead(seq={self.last_sequence})"


class AgentAction(models.Model):
    """One append-only, hash-chained record of an MCP/agent decision (ADR-0112 RC1, #1805).

    Never updated in place. Rows are removed only by chain-aware pruning (``audit_prune``,
    ADR-0361), which deletes a contiguous oldest-prefix and writes an
    ``AgentActionCheckpoint`` so ``audit_verify`` re-anchors and the surviving tail still
    verifies; a delete *without* that checkpoint still surfaces as a break. ``token_prefix``
    and the denormalized identity fields are preserved after the parent token/user is deleted
    (the FKs are SET_NULL) so a row stays identifiable and its hash stays valid.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    schema_version = models.PositiveSmallIntegerField(
        default=AGENT_ACTION_SCHEMA_VERSION,
        help_text="AGENT_ACTION_SCHEMA_VERSION at write time (part of the hashed record).",
    )

    # --- actor + human principal ------------------------------------------------
    actor_kind = models.CharField(max_length=16, choices=AgentActorKind.choices)
    actor_token = models.ForeignKey(
        "projects.ApiToken",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="agent_actions",
        help_text="The API token that acted. SET_NULL — a deleted token leaves its "
        "audit trail behind (identified by actor_token_prefix).",
    )
    actor_token_prefix = models.CharField(
        max_length=8,
        db_index=True,
        help_text="First 8 hex chars of the acting token — denormalized, never the "
        "token material. Preserved after token deletion.",
    )
    principal = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="agent_actions_as_principal",
        help_text="The human on whose behalf the actor acted (the token owner). "
        "SET_NULL so the row survives account deletion.",
    )

    # --- what was attempted -----------------------------------------------------
    action = models.CharField(
        max_length=128,
        help_text="Stable operation identifier (e.g. the MCP tool / view name).",
    )
    method = models.CharField(max_length=8, help_text="HTTP method (GET, POST, …).")
    object_type = models.CharField(max_length=64, blank=True, default="")
    object_id = models.CharField(max_length=64, blank=True, default="")
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="agent_actions",
        help_text="The project in scope, when resolvable from the request.",
    )
    capability_used = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="The scope/capability that authorized (or was checked for) the "
        "action, e.g. 'mcp:read'.",
    )

    # --- verdict ----------------------------------------------------------------
    verdict = models.CharField(max_length=20, choices=AgentActionVerdict.choices)
    refusal_reason = models.CharField(
        max_length=16,
        choices=AgentActionRefusalReason.choices,
        blank=True,
        default="",
        help_text="Set (identity|policy) when verdict=refused; empty otherwise.",
    )

    # --- reproducibility anchor (ADR-0112 §2 / #1065) ---------------------------
    payload_hash = models.CharField(
        max_length=64,
        help_text="sha256 over the canonicalized operation payload (method, path, "
        "sorted query, body shape) — the reproducibility anchor for the request.",
    )
    engine_version = models.CharField(
        max_length=64,
        help_text="trueppm-scheduler version at decision time (the answer-stamp engine anchor).",
    )

    # --- chain link -------------------------------------------------------------
    sequence = models.BigIntegerField(
        unique=True,
        help_text="Per-instance monotonic sequence (RC2). Gap-free and strictly "
        "increasing; a gap or reorder is a tamper signal.",
    )
    prev_hash = models.CharField(
        max_length=64,
        help_text="record_hash of the predecessor row (GENESIS_PREV_HASH for the first).",
    )
    record_hash = models.CharField(
        max_length=64,
        unique=True,
        help_text="sha256(prev_hash ‖ canonical(record)) — the chain link. Recomputed "
        "and checked by `manage.py audit_verify`.",
    )

    summary = models.TextField(blank=True, default="", help_text="Human-readable, team-facing.")
    source_ip = models.GenericIPAddressField(null=True, blank=True)
    occurred_at = models.DateTimeField(
        db_index=True,
        help_text="Set explicitly at write time (NOT auto_now_add) because its exact "
        "value is part of the hashed record.",
    )

    class Meta:
        db_table = "agents_agent_action"
        ordering = ["sequence"]
        indexes = [
            models.Index(fields=["project", "-occurred_at"], name="agent_action_proj_idx"),
            models.Index(fields=["principal", "-occurred_at"], name="agent_action_princ_idx"),
        ]

    def __str__(self) -> str:
        return f"AgentAction(#{self.sequence} {self.action} {self.verdict})"


class AgentActionCheckpoint(models.Model):
    """Immutable re-anchor written when the oldest ``AgentAction`` rows are pruned (ADR-0361).

    Chain-aware pruning (``manage.py audit_prune``) deletes a contiguous **prefix** of the
    oldest rows. Because ``audit_verify`` recomputes each row's ``record_hash`` from its
    predecessor's, deleting that predecessor would break verification of the first surviving
    row. This checkpoint stores exactly what the verifier re-seeds from: the ``record_hash``
    of the last-deleted row (the surviving tail's ``prev_hash``) and the sequence at which
    the retained chain resumes.

    One row is written per prune that actually deletes rows; ``audit_verify`` seeds from the
    **latest** checkpoint (highest ``pruned_through_sequence``). It is append-only — an
    integrity-continuity artifact that keeps the OSS self-check passing across a legitimate
    prune, **not** compliance evidence. Signing, notarizing, or hash-chaining the checkpoints
    for an external auditor is the Enterprise value-add (ADR-0112 §3, #146), not built here.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    pruned_through_sequence = models.BigIntegerField(
        unique=True,
        help_text="Highest AgentAction.sequence deleted by this prune; the retained chain "
        "resumes at pruned_through_sequence + 1.",
    )
    pruned_through_hash = models.CharField(
        max_length=64,
        help_text="record_hash of the last-deleted row — the prev_hash the first surviving "
        "row points at, and the seed audit_verify re-anchors from.",
    )
    first_retained_sequence = models.BigIntegerField(
        help_text="Sequence of the lowest surviving row (pruned_through_sequence + 1); "
        "audit_verify asserts the retained chain starts here.",
    )
    pruned_count = models.BigIntegerField(help_text="Number of rows deleted by this prune.")
    pruned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="agent_action_prunes",
        help_text="The user who ran the prune, when known. SET_NULL so the row survives "
        "account deletion.",
    )
    created_at = models.DateTimeField(help_text="When the prune ran (set at write time).")

    class Meta:
        db_table = "agents_agent_action_checkpoint"
        ordering = ["pruned_through_sequence"]

    def __str__(self) -> str:
        return (
            f"AgentActionCheckpoint(through={self.pruned_through_sequence}, "
            f"count={self.pruned_count})"
        )


class AgentActionRefusalDetail(models.Model):
    """Non-hashed 1:1 telemetry side-car for a refused ``AgentAction`` (ADR-0421, #1850).

    Records *which constraint fired* and the *projected impact* of a refusal so the
    refusal moment (ADR-0362 §4) is queryable for engineering triage and demo capture.
    It lives **outside** the hash-chained record on purpose: ``canonical_fields`` and
    ``audit_verify`` never see it, so ``AGENT_ACTION_SCHEMA_VERSION`` stays 1 and the
    chain is byte-for-byte unchanged. The load-bearing decision (``verdict`` +
    ``refusal_reason``) remains tamper-evident on the chain; this finer explanation is
    telemetry, not the audited decision. Making the ``constraint`` code tamper-evident is
    a deliberate ``schema_version=2`` graduation for *when real producers exist* (0.6),
    not a speculative bump now (ADR-0421 Consequences).

    ``on_delete=CASCADE`` is intended: a chain-aware prune (ADR-0361) that deletes an
    ``AgentAction`` takes its explanatory detail with it — the detail is worthless
    without its row, and being unhashed, cascading it never affects ``audit_verify``.
    """

    action = models.OneToOneField(
        AgentAction,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="refusal_detail",
        help_text="The refused AgentAction this detail explains (1:1, PK).",
    )
    constraint = models.CharField(
        max_length=32,
        choices=RefusalConstraint.choices,
        help_text="Which specific guard fired — a finer axis than the chain's "
        "refusal_reason (identity|policy).",
    )
    projected_impact = models.JSONField(
        default=dict,
        blank=True,
        help_text="Structured projected schedule impact of the refused write. Empty {} "
        "for the current MCP-scope/identity producers (no schedule impact); the 0.6 "
        "gated-write producers populate {affected_task_count, slip_days, "
        "critical_path_delta_days, affected_task_ids}.",
    )

    class Meta:
        db_table = "agents_agent_action_refusal_detail"
        indexes = [
            # Powers the ?constraint= triage filter ("show me every graph_validation
            # refusal") without a full scan of the side-car.
            models.Index(fields=["constraint"], name="agent_refusal_constraint_idx"),
        ]

    def __str__(self) -> str:
        return f"AgentActionRefusalDetail({self.constraint} for {self.action_id})"
