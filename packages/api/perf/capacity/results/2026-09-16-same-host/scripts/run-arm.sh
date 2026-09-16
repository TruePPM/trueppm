#!/usr/bin/env bash
# One capacity run: ./run-arm.sh <july|9dca> <label> <expected-docker-cpus> <expected-docker-mem-gib>
#   e.g. ./run-arm.sh july run1-18c-8g 18 8
# Refuses to start if Docker's allocation doesn't match what the label claims,
# or if the host isn't quiet (override with FORCE_LOAD=1).
set -euo pipefail
arm="$1"; label="$2"; want_cpus="$3"; want_mem="$4"
S="$(cd "$(dirname "$0")" && pwd)"
REPO=${TRUEPPM_REPO:?path to a trueppm checkout}
PY="$REPO/packages/api/.venv/bin/python"
C="$S/harness/docker-compose.capacity.yml"
OUT="$S/results/$label"
mkdir -p "$OUT"
exec > >(tee "$OUT/run.log") 2>&1

# --- preflight -------------------------------------------------------------
ncpu=$(docker info --format '{{.NCPU}}')
mem_gib=$(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f", $1/1073741824}')
echo "docker: NCPU=$ncpu MemTotal=${mem_gib}GiB (want $want_cpus / ~$want_mem)"
[ "$ncpu" = "$want_cpus" ] || { echo "ABORT: Docker CPUs $ncpu != $want_cpus"; exit 1; }
awk -v m="$mem_gib" -v w="$want_mem" 'BEGIN{exit !(m > w-1 && m <= w)}' \
  || { echo "ABORT: Docker memory ${mem_gib}GiB does not match ${want_mem}GB"; exit 1; }
load1=$(sysctl -n vm.loadavg | awk '{print $2}')
echo "host load(1m)=$load1"
if awk -v l="$load1" 'BEGIN{exit !(l >= 2)}' && [ "${FORCE_LOAD:-0}" != 1 ]; then
  echo "ABORT: host not quiet (load $load1 >= 2). FORCE_LOAD=1 to override."; exit 1
fi

# --- stack -----------------------------------------------------------------
docker tag "cap-$arm" trueppm-api:local
export CAPACITY_SRC="$S/src-$arm/packages/api/src"
export CAPACITY_INTEGRATION_KEY
CAPACITY_INTEGRATION_KEY=$("$PY" -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')
# The July seeder hard-codes this password; the 9dca seeder reads it from env.
export TRUEPPM_CAPACITY_PASSWORD="${TRUEPPM_CAPACITY_PASSWORD:?the July seeder hard-codes its password; see README}"

docker compose -f "$C" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f "$C" up -d --wait api celery
echo "pg jit=$(docker compose -f "$C" exec -T db psql -U trueppm -d trueppm -Atc "show jit")"

vm_meminfo() { docker run --rm --entrypoint cat postgres:16-alpine /proc/meminfo \
  | grep -E '^(MemTotal|MemFree|MemAvailable|Cached|SwapTotal|SwapFree):'; }

"$PY" - "$OUT/meta.json" "$arm" "$label" <<EOF
import json, subprocess, sys
sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
json.dump({
  "arm": sys.argv[2], "label": sys.argv[3],
  "code_sha": sh("git -C '$S/src-$arm' rev-parse HEAD"),
  "code_overlay": sh("git -C '$S/src-$arm' status --short"),
  "image_id": sh("docker image inspect trueppm-api:local --format '{{.Id}}'"),
  "harness_sha": "9dca6c525 (compose: DB password + seeder mount patched)",
  "chip": sh("sysctl -n machdep.cpu.brand_string"),
  "p_cores": sh("sysctl -n hw.perflevel0.physicalcpu"),
  "e_cores": sh("sysctl -n hw.perflevel1.physicalcpu"),
  "host_mem_bytes": sh("sysctl -n hw.memsize"),
  "docker_ncpu": "$ncpu", "docker_mem_gib": "$mem_gib",
  "docker_version": sh("docker version --format '{{.Server.Version}}'"),
  "host_load_at_start": "$load1", "pg_jit": "${CAPACITY_PG_JIT:-on}",
}, open(sys.argv[1], "w"), indent=2)
EOF
echo "--- VM meminfo before"; vm_meminfo | tee "$OUT/meminfo-before.txt"

# --- measure ---------------------------------------------------------------
# Run from the arm's worktree so the harness records that tree's git sha.
start=$(date +%s)
( cd "$S/src-$arm" && "$PY" "$S/harness/run_capacity.py" --dimension full_load --out "$OUT" )
echo "sweep wall time: $(( $(date +%s) - start ))s"

echo "--- VM meminfo after"; vm_meminfo | tee "$OUT/meminfo-after.txt"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | tee "$OUT/docker-stats.txt"
docker compose -f "$C" down -v --remove-orphans
