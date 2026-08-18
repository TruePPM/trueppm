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

Emitted vs reserved (#2880)
---------------------------
Additive-only makes the key set a promise, so the promise has to distinguish a key
OSS actually writes from one it merely owns. Seven of the eight original span keys
had **zero** emit sites — a collector-side processor keyed on ``trueppm.task.id``
silently never fired, and the only test covering them asserted that the strings
started with ``trueppm.``, which is coverage of the constant rather than of
emission. :data:`EMITTED_SPAN_ATTRIBUTES` and :data:`RESERVED_SPAN_ATTRIBUTES`
partition :data:`SPAN_ATTRIBUTES` so the distinction is machine-checkable: a new
constant that lands in neither set fails ``test_otel_attribute_contract``, and every
emitted key is asserted against a span the real consumer produced.

Reserved keys are kept (removing a constant would break an enterprise import) but
carry the reason they are not emitted, next to the constant. Do not read a reserved
key as "not implemented yet" — two of the three name a fact this data model does not
have, and the third duplicates a resource attribute.

Actor attributes and privacy
----------------------------
``trueppm.user.*`` is the only part of the namespace that attributes a span to a
person. The policy, enforced by :mod:`.request_attributes`, is: the opaque primary
key and the symbolic project role, and **nothing else** — never an email, username,
display name, or client IP, which is why no key for them exists here. Operators who
must not export a per-user identifier at all set
``TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED=false`` (Helm:
``observability.otlp.actorAttributes``); resource identity is unaffected.
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
"""Project UUID. On the HTTP server span for any project-scoped route, and on the
CPM / Monte Carlo engine spans."""
PROJECT_KEY = "trueppm.project.key"
"""RESERVED — not emitted. There is no ``Project.key``: the human-readable short
code is ``Project.code``, which is blank by default and not an identifier. The
additive-only rule forbids renaming this to ``trueppm.project.code``, so the key is
kept and left unwritten rather than filled with something it does not name. Use
``trueppm.project.id``."""
PROGRAM_ID = "trueppm.program.id"
"""Program UUID. On the HTTP server span for any program-scoped route."""
TASK_ID = "trueppm.task.id"
"""Task UUID. On the HTTP server span for a task-scoped route."""
BOARD_ID = "trueppm.board.id"
"""RESERVED — not emitted. TruePPM has no board entity to identify: a board is a
view of a project (``BoardColumnConfig`` / ``BoardSavedView`` are project-scoped
config rows), and the board WebSocket group and ``broadcast_board_event()`` both fan
out on the *project* id. A board-scoped consumer keys on ``trueppm.project.id``."""
USER_ID = "trueppm.user.id"
"""Acting user's primary key, on the HTTP server span. Opaque UUID only — see the
actor-attribute policy in this module's docstring. Suppressed by
``TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED=false``."""
USER_ROLE = "trueppm.user.role"
"""Symbolic project role the request was authorized under (``VIEWER`` | ``MEMBER`` |
``SCHEDULER`` | ``ADMIN`` | ``OWNER``), on the HTTP server span.

Only set when it is well defined: TruePPM roles are PROJECT-scoped (ADR-0072), so a
request that resolved exactly one project carries that project's role and a list
endpoint spanning many projects carries none — an arbitrary pick would be worse than
absent. Read from the RBAC layer's per-request role cache, so it costs no extra
query. Suppressed by ``TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED=false``."""
SCHEDULE_RECOMPUTE_REASON = "trueppm.schedule.recompute_reason"
# CPM / Monte Carlo engine-span sizing attributes (Phase 1, #709). These are the
# few low-cardinality shape facts worth attaching to a scheduling-engine span so an
# operator can correlate latency with graph size without opening the payload.
SCHEDULE_TASK_COUNT = "trueppm.schedule.task_count"
SCHEDULE_DEPENDENCY_COUNT = "trueppm.schedule.dependency_count"
SCHEDULE_CRITICAL_COUNT = "trueppm.schedule.critical_count"
SCHEDULE_SIMULATION_COUNT = "trueppm.schedule.simulation_count"
REQUEST_EDITION = "trueppm.request.edition"
"""RESERVED — not emitted. Duplicates :data:`RESOURCE_EDITION` (``trueppm.edition``),
which the provider sets on the ``Resource`` and every backend therefore attaches to
every span from the process. Edition cannot vary between two requests to the same
process, so a per-span copy carries no information and only multiplies payload. Group
by ``trueppm.edition``."""

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
# Distinct from TASK_ID (``trueppm.task.id``, a domain project Task row) — these
# dimension a Celery task *execution*, not a project Task (#1917).
CELERY_TASK_NAME = "trueppm.celery.task_name"
"""Celery task's registered name, e.g. ``scheduling.recalculate``."""
CELERY_TASK_OUTCOME = "trueppm.celery.outcome"
"""Lower-cased terminal Celery state for one execution: ``success`` | ``failure`` |
``retry`` | etc."""

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

# --- Emitted / reserved partition (#2880) ----------------------------------
# Every span-attribute key this module owns, and the two-way split that says which
# of them OSS actually writes. `test_otel_attribute_contract` asserts (a) the split
# partitions SPAN_ATTRIBUTES exactly — so a new constant that is classified in
# neither set fails the suite rather than joining the published surface unnoticed —
# and (b) each EMITTED key appears on a span produced by RUNNING its consumer, not
# merely that the string is well formed. Metric dimensions are a separate surface
# (their emission is covered by test_otel_metrics) and are deliberately not listed.
SPAN_ATTRIBUTES: tuple[str, ...] = (
    PROJECT_ID,
    PROJECT_KEY,
    PROGRAM_ID,
    TASK_ID,
    BOARD_ID,
    USER_ID,
    USER_ROLE,
    SCHEDULE_RECOMPUTE_REASON,
    SCHEDULE_TASK_COUNT,
    SCHEDULE_DEPENDENCY_COUNT,
    SCHEDULE_CRITICAL_COUNT,
    SCHEDULE_SIMULATION_COUNT,
    REQUEST_EDITION,
    AGENT_TOKEN_PREFIX,
    AGENT_CAPABILITY,
    AGENT_ACTOR_KIND,
    AGENT_VERDICT,
)
"""Every ``trueppm.*`` span-attribute key this module publishes."""

EMITTED_SPAN_ATTRIBUTES: frozenset[str] = frozenset(
    {
        PROJECT_ID,
        PROGRAM_ID,
        TASK_ID,
        USER_ID,
        USER_ROLE,
        SCHEDULE_RECOMPUTE_REASON,
        SCHEDULE_TASK_COUNT,
        SCHEDULE_DEPENDENCY_COUNT,
        SCHEDULE_CRITICAL_COUNT,
        SCHEDULE_SIMULATION_COUNT,
        AGENT_TOKEN_PREFIX,
        AGENT_CAPABILITY,
        AGENT_ACTOR_KIND,
        AGENT_VERDICT,
    }
)
"""Keys OSS writes to a real span. A backend processor may key on these."""

RESERVED_SPAN_ATTRIBUTES: frozenset[str] = frozenset(
    {
        PROJECT_KEY,
        BOARD_ID,
        REQUEST_EDITION,
    }
)
"""Keys the namespace owns but OSS never writes. Each constant's docstring gives the
reason, and none of them is "not yet implemented": two name a fact this data model
does not have, and the third duplicates a resource attribute. A processor keyed on
one of these will never fire."""

__all__ = [
    "AGENT_ACTOR_KIND",
    "AGENT_CAPABILITY",
    "AGENT_TOKEN_PREFIX",
    "AGENT_VERDICT",
    "BOARD_ID",
    "BROKER_QUEUE",
    "CELERY_TASK_NAME",
    "CELERY_TASK_OUTCOME",
    "DB_STATE",
    "EMITTED_SPAN_ATTRIBUTES",
    "NAMESPACE",
    "OUTBOX_NAME",
    "OUTBOX_STATE",
    "PROGRAM_ID",
    "PROJECT_ID",
    "PROJECT_KEY",
    "REQUEST_EDITION",
    "RESERVED_SPAN_ATTRIBUTES",
    "RESOURCE_EDITION",
    "RESOURCE_SERVICE_NAME",
    "RESOURCE_SERVICE_NAMESPACE",
    "RESOURCE_SERVICE_VERSION",
    "SCHEDULE_CRITICAL_COUNT",
    "SCHEDULE_DEPENDENCY_COUNT",
    "SCHEDULE_RECOMPUTE_REASON",
    "SCHEDULE_SIMULATION_COUNT",
    "SCHEDULE_TASK_COUNT",
    "SPAN_ATTRIBUTES",
    "TASK_ID",
    "USER_ID",
    "USER_ROLE",
]
