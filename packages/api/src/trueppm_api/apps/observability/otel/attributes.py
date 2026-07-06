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

__all__ = [
    "BOARD_ID",
    "NAMESPACE",
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
