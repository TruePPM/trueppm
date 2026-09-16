#!/usr/bin/env bash
# Build one image per code arm. PSYCOPG_EXTRA=binary matches how the dev compose
# builds trueppm-api:local, which is what the July run measured.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
for arm in july 9dca; do
  echo "== building cap-$arm from $(git -C "$S/src-$arm" rev-parse --short HEAD)"
  docker build -f "$S/src-$arm/packages/api/Dockerfile" \
    --build-arg PSYCOPG_EXTRA=binary \
    -t "cap-$arm" "$S/src-$arm" > "$S/results/build-$arm.log" 2>&1 \
    || { echo "build failed — see results/build-$arm.log"; exit 1; }
  docker image inspect "cap-$arm" --format '   id={{.Id}}'
done
