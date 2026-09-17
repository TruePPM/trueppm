# ruff: noqa: E501, SIM115 — formatted, otherwise kept as run: these produced the committed scale/ and multi/ output.
"""Scale probe: where does the fixed build run out, and on what (CPU, memory, time)?

Usage: python diag_scale.py <harness-dir> <size>[,<size>...] [full_load_max]
"""

from __future__ import annotations

import json
import os
import statistics
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
        raise SystemExit(f"diag_scale.py: not a harness directory: {path!r}")
    return path


HARNESS = _validated_harness(os.environ.get("CAPACITY_HARNESS") or sys.argv[1])
sys.path.insert(0, HARNESS)
import run_capacity as rc  # noqa: E402

COMPOSE = os.path.join(HARNESS, "docker-compose.capacity.yml")
DC = ["docker", "compose", "-f", COMPOSE]
PSQL = [*DC, "exec", "-T", "db", "psql", "-U", "trueppm", "-d", "trueppm", "-At", "-c"]
PAGE = 200


def sh(cmd: list[str], timeout: int = 3600) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()


def mem_mib(s: str) -> float:
    v = s.split("/")[0].strip()
    for unit, f in (("GiB", 1024), ("MiB", 1), ("KiB", 1 / 1024)):
        if v.endswith(unit):
            return float(v[: -len(unit)]) * f
    return 0.0


class Sampler:
    """Peak CPU% and memory for api, db, celery while a block runs."""

    def __init__(self) -> None:
        self.peak: dict[str, dict[str, float]] = {}
        self.stop = threading.Event()
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self) -> None:
        while not self.stop.is_set():
            out = sh(
                [
                    "docker",
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}",
                ]
            )
            for line in out.splitlines():
                name, cpu, mem = line.split("|")
                if not name.startswith("trueppm-capacity-"):
                    continue
                key = name.removeprefix("trueppm-capacity-").removesuffix("-1")
                p = self.peak.setdefault(key, {"cpu": 0.0, "mem_mib": 0.0})
                p["cpu"] = max(p["cpu"], float(cpu.rstrip("%") or 0))
                p["mem_mib"] = max(p["mem_mib"], mem_mib(mem))

    def __enter__(self) -> Sampler:
        self.t.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.t.join()


def get_page(client: rc.Client, pid: str, page: int) -> tuple[float, int, int]:
    s = time.perf_counter()
    r = requests.get(
        f"{rc.BASE_URL}/api/v1/tasks/?project={pid}&page_size={PAGE}&page={page}",
        headers=client.headers,
        timeout=900,
    )
    return (time.perf_counter() - s) * 1000, r.status_code, len(r.content)


if __name__ == "__main__":
    SIZES = [int(x) for x in sys.argv[2].split(",")]
    FULL_LOAD_MAX = int(sys.argv[3]) if len(sys.argv) > 3 else 16000
    results = []
    for n in SIZES:
        row: dict[str, object] = {"tasks": n}
        t0 = time.perf_counter()
        rc.seed(projects=1, tasks=n)
        row["seed_s"] = round(time.perf_counter() - t0, 1)
        sh([*PSQL, "ANALYZE"])
        row["db_task_table_mb"] = round(
            int(sh([*PSQL, "select pg_total_relation_size('projects_task')"])) / 2**20, 1
        )
        row["db_total_mb"] = round(
            int(sh([*PSQL, "select pg_database_size('trueppm')"])) / 2**20, 1
        )
        client = rc.Client()  # fresh token per size: a long sweep must not outlive the JWT
        pid = client.first_project_id()
        pages = -(-n // PAGE)
        print(
            f"== {n} tasks: seeded in {row['seed_s']}s, {pages} pages, task table {row['db_task_table_mb']} MB",
            flush=True,
        )

        with Sampler() as smp:
            for label, page in (("first", 1), ("middle", max(1, pages // 2)), ("last", pages)):
                samples = [get_page(client, pid, page) for _ in range(3)]
                ms = statistics.median(s[0] for s in samples)
                row[f"page_{label}_ms"] = round(ms)
                row[f"page_{label}_status"] = sorted({s[1] for s in samples})
                row["page_bytes"] = samples[0][2]
                print(
                    f"   page {label} (#{page}): {ms:.0f} ms  status={row[f'page_{label}_status']}  {samples[0][2] / 1024:.0f} KiB",
                    flush=True,
                )
            # Offset cost is ~linear in page index, so the whole fetch is ~pages x mean(first, last).
            row["full_load_est_s"] = round(
                pages * (row["page_first_ms"] + row["page_last_ms"]) / 2 / 1000, 1
            )
            row["payload_total_mb_est"] = round(pages * row["page_bytes"] / 2**20, 1)
            if n <= FULL_LOAD_MAX:
                s = time.perf_counter()
                for p in range(1, pages + 1):
                    get_page(client, pid, p)
                row["full_load_measured_s"] = round(time.perf_counter() - s, 1)
            print(
                f"   whole-project load: est {row['full_load_est_s']} s"
                + (
                    f", measured {row['full_load_measured_s']} s"
                    if "full_load_measured_s" in row
                    else ""
                )
                + f"; total payload ~{row['payload_total_mb_est']} MB",
                flush=True,
            )
        row["read_peaks"] = smp.peak

        code = (
            "import time, resource, json;"
            "from trueppm_api.apps.projects.models import Project;"
            "from trueppm_api.apps.scheduling.tasks import recalculate_schedule;"
            "pid = str(Project.objects.filter(is_deleted=False).values_list('id', flat=True).first());"
            "s = time.perf_counter(); r = recalculate_schedule.apply(args=[pid]);"
            "print(json.dumps({'cpm_s': round(time.perf_counter()-s, 1), 'state': r.state,"
            " 'error': (str(r.result)[:300] if r.failed() else None),"
            " 'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024)}))"
        )
        with Sampler() as smp:
            out = sh([*DC, "run", "--rm", "seeder", "python", "manage.py", "shell", "-c", code])
        try:
            row.update(json.loads(out.splitlines()[-1]))
        except (ValueError, IndexError):
            row["cpm_raw"] = out[-600:]
        row["cpm_peaks"] = smp.peak
        print(
            f"   CPM recalc: {row.get('cpm_s')} s  state={row.get('state')}  peak RSS {row.get('peak_rss_mib')} MiB"
            f"  error={row.get('error') or row.get('cpm_raw', '')[:200]}",
            flush=True,
        )
        print(f"   peaks (read): {row['read_peaks']}", flush=True)
        print(f"   peaks (cpm):  {row['cpm_peaks']}", flush=True)
        results.append(row)
        json.dump(results, open(os.environ.get("SCALE_OUT", "scale.json"), "w"), indent=2)
