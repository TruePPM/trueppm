#!/usr/bin/env bash
# Every `name:tag@sha256:<digest>` image reference in the tree must resolve to ONE
# digest per `name:tag` (#4623).
#
# Renovate bumped packages/web/Dockerfile's node:22-alpine digest but not the
# `image:` pins in .gitlab-ci.yml, so CI tested on a different base layer than the
# one that ships. Nothing relates a CI pin to a Dockerfile FROM except this gate.
# The registry prefix is ignored (`${DOCKERHUB_PREFIX}/node` and `node` are the
# same image); `name:tag` is the last path component, so `nginxinc/nginx-unprivileged`
# and `nginx-unprivileged` compare equal.
#
# Modes:
#   bash scripts/check-image-digest-parity.sh             # check the tree
#   bash scripts/check-image-digest-parity.sh --self-test # prove the check can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Reads "<file>:<line>:<text>" records on stdin; prints drift and exits 1 if any.
find_drift() {
  python3 -c '
import re, sys, collections
pat = re.compile(r"(?:[A-Za-z0-9._${}-]+/)*([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})")
seen = collections.defaultdict(lambda: collections.defaultdict(list))
for rec in sys.stdin:
    path, lineno, text = rec.rstrip("\n").split(":", 2)
    for m in pat.finditer(text):
        seen[m.group(1)][m.group(2)].append(f"{path}:{lineno}")
bad = {k: v for k, v in seen.items() if len(v) > 1}
for img, digests in sorted(bad.items()):
    print(f"DRIFT {img} has {len(digests)} digests:")
    for d, locs in sorted(digests.items()):
        more = f" (+{len(locs) - 3} more)" if len(locs) > 3 else ""
        eg = ", ".join(locs[:3])
        print(f"  {d[:12]}  {len(locs)}x  e.g. {eg}{more}")
if not seen:
    print("ERROR: no image digest pins found; the file listing is empty or unreadable", file=sys.stderr)
    sys.exit(2)
if "node:22-alpine" not in seen:
    print("ERROR: known pin node:22-alpine not found; the file listing is incomplete", file=sys.stderr)
    sys.exit(2)
sys.exit(1 if bad else 0)
'
}

records() {
  # -I skips binaries; lockfiles/docs/OpenAPI are not image pins.
  # safe.directory='*': the alpine CI job sets none, and git would refuse the checkout.
  # git's exit code is NOT swallowed; grep exit 1 (no match) is tolerated because
  # find_drift fails on an empty pin set.
  local list
  list=$(mktemp) || return 1
  if ! git -c safe.directory='*' -C "$REPO_ROOT" ls-files -z -- . ':!:*.lock' ':!:*package-lock.json' ':!:*.md' ':!:*.mdx' ':!:docs/*' >"$list"; then
    rm -f "$list"; echo "ERROR: git ls-files failed in $REPO_ROOT" >&2; return 1
  fi
  (cd "$REPO_ROOT" && xargs -0 grep -nIE '@sha256:[0-9a-f]{64}' <"$list") || [ $? -eq 1 ]
  rm -f "$list"
}

if [ "${1:-}" = "--self-test" ]; then
  d1=$(printf 'a%.0s' $(seq 64)); d2=$(printf 'b%.0s' $(seq 64))
  if printf 'x.yml:1:  image: node:22-alpine@sha256:%s\nDockerfile:3:FROM ${P}/node:22-alpine@sha256:%s\n' "$d1" "$d2" | find_drift >/dev/null; then
    echo "self-test FAILED: mismatched digests were not detected" >&2; exit 1
  fi
  if ! printf 'x.yml:1:  image: node:22-alpine@sha256:%s\nDockerfile:3:FROM ${P}/node:22-alpine@sha256:%s\n' "$d1" "$d1" | find_drift >/dev/null; then
    echo "self-test FAILED: matching digests were flagged" >&2; exit 1
  fi
  if printf '' | find_drift >/dev/null 2>&1; then
    echo "self-test FAILED: empty input passed" >&2; exit 1
  fi
  echo "self-test ok"
  exit 0
fi

recs=$(records) || exit 1
rc=0
printf '%s\n' "$recs" | find_drift || rc=$?
if [ "$rc" -eq 2 ]; then exit 1; fi
if [ "$rc" -ne 0 ]; then
  echo "Image digest drift: align every pin of the same name:tag to one digest (#4623)." >&2
  exit 1
fi
echo "image digest parity ok"
