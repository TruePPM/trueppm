"""Hold a Celery worker's start until its broker answers (#3722).

What was observed: on a fresh Helm install the worker and valkey start in
parallel. In every recorded ``helm:install`` failure the worker first logged
``consumer: Cannot connect to redis://… Connection refused``, then connected and
logged ``ready.``, and after that its event loop stopped. The heartbeat file
(``worker_heartbeat``) was last touched at ``worker_ready`` to the second, and
``inspect ping`` got no reply from inside or outside the pod.

What is NOT established is the mechanism. The refused attempts leave nothing
behind in the process. Celery's ``Consumer.connect`` registers the transport with
the hub only after ``ensure_connection`` succeeds. When kombu's redis
``Channel.__init__`` fails its ``ping()``, it disconnects its pools and raises
before adding itself to the poller. The upstream reconnect fixes (kombu #2492,
#2498, #2561, #2590) are unreleased as of kombu 5.6.2, and their signatures do not
match ours either: #2492 keeps heartbeats running, and #2498 and #2561 log
tracebacks where our logs show none.

So this is a mitigation on the one variable every failure shares, not a removal
of a known cause. ``worker_init`` fires in ``WorkController.setup_defaults``,
before any bootstep runs, so the consumer's first connection now happens only
after the broker has answered a ``PING``, instead of racing a valkey that is still
starting. ``scripts/helm-install-drill.sh`` measures whether that helped: it
reports startup refusals on every run and, on failure, dumps the worker's thread
stacks. If a failure recurs with this in place, read that stack.

It stands on its own merits regardless. A broker that never comes up exits the
process non-zero, and the container restarts. Without the wait, the process
retries in-process with only the startup probe to notice.

It does not cover a broker that goes away mid-life; the chart's ``inspect ping``
liveness probe remains the recovery there. Compose never had the race: its worker
waits on ``api-init``, which waits on a healthy valkey.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable

import redis
from celery.signals import worker_init

from trueppm_api.core import valkey

logger = logging.getLogger(__name__)

_WAIT_ENV = "TRUEPPM_CELERY_BROKER_WAIT_SECONDS"
# Under the chart's worker startup-probe budget (failureThreshold 30 x period 5s
# = 150s), so the process exits and restarts on its own terms before kubelet
# would conclude anything from a missing heartbeat file.
_DEFAULT_WAIT_SECONDS = 120.0
_RETRY_INTERVAL_SECONDS = 2.0
_PING_TIMEOUT_SECONDS = 5.0


def wait_budget_seconds() -> float:
    """Return the configured wait budget; ``0`` disables the wait entirely.

    Read on every call so a test can override it per-case. An unparseable or
    negative value falls back to the default rather than disabling the guard,
    since a typo should not silently reopen the wedge this module prevents.
    """
    raw = os.environ.get(_WAIT_ENV)
    if raw is None or raw.strip() == "":
        return _DEFAULT_WAIT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        logger.warning("worker_broker_wait: ignoring non-numeric %s=%r", _WAIT_ENV, raw)
        return _DEFAULT_WAIT_SECONDS
    if value < 0:
        logger.warning("worker_broker_wait: ignoring negative %s=%r", _WAIT_ENV, raw)
        return _DEFAULT_WAIT_SECONDS
    return value


def _ping_broker() -> None:
    """PING the Celery broker database, raising if it is not reachable.

    Goes through ``core.valkey.client`` so Sentinel (primary resolution) and the
    single-endpoint URL are handled exactly as every other consumer handles them.
    """
    valkey.client(
        valkey.DB_CELERY,
        socket_connect_timeout=_PING_TIMEOUT_SECONDS,
        socket_timeout=_PING_TIMEOUT_SECONDS,
    ).ping()


def wait_for_broker(
    budget_seconds: float,
    *,
    ping: Callable[[], None] = _ping_broker,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> int:
    """Block until ``ping`` succeeds, returning how many attempts failed first.

    Raises:
        SystemExit: with code 1 if the broker is still unreachable once
            ``budget_seconds`` has elapsed. ``SystemExit`` is deliberate: celery's
            ``Signal.send`` swallows ``Exception`` from receivers and logs it, which
            would let the worker start anyway and walk into the reconnect path.
    """
    deadline = monotonic() + budget_seconds
    failures = 0
    while True:
        try:
            ping()
        except (redis.RedisError, OSError) as exc:
            failures += 1
            if monotonic() >= deadline:
                logger.exception(
                    "worker_broker_wait: broker still unreachable after %.0fs (%d attempts) — "
                    "exiting so the container restarts cleanly (#3722)",
                    budget_seconds,
                    failures,
                )
                raise SystemExit(1) from exc
            logger.warning(
                "worker_broker_wait: broker not reachable yet (attempt %d): %s — retrying in %.0fs",
                failures,
                exc,
                _RETRY_INTERVAL_SECONDS,
            )
            sleep(_RETRY_INTERVAL_SECONDS)
            continue
        if failures:
            logger.warning(
                "worker_broker_wait: broker reachable after %d failed attempt(s); starting worker",
                failures,
            )
        return failures


def _on_worker_init(**_kwargs: object) -> None:
    """Hold worker start until the broker answers (see module docstring)."""
    budget = wait_budget_seconds()
    if budget == 0:
        return
    wait_for_broker(budget)


# Plain call rather than the decorator form, for the same mypy --strict reason
# given in worker_heartbeat.
worker_init.connect(_on_worker_init)
