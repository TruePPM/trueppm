"""Self-exit a wedged Celery worker so Docker Compose can restart it (#3936).

Why this exists: the Helm chart recovers a wedged worker (heartbeat present but
stale — see ``worker_heartbeat``) with a ``celery inspect ping``
``livenessProbe`` (``packages/helm/templates/celery-worker/deployment.yaml``):
a failed liveness probe makes kubelet kill and restart the pod. Plain Docker
Compose has **no equivalent mechanism** — a container's ``HEALTHCHECK``
(here, the same heartbeat-freshness check the chart's *readiness* probe uses)
only changes what ``docker compose ps`` reports; nothing in Compose reads that
status and restarts anything. ``restart: unless-stopped`` fires on a process
*exit*, never on a healthcheck transitioning to ``unhealthy``. Verified
generically against a permanently-failing healthcheck + ``restart:
unless-stopped``: the container sits reporting ``unhealthy`` with
``RestartCount=0`` forever (#3936).

So a worker that wedges after connecting — #3722's failure mode, there fixed
only for the Helm chart's cold-start race — has no path back on Compose once
it is running: cold start is covered (``worker_broker_wait`` holds the process
until the broker answers before the consumer ever starts), but a broker that
goes away and comes back *after* the worker is already up is not, and nothing
about that recovery differs between a cold-start wedge and a mid-life one once
the symptom (heartbeat frozen) is the same.

Rather than add a sidecar that watches container health and issues
``docker restart`` — which needs the Docker socket mounted into a container in
the hardened production stack (``docker-compose.prod.yml`` runs
``read_only: true`` / ``no-new-privileges``), a privilege-escalation path that
would need its own security review — this gives ``restart: unless-stopped``
something it already knows how to act on: a process exit. A daemon thread,
started once the worker's own heartbeat file first exists (mirroring the
chart's startup-probe gate — see ``worker_heartbeat.heartbeat_file``), polls
that same file's mtime and calls ``os._exit`` once it is older than
``stale_seconds()``. It deliberately reuses the *heartbeat file* and the
*staleness-by-mtime* mechanism the readiness healthcheck already uses rather
than inventing a second way to decide a worker is unwell — the two now differ
only in what they do with a stale reading: the healthcheck reports it, this
acts on it.

Opt-in, default off (``self_heal_enabled()``): a chart-deployed worker already
has a liveness probe for this condition, independently tuned against
Kubernetes' own grace-period accounting (``probes.worker.liveness`` in
``values.yaml``) — turning this on unconditionally would give that worker two
differently-tuned kill paths for the same symptom. ``docker-compose.yml`` and
``docker-compose.prod.yml`` are the only places that set the env var.

The staleness threshold is 3x the readiness healthcheck's own 30s window
(``_DEFAULT_STALE_SECONDS``), not the same value: a false *readiness* failure
just drops the container out of rotation for a Docker-network-level check
nothing else currently reads, so it costs nothing to be quick about. A false
*self-exit* kills the only process in the container and forces a cold restart
— it must tolerate everything a transient blip (broker reconnect, a GC pause,
CPU throttling under ``docker-compose.prod.yml``'s ``cpus: 2.0`` limit) would
produce, with real margin, before concluding the worker is genuinely wedged
rather than briefly busy.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

from celery.signals import worker_ready, worker_shutting_down

from trueppm_api.core.worker_heartbeat import heartbeat_file

logger = logging.getLogger(__name__)

_ENABLE_ENV = "TRUEPPM_CELERY_WORKER_SELF_HEAL"
_STALE_SECONDS_ENV = "TRUEPPM_CELERY_WORKER_SELF_HEAL_STALE_SECONDS"

# 3x the compose readiness healthcheck's own staleness window (30s, see
# docker-compose.yml / docker-compose.prod.yml) — see module docstring for why
# a self-exit needs more margin than a readiness flap.
_DEFAULT_STALE_SECONDS = 90.0

# How often the watchdog re-checks the heartbeat file's mtime. Cheap (a single
# stat), so this can safely be more frequent than the threshold it is
# measuring against without adding meaningful overhead.
_CHECK_INTERVAL_SECONDS = 10.0

# Sysexits.h EX_TEMPFAIL: "a temporary failure ... in which the user is
# invited to retry" — distinguishes a deliberate self-heal exit from an
# ordinary crash (exit 1) in `docker inspect --format '{{.State.ExitCode}}'`
# and container logs.
_EXIT_CODE = 75

_shutting_down = threading.Event()


def self_heal_enabled() -> bool:
    """Return whether the self-exit watchdog should run (see module docstring).

    Read on every call, not cached, so tests can toggle it per-case.
    """
    return os.environ.get(_ENABLE_ENV, "").strip().lower() in ("1", "true", "yes")


def stale_seconds() -> float:
    """Return the configured staleness threshold in seconds.

    Falls back to the default on a missing, non-numeric, or non-positive
    value — the same fallback policy as ``worker_broker_wait.wait_budget_seconds``,
    so a typo cannot silently arm a hair-trigger self-exit.
    """
    raw = os.environ.get(_STALE_SECONDS_ENV)
    if raw is None or raw.strip() == "":
        return _DEFAULT_STALE_SECONDS
    try:
        value = float(raw)
    except ValueError:
        logger.warning("worker_selfheal: ignoring non-numeric %s=%r", _STALE_SECONDS_ENV, raw)
        return _DEFAULT_STALE_SECONDS
    if value <= 0:
        logger.warning("worker_selfheal: ignoring non-positive %s=%r", _STALE_SECONDS_ENV, raw)
        return _DEFAULT_STALE_SECONDS
    return value


def _watchdog_loop(
    path: Path,
    *,
    threshold: float,
    check_interval: float = _CHECK_INTERVAL_SECONDS,
    wait: Callable[[float], bool] = _shutting_down.wait,
    now: Callable[[], float] = time.time,
    exit_: Callable[[int], None] = lambda code: os._exit(code),
) -> None:
    """Poll ``path``'s mtime; self-exit once it is older than ``threshold``.

    ``wait`` is ``threading.Event.wait`` by default: it blocks for up to
    ``check_interval`` seconds and returns ``True`` immediately if the event
    is set in the meantime (see ``_on_worker_shutting_down``), so a graceful
    shutdown stops this loop within one tick instead of racing it.

    ``os._exit`` (not ``sys.exit``/``SystemExit``) is deliberate: this runs on
    a daemon thread, not the MainProcess's own event loop — the wedge this
    module recovers from is exactly that loop no longer running — so raising
    here would only unwind this thread, leaving the process (and the
    container) up. ``os._exit`` terminates the interpreter immediately with no
    atexit/cleanup, which is exactly what ``restart: unless-stopped`` needs: a
    process exit to act on.
    """
    while not wait(check_interval):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            # File briefly absent (e.g. mid-touch, or not yet created) is not
            # staleness — skip this tick rather than treating it as an infinite age.
            continue
        age = now() - mtime
        if age > threshold:
            logger.critical(
                "worker_selfheal: heartbeat stale for %.0fs (threshold %.0fs) — "
                "self-exiting so `restart: unless-stopped` can recover the container (#3936)",
                age,
                threshold,
            )
            exit_(_EXIT_CODE)
            return


def _start_watchdog(threshold: float) -> None:
    thread = threading.Thread(
        target=_watchdog_loop,
        args=(heartbeat_file(),),
        kwargs={"threshold": threshold},
        name="trueppm-worker-selfheal",
        daemon=True,
    )
    thread.start()


def _on_worker_ready(**_kwargs: object) -> None:
    """Start the watchdog once the worker is genuinely ready.

    Gated on the same event ``worker_heartbeat`` uses to write the file's
    first entry, so the watchdog's clock cannot start before there is
    anything to read — a slow cold boot is not mistaken for staleness.
    """
    if not self_heal_enabled():
        return
    _shutting_down.clear()
    _start_watchdog(stale_seconds())


def _on_worker_shutting_down(**_kwargs: object) -> None:
    """Stop the watchdog on a graceful shutdown request.

    Without this, a worker that is winding down on its own could have its
    heartbeat go stale mid-shutdown and have the watchdog treat an
    intentional stop as a wedge. Best-effort like ``worker_heartbeat``'s own
    handler — a hard kill skips this signal entirely, which is fine because
    there is no process left for the watchdog to exit.
    """
    _shutting_down.set()


# Plain calls rather than the decorator form, for the same mypy --strict
# reason given in worker_heartbeat.
worker_ready.connect(_on_worker_ready)
worker_shutting_down.connect(_on_worker_shutting_down)
