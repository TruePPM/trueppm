#!/usr/bin/env bash
# diag-analyze.sh <arm> <sizes> — seed, force ANALYZE, 7 loads; logs statements > 3 s.
set -euo pipefail
arm=$1; sizes=$2
PY=${TRUEPPM_REPO:?path to a trueppm checkout}/packages/api/.venv/bin/python
C=harness/docker-compose.capacity.yml
docker tag cap-$arm trueppm-api:local
export CAPACITY_SRC=$PWD/src-$arm/packages/api/src
export CAPACITY_INTEGRATION_KEY=$($PY -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())")
export TRUEPPM_CAPACITY_PASSWORD="${TRUEPPM_CAPACITY_PASSWORD:?the July seeder hard-codes its password; see README}"
docker compose -f $C down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -f $C up -d --wait api celery >/dev/null 2>&1
docker compose -f $C exec -T db psql -U trueppm -d trueppm -c "ALTER SYSTEM SET log_min_duration_statement = 3000" -c "SELECT pg_reload_conf()" >/dev/null
FORCE_ANALYZE=1 $PY diag.py $PWD/harness $sizes
docker compose -f $C logs --no-color db 2>&1 | grep -A2 "duration:" > results/slowlog-$arm.txt || true
echo "slow statements logged: $(grep -c 'duration:' results/slowlog-$arm.txt || true)"
docker compose -f $C down -v --remove-orphans >/dev/null 2>&1
