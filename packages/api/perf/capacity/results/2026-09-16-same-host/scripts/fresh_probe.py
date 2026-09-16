"""One fresh-database reading.

Seed N tasks, ANALYZE, time the first/middle/last page (median of 3), and a full
load when N <= 32,000.
"""

import statistics
import subprocess
import sys
import time

import requests

sys.path.insert(0, "harness")
import run_capacity as rc

n = int(sys.argv[1])
PAGE = 200
pages = -(-n // PAGE)
t0 = time.perf_counter()
rc.seed(projects=1, tasks=n)
seed_s = time.perf_counter() - t0
subprocess.run(
    [
        "docker",
        "compose",
        "-f",
        "harness/docker-compose.capacity.yml",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "trueppm",
        "-d",
        "trueppm",
        "-c",
        "ANALYZE",
    ],
    capture_output=True,
)
c = rc.Client()
pid = c.first_project_id()


def get(p: int) -> float:
    s = time.perf_counter()
    r = requests.get(
        f"{rc.BASE_URL}/api/v1/tasks/?project={pid}&page_size={PAGE}&page={p}",
        headers=c.headers,
        timeout=900,
    )
    r.raise_for_status()
    return (time.perf_counter() - s) * 1000


res = {}
for label, p in (("first", 1), ("middle", max(1, pages // 2)), ("last", pages)):
    res[label] = round(statistics.median(get(p) for _ in range(3)))
est = pages * (res["first"] + res["last"]) / 2 / 1000
line = (
    f"FRESH n={n} seed={seed_s:.0f}s first={res['first']}ms middle={res['middle']}ms "
    f"last={res['last']}ms est_full={est:.1f}s"
)
if n <= 32000:
    s = time.perf_counter()
    for p in range(1, pages + 1):
        get(p)
    line += f" measured_full={time.perf_counter() - s:.1f}s"
print(line, flush=True)
