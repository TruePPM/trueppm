"""Request-path admission control for synchronous Monte Carlo runs (#2839).

Two request-path endpoints run ``trueppm_scheduler.monte_carlo()`` inline:
``run_monte_carlo`` (one simulation) and ``MonteCarloWhatIfView`` (two, back to
back). The engine caps ``runs`` (``MC_SIMULATION_CAP``) and ``n_tasks``
(``MC_TASK_CAP``) separately, but the simulation's working set is three live
``(runs, n_tasks)`` float64 matrices plus temporaries, so what it costs — in
memory *and*, since the hot path is vectorized and linear in it, in wall time — is
the **product** ``runs x n_tasks``. Capping each dimension leaves the product at
5,000 x 1,000 = 5M cells, measured at ~234 MB traced / ~336 MB RSS per call, on a
single default API worker that also serves every WebSocket. This module caps the
product (``MC_CELL_CAP``) and the number of simulations one process runs at once
(``MC_MAX_CONCURRENT``).

Both are memory-safety bounds, not edition gates: refusals here are 400 / 503,
never the 402 the per-dimension OSS caps return.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from django.conf import settings
from rest_framework import status
from rest_framework.response import Response

# How long a request waits for a free simulation slot before it is refused. Long
# enough to ride out one in-flight run at the cell cap (a few seconds), short of
# any ingress timeout, so a brief collision queues instead of failing.
MC_SLOT_WAIT_SECONDS = 10.0

# Retry-After on a 503 busy refusal — about one simulation's duration at the cap.
MC_BUSY_RETRY_AFTER_SECONDS = 5

_slot_lock = threading.Lock()
_slot_semaphore: threading.BoundedSemaphore | None = None
_slot_semaphore_size: int | None = None


@dataclass(frozen=True)
class McAdmission:
    """The outcome of :func:`admit_runs`.

    Exactly one of ``runs`` / ``refusal`` is meaningful: ``refusal`` is a ready
    400 response when the request cannot be admitted, else ``None`` and ``runs`` is
    the iteration count to simulate.
    """

    runs: int
    refusal: Response | None = None


def max_runs_for(n_tasks: int) -> int | None:
    """Largest iteration count admissible for a network of ``n_tasks`` leaf tasks.

    ``min(MC_SIMULATION_CAP, MC_CELL_CAP // n_tasks)``, where either cap may be
    ``None`` (unbounded). ``None`` means no bound at all. Can be ``0`` when the
    task count alone exceeds the cell cap.
    """
    sim_cap: int | None = settings.MC_SIMULATION_CAP
    cell_cap: int | None = getattr(settings, "MC_CELL_CAP", None)
    bounds: list[int] = []
    if sim_cap is not None:
        bounds.append(sim_cap)
    if cell_cap is not None and n_tasks > 0:
        bounds.append(cell_cap // n_tasks)
    return min(bounds) if bounds else None


def admit_runs(n_tasks: int, requested: int | None) -> McAdmission:
    """Resolve the iteration count for a request, applying the cell cap.

    * ``requested is None`` (the caller left ``n_simulations`` out — the web
      client's default): run the admissible maximum for this project's size. On a
      large project that is fewer than ``MC_SIMULATION_CAP``; the response's
      ``runs`` field reports the count actually simulated, so the down-scale is
      never hidden.
    * An explicit ``requested`` above the size-derived maximum is **refused**
      (400, ``simulation_cell_cap_exceeded``, carrying ``max_runs``) rather than
      silently shrunk: a caller that asked for N samples must not get a forecast
      computed from fewer while believing it got N.

    Two cases are deliberately passed through to the engine unchanged, so their
    existing 402 refusal (and its message) stays exactly what it was: a project
    over ``MC_TASK_CAP``, and a request above ``MC_SIMULATION_CAP``.
    """
    sim_cap: int | None = settings.MC_SIMULATION_CAP
    task_cap: int | None = settings.MC_TASK_CAP
    default_runs = sim_cap or 1_000

    if task_cap is not None and n_tasks > task_cap:
        return McAdmission(runs=requested if requested is not None else default_runs)
    if requested is not None and sim_cap is not None and requested > sim_cap:
        return McAdmission(runs=requested)

    max_runs = max_runs_for(n_tasks)
    if max_runs is None:
        return McAdmission(runs=requested if requested is not None else default_runs)

    runs = requested if requested is not None else max_runs
    if runs > max_runs or runs < 1:
        return McAdmission(
            runs=0,
            refusal=Response(
                {
                    "error": "simulation_cell_cap_exceeded",
                    "message": (
                        f"{runs} simulation runs over {n_tasks} tasks exceeds this "
                        f"server's Monte Carlo size limit (MC_CELL_CAP); at most "
                        f"{max_runs} runs are admissible for a project this size."
                    ),
                    "max_runs": max_runs,
                    "task_count": n_tasks,
                },
                status=status.HTTP_400_BAD_REQUEST,
            ),
        )
    return McAdmission(runs=runs)


def _semaphore() -> threading.BoundedSemaphore | None:
    """The process-wide simulation slot pool, (re)built if the setting changed.

    Rebuilt on a size change so a settings override takes effect; never rebuilt
    while the size is stable, so held slots are always released to the pool they
    came from.
    """
    global _slot_semaphore, _slot_semaphore_size
    size: int | None = getattr(settings, "MC_MAX_CONCURRENT", None)
    if size is None:
        return None
    with _slot_lock:
        if _slot_semaphore is None or _slot_semaphore_size != size:
            _slot_semaphore = threading.BoundedSemaphore(max(1, size))
            _slot_semaphore_size = size
        return _slot_semaphore


def busy_response() -> Response:
    """503 returned when no simulation slot frees up within the wait window."""
    return Response(
        {
            "error": "simulation_busy",
            "message": (
                "The server is already running its maximum number of concurrent "
                "Monte Carlo simulations. Retry in a few seconds."
            ),
        },
        status=status.HTTP_503_SERVICE_UNAVAILABLE,
        headers={"Retry-After": str(MC_BUSY_RETRY_AFTER_SECONDS)},
    )


@contextmanager
def simulation_slot() -> Iterator[bool]:
    """Hold one of this process's ``MC_MAX_CONCURRENT`` simulation slots.

    Yields ``True`` once a slot is held, or ``False`` if none freed up within
    :data:`MC_SLOT_WAIT_SECONDS` — the caller then returns :func:`busy_response`
    without simulating. A sync Django view under ASGI runs on its own thread per
    request, so concurrent simulations in one worker are real and a thread
    semaphore bounds them. The bound is per process: N API workers admit up to
    N x ``MC_MAX_CONCURRENT`` simulations, which is the right unit because each
    worker has its own memory limit to protect.

    The what-if view holds a single slot across both of its simulations — they
    run sequentially, so one slot is the honest cost.
    """
    sem = _semaphore()
    if sem is None:
        yield True
        return
    acquired = sem.acquire(timeout=MC_SLOT_WAIT_SECONDS)
    try:
        yield acquired
    finally:
        if acquired:
            sem.release()
