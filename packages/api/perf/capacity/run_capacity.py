"""Capacity harness for the published scale envelope (issue #2391).

Distinct from ``perf/load.js``, which is a *relative-regression* tripwire run in
CI against a shared runner. This one answers a different question — "what has
this been tested to hold?" — so it runs off-CI against a dedicated stack
(``perf/capacity/docker-compose.capacity.yml``) and steps load up until a
sustained breach rather than driving a fixed profile.

Deliberately written against ``requests`` + ``websockets``, both already in the
API's environment, so the harness adds no host tooling (k6) and no project
dependency, and anyone with the venv can reproduce a published number.

Usage::

    export TRUEPPM_CAPACITY_PASSWORD=...   # required; see owner_password()
    python packages/api/perf/capacity/run_capacity.py --dimension tasks
    python packages/api/perf/capacity/run_capacity.py --dimension concurrency
    python packages/api/perf/capacity/run_capacity.py --dimension all --out results/

Every measurement reports the *breach point* — the first step at which the
gate below is exceeded on a sustained basis — never a single-sample peak.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import requests

BASE_URL = "http://127.0.0.1:28000"
OWNER_EMAIL = "capacity@trueppm.local"

# Supplied from the environment, never committed. `seed_capacity` reads the same
# variable to create the account, so the two sides agree without a shared
# constant in the tree — which is what this replaces (#2457).
OWNER_PASSWORD_ENV = "TRUEPPM_CAPACITY_PASSWORD"

COMPOSE_FILE = Path(__file__).parent / "docker-compose.capacity.yml"

# Breach gates. These are the thresholds the published envelope is measured to;
# they are stated in the results file so a reader can re-derive any number.
#
# p95 2000 ms is the "still usable" line for a schedule open — past it the Gantt
# feels broken rather than slow. The error gate is deliberately near-zero: a
# capacity ceiling that returns 500s is a different (worse) failure than one that
# merely gets slow, and the envelope must not conflate them.
P95_GATE_MS = 2000.0
ERROR_RATE_GATE = 0.01

# Host-noise control.
#
# This harness runs on a developer machine that is not otherwise idle. A step
# measured while the host is saturated reports the host's contention, not the
# API's capacity — during development of this harness the same 2,000-task read
# measured 253 ms on a quiet host and 4,147 ms at load average 14, a 16x swing
# with identical data. Publishing either number without qualification would be
# meaningless.
#
# So every step also measures `/api/v1/health/`, which does a constant, trivial
# amount of work: its latency is a proxy for what the host is doing to us. If the
# control is above this gate the step is retried, and if it stays high the step is
# marked `contaminated` and excluded from the published envelope.
CONTROL_P95_GATE_MS = 150.0
MAX_STEP_ATTEMPTS = 3


@dataclass
class Sample:
    """One HTTP call."""

    ms: float
    status: int
    ok: bool


@dataclass
class StepResult:
    """Aggregate for one step of a dimension sweep."""

    step: int | str
    label: str
    n: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    max_ms: float
    error_rate: float
    breached: bool
    # Host-noise control — see `control_sample()`. `control_p95_ms` is the same
    # measurement taken against a constant-work endpoint at the same moment, and
    # `load_avg` is the 1-minute host load. A step whose control is elevated was
    # measured on a busy machine and its number describes the host, not the API.
    control_p95_ms: float = 0.0
    load_avg: float = 0.0
    contaminated: bool = False
    attempts: int = 1
    notes: str = ""


@dataclass
class DimensionResult:
    dimension: str
    description: str
    steps: list[StepResult] = field(default_factory=list)
    ceiling: str | int | None = None
    constraint: str = ""


def p95_of(samples: list[Sample]) -> float:
    times = sorted(s.ms for s in samples)
    if not times:
        return 0.0
    return round(times[min(len(times) - 1, int(len(times) * 0.95))], 1)


def measure_step(
    client: Client,
    *,
    step: int | str,
    label: str,
    take: Callable[[], list[Sample]],
    notes: str = "",
) -> StepResult:
    """Run one step, re-running it while the host-noise control says it is dirty.

    Returns the cleanest attempt. A step that never comes back clean is still
    returned, flagged `contaminated`, so the reader sees that it was attempted
    and why its number was not published — silently dropping it would misreport
    the sweep as having covered ground it did not.
    """
    best: StepResult | None = None
    for attempt in range(1, MAX_STEP_ATTEMPTS + 1):
        control_before = p95_of(control_sample(client))
        samples = take()
        control_after = p95_of(control_sample(client))
        control = max(control_before, control_after)
        load = os.getloadavg()[0]

        result = summarize(step, label, samples, notes)
        result.control_p95_ms = control
        result.load_avg = round(load, 2)
        result.attempts = attempt
        result.contaminated = control > CONTROL_P95_GATE_MS

        if best is None or control < best.control_p95_ms:
            best = result
        if not result.contaminated:
            return result
        print(
            f"    [noisy host: control p95={control}ms, load={load:.1f}] retrying…",
            flush=True,
        )
        time.sleep(15)
    assert best is not None
    return best


def control_sample(client: Client, n: int = 12) -> list[Sample]:
    """Latency of a constant-work endpoint — the host-contention proxy."""
    return [client.timed("/api/v1/health/") for _ in range(n)]


def summarize(step: int | str, label: str, samples: list[Sample], notes: str = "") -> StepResult:
    times = sorted(s.ms for s in samples)
    errors = sum(1 for s in samples if not s.ok)
    rate = errors / len(samples) if samples else 1.0

    def pct(p: float) -> float:
        if not times:
            return 0.0
        idx = min(len(times) - 1, int(len(times) * p))
        return round(times[idx], 1)

    p95 = pct(0.95)
    return StepResult(
        step=step,
        label=label,
        n=len(samples),
        p50_ms=round(statistics.median(times), 1) if times else 0.0,
        p95_ms=p95,
        p99_ms=pct(0.99),
        max_ms=round(max(times), 1) if times else 0.0,
        error_rate=round(rate, 4),
        breached=p95 > P95_GATE_MS or rate > ERROR_RATE_GATE,
        notes=notes,
    )


# The token endpoint carries a deliberately tight anti-credential-stuffing
# throttle. A sweep re-authenticating at every step trips it and measures the
# throttle instead of the API, so the token is minted once and shared.
_TOKEN_CACHE: dict[str, str] = {}


def owner_password() -> str:
    """The load driver's password, or a hard stop explaining how to mint one.

    Also called once from `main()` rather than only lazily at first login: the
    failure has to land before the sweep brings a stack up and seeds it, not
    several minutes in.
    """
    password = os.environ.get(OWNER_PASSWORD_ENV, "").strip()
    if not password:
        raise SystemExit(
            f"{OWNER_PASSWORD_ENV} is not set — the capacity owner's password is "
            "supplied from the environment, never committed. Mint a throwaway one:\n"
            f"  export {OWNER_PASSWORD_ENV}=$(python3 -c "
            "'import secrets; print(secrets.token_urlsafe(16))')\n"
            "See packages/api/perf/capacity/README.md."
        )
    return password


class Client:
    """Thin authenticated API client."""

    def __init__(self, base_url: str = BASE_URL) -> None:
        self.base_url = base_url
        self.token = self._login()

    def _login(self) -> str:
        if cached := _TOKEN_CACHE.get(self.base_url):
            return cached
        # Back off through the auth throttle rather than failing the sweep.
        last: requests.Response | None = None
        for attempt in range(6):
            r = requests.post(
                f"{self.base_url}/api/v1/auth/token/",
                json={"username": OWNER_EMAIL, "password": owner_password()},
                timeout=30,
            )
            if r.status_code == 200:
                token = str(r.json()["access"])
                _TOKEN_CACHE[self.base_url] = token
                return token
            last = r
            if r.status_code != 429:
                break
            time.sleep(2**attempt)
        if last is not None:
            last.raise_for_status()
        raise RuntimeError("Could not authenticate against the capacity stack.")

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def timed(self, path: str, session: requests.Session | None = None) -> Sample:
        sess = session or requests
        start = time.perf_counter()
        try:
            r = sess.get(f"{self.base_url}{path}", headers=self.headers, timeout=120)
            ms = (time.perf_counter() - start) * 1000
            return Sample(ms=ms, status=r.status_code, ok=r.status_code < 400)
        except requests.RequestException:
            ms = (time.perf_counter() - start) * 1000
            return Sample(ms=ms, status=0, ok=False)

    def first_project_id(self) -> str:
        r = requests.get(
            f"{self.base_url}/api/v1/projects/?page_size=1", headers=self.headers, timeout=60
        )
        r.raise_for_status()
        results = r.json()["results"]
        if not results:
            raise RuntimeError("No projects — seed the capacity program first.")
        return str(results[0]["id"])


def seed(*, projects: int, tasks: int, edge_ratio: float = 1.0) -> None:
    """Re-seed the capacity stack at a given size (blocks until complete)."""
    cmd = [
        "docker",
        "compose",
        "-f",
        str(COMPOSE_FILE),
        "run",
        "--rm",
        "seeder",
        "python",
        "manage.py",
        "seed_capacity",
        "--projects",
        str(projects),
        "--tasks",
        str(tasks),
        "--edge-ratio",
        str(edge_ratio),
        "--reset",
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def repeat(fn: Callable[[], Sample], n: int) -> list[Sample]:
    return [fn() for _ in range(n)]


def concurrent(
    fn: Callable[[requests.Session], Sample], *, workers: int, per_worker: int
) -> list[Sample]:
    """Drive `workers` threads, each issuing `per_worker` sequential calls.

    Each worker owns its own Session: sharing one across threads would measure
    contention in the client's connection pool rather than capacity in the server.
    """

    def run_one(_: int) -> list[Sample]:
        with requests.Session() as session:
            return [fn(session) for _ in range(per_worker)]

    with ThreadPoolExecutor(max_workers=workers) as pool:
        batches = list(pool.map(run_one, range(workers)))
    return [s for batch in batches for s in batch]


# ──────────────────────────────────────────────────────────────────────────
# Dimensions
# ──────────────────────────────────────────────────────────────────────────


def dimension_tasks(steps: Iterable[int]) -> DimensionResult:
    """Tasks per project — the number everyone asks about."""
    result = DimensionResult(
        dimension="tasks_per_project",
        description=(
            "Single project re-seeded at each size. Measures the schedule-open read "
            "path (paginated task list), which is what the Gantt fetches on open."
        ),
        constraint=(
            "#2277 — the Schedule loads the whole project into memory via fetchAllPagesParallel"
        ),
    )
    for size in steps:
        print(f"  seeding {size} tasks…", flush=True)
        seed(projects=1, tasks=size)
        client = Client()
        pid = client.first_project_id()
        path = f"/api/v1/tasks/?project={pid}&page_size=100"
        repeat(lambda c=client, u=path: c.timed(u), 5)  # warm caches/connection
        step = measure_step(
            client,
            step=size,
            label=f"{size} tasks — first page",
            take=lambda c=client, u=path: repeat(lambda: c.timed(u), 30),
        )
        report(step)
        result.steps.append(step)
        if step.breached and not step.contaminated:
            result.ceiling = size
            break
    return result


def report(step: StepResult) -> None:
    flag = " CONTAMINATED" if step.contaminated else ""
    print(
        f"    p95={step.p95_ms}ms err={step.error_rate} "
        f"control={step.control_p95_ms}ms load={step.load_avg} "
        f"breached={step.breached}{flag}",
        flush=True,
    )


def dimension_full_load(steps: Iterable[int]) -> DimensionResult:
    """The whole-project read the Schedule actually performs (#2277)."""
    result = DimensionResult(
        dimension="full_project_load",
        description=(
            "Every page of the task list for one project, fetched serially — the "
            "total the Schedule view pays before it can draw a single bar."
        ),
        constraint="#2277 — no windowing; the client holds the entire task set",
    )
    for size in steps:
        print(f"  seeding {size} tasks…", flush=True)
        seed(projects=1, tasks=size)
        client = Client()
        pid = client.first_project_id()

        def full_load(pid: str = pid, client: Client = client) -> Sample:
            start = time.perf_counter()
            page = 1
            ok = True
            while True:
                r = requests.get(
                    f"{BASE_URL}/api/v1/tasks/?project={pid}&page_size=200&page={page}",
                    headers=client.headers,
                    timeout=180,
                )
                if r.status_code >= 400:
                    ok = False
                    break
                if not r.json().get("next"):
                    break
                page += 1
            return Sample(ms=(time.perf_counter() - start) * 1000, status=200, ok=ok)

        step = measure_step(
            client,
            step=size,
            label=f"{size} tasks — full load",
            # Bind the loop's closure by default-arg, matching the idiom used by the
            # other steps in this file — `full_load` is rebound each iteration (S1515).
            take=lambda f=full_load: repeat(f, 7),
        )
        report(step)
        result.steps.append(step)
        if step.breached and not step.contaminated:
            result.ceiling = size
            break
    return result


def dimension_concurrency(task_size: int, steps: Iterable[int]) -> DimensionResult:
    """Concurrent authenticated readers against a fixed project size."""
    result = DimensionResult(
        dimension="concurrent_users",
        description=(
            f"Fixed {task_size}-task project; concurrent authenticated clients each "
            "reading the task list in a loop."
        ),
        constraint=(
            "The shipped image runs a SINGLE uvicorn process (Dockerfile CMD, no "
            "--workers), and settings.prod sets ATOMIC_REQUESTS with no pooler (#2275)"
        ),
    )
    print(f"  seeding {task_size} tasks…", flush=True)
    seed(projects=1, tasks=task_size)
    client = Client()
    pid = client.first_project_id()
    path = f"/api/v1/tasks/?project={pid}&page_size=100"

    # Warm before the first step. Without this the very first sample is a cold
    # read taken moments after a re-seed, and because each step takes relatively
    # few samples, p95 is close to the worst sample — so the cold call alone set
    # the "ceiling" at 1 concurrent user, which is nonsense.
    repeat(lambda: client.timed(path), 10)

    for workers in steps:
        step = measure_step(
            client,
            step=workers,
            label=f"{workers} concurrent readers",
            take=lambda w=workers: concurrent(
                lambda session: client.timed(path, session), workers=w, per_worker=25
            ),
        )
        report(step)
        result.steps.append(step)
        if step.breached and not step.contaminated:
            result.ceiling = workers
            break
    return result


def dimension_edges(task_size: int, ratios: Iterable[float]) -> DimensionResult:
    """Dependency-edge density — CPM cost is edge-driven, not task-driven."""
    result = DimensionResult(
        dimension="dependency_edges",
        description=(
            f"Fixed {task_size}-task project re-seeded at rising edge:task ratios. "
            "Measures the dependency list read at each density."
        ),
        constraint="CPM is O(V+E); edge count drives recompute more than task count",
    )
    for ratio in ratios:
        edges = int(task_size * ratio)
        print(f"  seeding {task_size} tasks / ~{edges} edges…", flush=True)
        seed(projects=1, tasks=task_size, edge_ratio=ratio)
        client = Client()
        pid = client.first_project_id()
        path = f"/api/v1/dependencies/?project={pid}&page_size=200"
        repeat(lambda c=client, u=path: c.timed(u), 5)
        step = measure_step(
            client,
            step=f"{ratio}x",
            label=f"~{edges} edges ({ratio}x)",
            take=lambda c=client, u=path: repeat(lambda: c.timed(u), 25),
        )
        report(step)
        result.steps.append(step)
        if step.breached and not step.contaminated:
            result.ceiling = f"{ratio}x ({edges} edges)"
            break
    return result


def dimension_workspace(steps: Iterable[tuple[int, int]]) -> DimensionResult:
    """Projects per workspace, and total tasks across them."""
    result = DimensionResult(
        dimension="workspace_totals",
        description="Many projects in one program; measures the project-list read.",
        constraint="#1482 — the project list is the known N+1 path",
    )
    for projects, tasks in steps:
        total = projects * tasks
        print(f"  seeding {projects} projects x {tasks} tasks = {total}…", flush=True)
        seed(projects=projects, tasks=tasks)
        client = Client()
        path = "/api/v1/projects/?page_size=100"
        repeat(lambda c=client, u=path: c.timed(u), 5)
        step = measure_step(
            client,
            step=f"{projects}x{tasks}",
            label=f"{projects} projects / {total} tasks",
            take=lambda c=client, u=path: repeat(lambda: c.timed(u), 25),
        )
        report(step)
        result.steps.append(step)
        if step.breached and not step.contaminated:
            result.ceiling = f"{projects} projects / {total} tasks"
            break
    return result


DIMENSIONS: dict[str, Callable[[], DimensionResult]] = {
    "tasks": lambda: dimension_tasks([500, 1000, 2000, 4000, 8000, 16000]),
    "full_load": lambda: dimension_full_load([100, 250, 500, 1000, 2000, 4000]),
    "concurrency": lambda: dimension_concurrency(4000, [1, 2, 5, 10, 20, 40, 80]),
    "edges": lambda: dimension_edges(4000, [1.0, 1.5, 2.0, 3.0]),
    "workspace": lambda: dimension_workspace([(5, 500), (10, 1000), (25, 1000), (50, 1000)]),
}


def _git_sha() -> str:
    """The commit the measured image was built from — a number without one is unrepeatable."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dimension",
        default="all",
        choices=[*DIMENSIONS.keys(), "all"],
        help="Which dimension to sweep.",
    )
    parser.add_argument("--out", type=Path, help="Directory to write the JSON result into.")
    args = parser.parse_args()

    # Before any stack work: a missing credential should cost a second, not the
    # several minutes it takes to seed the first step and then fail to log in.
    owner_password()

    names = list(DIMENSIONS) if args.dimension == "all" else [args.dimension]
    results: list[dict[str, Any]] = []
    for name in names:
        print(f"\n=== {name} ===", flush=True)
        result = DIMENSIONS[name]()
        results.append(asdict(result))

    payload = {
        "gates": {
            "p95_ms": P95_GATE_MS,
            "error_rate": ERROR_RATE_GATE,
            "control_p95_ms": CONTROL_P95_GATE_MS,
        },
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "load_avg_at_finish": [round(v, 2) for v in os.getloadavg()],
            "note": (
                "Shared developer workstation, not an idle host. Every step carries "
                "its own control measurement and load average; steps flagged "
                "`contaminated` were measured while the host was busy and must not "
                "be published as capacity numbers."
            ),
        },
        "git_sha": _git_sha(),
        "base_url": BASE_URL,
        "dimensions": results,
    }
    text = json.dumps(payload, indent=2)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        target = args.out / f"capacity-{args.dimension}.json"
        target.write_text(text)
        print(f"\nwrote {target}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
