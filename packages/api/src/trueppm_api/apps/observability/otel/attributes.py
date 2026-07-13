"""Canonical ``trueppm.*`` OpenTelemetry attribute-key convention (ADR-0223).

This module is the single source of truth for the span- and resource-attribute
key strings TruePPM emits. Every emitter — the OSS Phase 1/2 instrumentation and
the proprietary enterprise edition alike — imports these constants instead of
hand-typing the strings, so the namespace stays consistent and collision-free
across the two repositories.

Namespace ownership (ADR-0223 §3):

* **OSS-owned** sub-namespaces: ``trueppm.project.*``, ``trueppm.program.*``,
  ``trueppm.task.*``, ``trueppm.board.*``, ``trueppm.user.*``,
  ``trueppm.schedule.*``, ``trueppm.request.*``, and ``trueppm.edition``.
* **Enterprise-reserved** sub-namespaces (OSS never emits these, so there is no
  collision): ``trueppm.portfolio.*``, ``trueppm.governance.*``,
  ``trueppm.tenant.*``.

Attributes that are not a business fact TruePPM owns MUST use the appropriate
OTel semantic-convention key (``http.*``, ``db.*``, ``messaging.*``) rather than
being forced under ``trueppm.*``.

The contract is **additive-only**: new keys may be added, but existing keys are
never renamed or removed, because the enterprise edition depends on them.
"""

from __future__ import annotations

# Root namespace for every TruePPM-owned attribute and the resource namespace.
NAMESPACE = "trueppm"
"""Root prefix for all TruePPM-owned OpenTelemetry attributes."""

# --- Resource attributes (set once, at provider build time) ----------------
# service.name / service.version / service.namespace are OTel-standard resource
# keys; trueppm.edition is our own, so a backend can split OSS vs enterprise
# traffic without parsing anything else.
RESOURCE_SERVICE_NAME = "service.name"
RESOURCE_SERVICE_VERSION = "service.version"
RESOURCE_SERVICE_NAMESPACE = "service.namespace"
RESOURCE_EDITION = "trueppm.edition"

# --- Span attributes (OSS-owned) -------------------------------------------
PROJECT_ID = "trueppm.project.id"
PROJECT_KEY = "trueppm.project.key"
PROGRAM_ID = "trueppm.program.id"
TASK_ID = "trueppm.task.id"
BOARD_ID = "trueppm.board.id"
USER_ID = "trueppm.user.id"
USER_ROLE = "trueppm.user.role"
SCHEDULE_RECOMPUTE_REASON = "trueppm.schedule.recompute_reason"
# CPM / Monte Carlo engine-span sizing attributes (Phase 1, #709). These are the
# few low-cardinality shape facts worth attaching to a scheduling-engine span so an
# operator can correlate latency with graph size without opening the payload.
SCHEDULE_TASK_COUNT = "trueppm.schedule.task_count"
SCHEDULE_DEPENDENCY_COUNT = "trueppm.schedule.dependency_count"
SCHEDULE_CRITICAL_COUNT = "trueppm.schedule.critical_count"
SCHEDULE_SIMULATION_COUNT = "trueppm.schedule.simulation_count"
REQUEST_EDITION = "trueppm.request.edition"

# --- Metric-dimension attributes (Phase 2, #710) ---------------------------
# Low-cardinality dimensions on the native OTLP metrics. These are TruePPM-owned
# facts (which outbox, which lifecycle state, which server-side connection state),
# so they live under trueppm.* rather than a semantic-convention key. The metric
# names themselves (e.g. ``trueppm.outbox.depth``) are a separate namespace owned
# by ``otel.metrics`` and are documented there.
OUTBOX_NAME = "trueppm.outbox.name"
"""Which transactional outbox a measurement is for: ``schedule`` | ``workflow``."""
OUTBOX_STATE = "trueppm.outbox.state"
"""The outbox-row lifecycle state a depth measurement counts: ``pending`` | ``dispatched``."""
DB_STATE = "trueppm.db.state"
"""PostgreSQL backend state bucket: ``active`` | ``idle`` | ``idle_in_transaction`` | ``other``."""
BROKER_QUEUE = "messaging.destination.name"
"""Celery broker queue name a depth measurement is for (e.g. ``celery``).

A broker queue is not a TruePPM-owned business fact, so per the namespace rule at
the top of this module it uses the OTel ``messaging.*`` semantic-convention key
rather than being forced under ``trueppm.*``."""

# --- Agent / MCP span attributes (OSS-owned, ADR-0112 RC1, #1805) ----------
# Set on the request span when an MCP/agent token acts, so an operator can attribute
# a read (or a refusal) to a token + scope + actor kind without opening the payload.
# NEVER carries token material — only the 8-char prefix.
AGENT_TOKEN_PREFIX = "trueppm.agent.token_prefix"
"""First 8 hex chars of the acting API token — never the token itself."""
AGENT_CAPABILITY = "trueppm.agent.capability"
"""The scope/capability that authorized (or was checked for) the action, e.g. ``mcp:read``."""
AGENT_ACTOR_KIND = "trueppm.agent.actor_kind"
"""The actor kind, e.g. ``mcp_token`` (ADR-0112 §1)."""
AGENT_VERDICT = "trueppm.agent.verdict"
"""The decision outcome: ``allowed`` | ``refused`` | ``requires_approval``."""

__all__ = [
    "AGENT_ACTOR_KIND",
    "AGENT_CAPABILITY",
    "AGENT_TOKEN_PREFIX",
    "AGENT_VERDICT",
    "BOARD_ID",
    "BROKER_QUEUE",
    "DB_STATE",
    "NAMESPACE",
    "OUTBOX_NAME",
    "OUTBOX_STATE",
    "PROGRAM_ID",
    "PROJECT_ID",
    "PROJECT_KEY",
    "REQUEST_EDITION",
    "RESOURCE_EDITION",
    "RESOURCE_SERVICE_NAME",
    "RESOURCE_SERVICE_NAMESPACE",
    "RESOURCE_SERVICE_VERSION",
    "SCHEDULE_CRITICAL_COUNT",
    "SCHEDULE_DEPENDENCY_COUNT",
    "SCHEDULE_RECOMPUTE_REASON",
    "SCHEDULE_SIMULATION_COUNT",
    "SCHEDULE_TASK_COUNT",
    "TASK_ID",
    "USER_ID",
    "USER_ROLE",
]
