# ruff: noqa: E501, SIM115, B023 — formatted, otherwise kept as run: these produced the committed scale/ and multi/ output.
"""Multi-user, multi-project and program probe for the fixed build.

A. Concurrent users: 1/2/4/8 users open the same 8,000-task Schedule at once
   (page 1, then the rest four at a time — what useScheduleTasks does).
B. Neighbors: one 5,000-task project alone vs. the same project among 20 of them
   (100,000 tasks in the database): Schedule load, program rollup, project list.
C. Program CPM: the merged program recalc over 20 x 1,500 tasks, vs. one project.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HARNESS = sys.argv[1]
os.environ["CAPACITY_HARNESS"] = HARNESS
sys.path.insert(0, HARNESS)
import run_capacity as rc  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from diag_scale import DC, PSQL, Sampler, sh  # noqa: E402

PAGE = 200
OUT: dict[str, object] = {}


def timed_get(client: rc.Client, path: str) -> tuple[float, dict]:
    s = time.perf_counter()
    r = requests.get(f"{rc.BASE_URL}{path}", headers=client.headers, timeout=900)
    r.raise_for_status()
    return (time.perf_counter() - s) * 1000, r.json()


def schedule_open(client: rc.Client, pid: str) -> float:
    s = time.perf_counter()
    _, first = timed_get(client, f"/api/v1/tasks/?project={pid}&page_size={PAGE}&page=1")
    pages = -(-first["count"] // PAGE)
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(
            ex.map(
                lambda p: timed_get(
                    client, f"/api/v1/tasks/?project={pid}&page_size={PAGE}&page={p}"
                ),
                range(2, pages + 1),
            )
        )
    return time.perf_counter() - s


def seed_and_analyze(projects: int, tasks: int) -> str:
    rc.seed(projects=projects, tasks=tasks)
    grant = (
        "from django.contrib.auth import get_user_model;"
        "from trueppm_api.apps.access.models import ProgramMembership, Role;"
        "from trueppm_api.apps.projects.models import Program;"
        "u = get_user_model().objects.get(email='capacity@trueppm.local');"
        "p = Program.objects.get(code='CAPACITY');"
        "ProgramMembership.objects.get_or_create(program=p, user=u, defaults={'role': Role.OWNER})"
    )
    sh([*DC, "run", "--rm", "seeder", "python", "manage.py", "shell", "-c", grant])
    sh([*PSQL, "ANALYZE"])
    return sh([*PSQL, "select count(*) from projects_task where not is_deleted"])


def celery_apply(expr: str) -> dict:
    code = (
        "import time, resource, json;"
        "from trueppm_api.apps.projects.models import Project, Program;"
        "from trueppm_api.apps.scheduling.tasks import recalculate_schedule, recalculate_program_schedule;"
        "prog = str(Program.objects.get(code='CAPACITY').id);"
        "pid = str(Project.objects.filter(is_deleted=False).order_by('name').values_list('id', flat=True).first());"
        f"s = time.perf_counter(); r = {expr};"
        "print(json.dumps({'s': round(time.perf_counter()-s, 1), 'state': r.state,"
        " 'error': (str(r.result)[:240] if r.failed() else None),"
        " 'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024)}))"
    )
    out = sh([*DC, "run", "--rm", "seeder", "python", "manage.py", "shell", "-c", code])
    try:
        return json.loads(out.splitlines()[-1])
    except (ValueError, IndexError):
        return {"raw": out[-400:]}


def save() -> None:
    json.dump(OUT, open(os.environ.get("MULTI_OUT", "multi.json"), "w"), indent=2)


PHASES = os.environ.get("PHASES", "A,B,C").split(",")
if os.path.exists(os.environ.get("MULTI_OUT", "multi.json")):
    OUT.update(json.load(open(os.environ.get("MULTI_OUT", "multi.json"))))

if "A" in PHASES:
    key = os.environ.get("A_KEY", "A")
    print(f"== {key}. concurrent users, one 8,000-task project", flush=True)
    print(f"   tasks in db: {seed_and_analyze(1, 8000)}", flush=True)
    client = rc.Client()
    pid = client.first_project_id()
    schedule_open(client, pid)  # warm
    OUT[key] = []
    for users in (1, 2, 4, 8):
        barrier = threading.Barrier(users)
        times: list[float] = []

        def one_user() -> None:
            barrier.wait()
            times.append(schedule_open(client, pid))

        with Sampler() as smp:
            threads = [threading.Thread(target=one_user) for _ in range(users)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        row = {
            "users": users,
            "median_s": round(statistics.median(times), 1),
            "max_s": round(max(times), 1),
            "api_cpu_peak": smp.peak.get("api", {}).get("cpu"),
            "db_cpu_peak": smp.peak.get("db", {}).get("cpu"),
        }
        OUT[key].append(row)
        print(f"   {row}", flush=True)
        save()

if "B" in PHASES:
    OUT["B"] = []
    for projects in (1, 20):
        print(f"== B. {projects} project(s) x 5,000 tasks", flush=True)
        total = seed_and_analyze(projects, 5000)
        client = rc.Client()
        pid = client.first_project_id()
        prog_id = sh([*PSQL, "select id from projects_program where code='CAPACITY' limit 1"])
        schedule_open(client, pid)  # warm
        opens = [schedule_open(client, pid) for _ in range(3)]
        rollup = [timed_get(client, f"/api/v1/programs/{prog_id}/rollup/")[0] for _ in range(3)]
        plist = [timed_get(client, "/api/v1/projects/?page_size=50")[0] for _ in range(3)]
        row = {
            "projects": projects,
            "tasks_in_db": int(total),
            "schedule_open_s": round(statistics.median(opens), 2),
            "program_rollup_ms": round(statistics.median(rollup)),
            "project_list_ms": round(statistics.median(plist)),
        }
        OUT["B"].append(row)
        print(f"   {row}", flush=True)
        save()

if "C" in PHASES:
    print("== C. program CPM: 20 x 1,500 tasks (30,000 merged)", flush=True)
    seed_and_analyze(20, 1500)
    single = celery_apply("recalculate_schedule.apply(args=[pid])")
    print(f"   one member project recalc: {single}", flush=True)
    with Sampler() as smp:
        program = celery_apply("recalculate_program_schedule.apply(args=[prog])")
    print(
        f"   merged program recalc:     {program}  db_cpu_peak={smp.peak.get('db', {}).get('cpu')}",
        flush=True,
    )
    OUT["C"] = {"member_project": single, "program": program}
    save()
