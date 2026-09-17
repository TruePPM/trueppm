"""Time each whole-project load individually and sample what the stack is doing.

Usage: ``python diag.py <harness-dir> <size>[,<size>...]``

Seeds each size exactly as ``run_capacity.py`` does, then times 7 whole-project loads
one by one. A background poller samples ``pg_stat_activity`` and container CPU during
each load and prints them for any load over 10 s. ``FORCE_ANALYZE=1`` runs ``ANALYZE``
after seeding, which is the steady state a long-running database is in.

Tidied for lint before commit; behavior is unchanged from the copy that produced the
``diagnostics/`` output.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import requests


def _validated_harness(path: str) -> str:
    """Reject a harness path that isn't a real directory or could be read as a CLI flag.

    ``HARNESS`` is spliced unquoted into ``docker compose -f <HARNESS>/...`` and
    ``psql`` argument lists below; a value starting with ``-`` would be read as an
    option by those binaries rather than a path (argument injection).
    """
    if path.startswith("-") or not os.path.isdir(path):
        raise SystemExit(f"diag.py: not a harness directory: {path!r}")
    return path


HARNESS = _validated_harness(sys.argv[1])
SIZES = [int(x) for x in sys.argv[2].split(",")]
sys.path.insert(0, HARNESS)
import run_capacity as rc  # noqa: E402

COMPOSE = os.path.join(HARNESS, "docker-compose.capacity.yml")
PSQL = [
    *("docker", "compose", "-f", COMPOSE, "exec", "-T", "db"),
    *("psql", "-U", "trueppm", "-d", "trueppm", "-At", "-c"),
]
STATS_SQL = (
    "select relname, n_live_tup, n_dead_tup, "
    "coalesce(to_char(last_autoanalyze,'HH24:MI:SS'),'-'), "
    "coalesce(to_char(last_autovacuum,'HH24:MI:SS'),'-'), to_char(now(),'HH24:MI:SS') "
    "from pg_stat_user_tables "
    "where relname in ('projects_task','projects_dependency') order by relname"
)
ACTIVITY_SQL = (
    "select state, round(extract(epoch from now()-query_start)::numeric,1), "
    "left(regexp_replace(query,'\\s+',' ','g'),160) from pg_stat_activity "
    "where datname='trueppm' and state<>'idle' and pid<>pg_backend_pid()"
)
CONTAINERS = ["trueppm-capacity-api-1", "trueppm-capacity-celery-1", "trueppm-capacity-db-1"]


def sh(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def table_stats() -> str:
    return sh([*PSQL, STATS_SQL]).replace("\n", " || ")


def poll(stop: threading.Event, base: float, events: list[tuple[float, str, str]]) -> None:
    while not stop.is_set():
        activity = sh([*PSQL, ACTIVITY_SQL])
        cpu = sh(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}}", *CONTAINERS]
        )
        events.append((round(time.perf_counter() - base, 1), activity, cpu))
        time.sleep(2)


def whole_project_load(client: rc.Client, pid: str) -> tuple[float, int, int, object]:
    start = time.perf_counter()
    pages = rows = 0
    page = 1
    while True:
        r = requests.get(
            f"{rc.BASE_URL}/api/v1/tasks/?project={pid}&page_size=200&page={page}",
            headers=client.headers,
            timeout=180,
        )
        pages += 1
        body = r.json()
        rows += len(body.get("results", []))
        if not body.get("next"):
            return (time.perf_counter() - start) * 1000, pages, rows, body.get("count")
        page += 1


for size in SIZES:
    t0 = time.perf_counter()
    rc.seed(projects=1, tasks=size)
    if os.environ.get("FORCE_ANALYZE") == "1":
        sh([*PSQL, "ANALYZE"])
        print("  ran ANALYZE", flush=True)
    print(f"  stats after seed: {table_stats()}", flush=True)
    print(f"== seeded {size} in {time.perf_counter() - t0:.1f}s", flush=True)
    client = rc.Client()
    pid = client.first_project_id()

    for i in range(7):
        events: list[tuple[float, str, str]] = []
        stop = threading.Event()
        poller = threading.Thread(
            target=poll, args=(stop, time.perf_counter(), events), daemon=True
        )
        poller.start()
        ms, pages, rows, count = whole_project_load(client, pid)
        stop.set()
        poller.join()
        if i == 6:
            print(f"  stats after loads: {table_stats()}", flush=True)
        print(f"load {i + 1}: {ms:.0f} ms  pages={pages} rows={rows} count={count}", flush=True)
        if ms > 10000:
            for ts, activity, cpu in events:
                print(f"   t+{ts}s  cpu[{cpu.replace(chr(10), ' | ')}]")
                for line in activity.splitlines():
                    print(f"      pg: {line}")
