"""Celery worker file-touch heartbeat for the Helm chart's readiness/startup
probes (#3346).

Why this exists: the chart's celery-worker readiness probe used to run
``celery inspect ping``, a control-plane round trip handled by the worker's
MainProcess. An **exec probe runs INSIDE the container it measures**, so under
load the same process that is servicing the prefork pool can miss the ping's
window and fail the probe while doing exactly the work it exists to do — this
is #3236: a worker with 0 restarts, processing jobs throughout, that never
answered a single readiness probe. Widening the probe's timing cannot fix
this; readiness has no failure budget to widen (one success is all it needs,
and a probe that never gets one cannot be repaired by any timing value).

This module replaces that mechanism for readiness (and adds a startup check)
with a file whose mtime is refreshed by Celery's own internal ``heartbeat_sent``
signal — fired by the worker's ``Heart`` service on a fixed timer
(``~2s`` by default) that runs on the MainProcess's own event loop, entirely
independent of whether the prefork pool is idle or saturated. Touching a file
costs nothing proportional to worker load, so the probe that reads it
(``find <file> -newermt "-Ns"``, wired in the Helm chart) is a plain filesystem
stat with no fork of Django, Celery, or a broker round trip — and therefore
cannot be starved by the very load it is meant to tolerate.

``worker_ready`` (fired once, after mingle/gossip complete — i.e. once the
broker connection is genuinely established) provides the STARTUP signal: the
chart's worker startup probe only checks that the file exists at all, which is
true exactly when this fires for the first time. ``worker_shutting_down``
removes the file so a worker that announces its own graceful shutdown drops
out of readiness immediately rather than waiting for the staleness window to
elapse.

Liveness keeps ``celery inspect ping`` (unchanged, see ``_helpers.tpl``): a
missed liveness check only restarts the container, a bounded cost the chart's
termination-grace math already accounts for, whereas a false readiness failure
had no such budget. Replacing only the mechanism with something to lose is the
narrower, lower-risk fix.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from celery.signals import heartbeat_sent, worker_ready, worker_shutting_down

logger = logging.getLogger(__name__)

# Matches the Helm chart's probes.worker.heartbeatFile default (#3346) — the
# two must agree, since the chart's exec probe reads exactly this path inside
# the container. /tmp is the worker container's only writable mount
# (readOnlyRootFilesystem is on; see celery-worker/deployment.yaml).
_DEFAULT_HEARTBEAT_FILE = "/tmp/trueppm-celery-worker-heartbeat"


def heartbeat_file() -> Path:
    """Return the configured heartbeat file path.

    Read from the environment on every call (not cached at import time) so a
    test can override ``TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE`` per-case without
    needing to reload this module.
    """
    return Path(os.environ.get("TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE", _DEFAULT_HEARTBEAT_FILE))


def _touch(path: Path) -> None:
    """Create ``path`` if absent and bump its mtime to now.

    Errors are logged, never raised: a failure to write the heartbeat file
    must not crash task processing — it should only ever show up as the
    readiness probe going stale, which is the correct, visible failure mode.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        os.utime(path, None)
    except OSError:
        logger.warning("worker_heartbeat: could not touch %s", path, exc_info=True)


def _remove(path: Path) -> None:
    """Delete ``path`` if present. Errors are logged, never raised."""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("worker_heartbeat: could not remove %s", path, exc_info=True)


def _on_worker_ready(**_kwargs: object) -> None:
    """First touch: fires once mingle/gossip complete — broker connection is up.

    This is the STARTUP signal the chart's ``probes.worker.startup`` check
    reads (mere existence of the file, not freshness).
    """
    _touch(heartbeat_file())


def _on_heartbeat_sent(**_kwargs: object) -> None:
    """Refresh the file on every internal Celery heartbeat tick (~2s default).

    Fired from the worker's own timer/event-loop thread, not from a task
    execution context, so its cadence does not slow down — or speed up —
    with task load. This is the READINESS signal the chart's
    ``probes.worker.readiness`` check reads (freshness within a staleness
    window).
    """
    _touch(heartbeat_file())


def _on_worker_shutting_down(**_kwargs: object) -> None:
    """Drop the file immediately on a graceful shutdown request.

    Without this a worker that is winding down still reads Ready until the
    staleness window elapses. Best-effort only — a hard kill (OOM, SIGKILL)
    skips this signal entirely, which is fine: the staleness window is exactly
    the backstop for that case.
    """
    _remove(heartbeat_file())


# Connected as plain calls rather than via the `@signal.connect` decorator
# form: celery's `Signal.connect` has no type stubs, and mypy --strict flags
# the decorator form as an "untyped decorator" (it cannot see through it to
# confirm these functions still match their declared signature). A bare call
# has no such effect — its unused return value is simply discarded.
worker_ready.connect(_on_worker_ready)
heartbeat_sent.connect(_on_heartbeat_sent)
worker_shutting_down.connect(_on_worker_shutting_down)
