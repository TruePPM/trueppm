#!/usr/bin/env bash
# The hosted demo's read-only posture, enforced at the manifest level (#2773).
#
# `try.trueppm.com` is read-only by construction: `seed_demo_project` runs
# WITHOUT `--with-personas`, so no login-capable account exists, so no token can
# be minted, so the ungoverned write path is not reachable. That posture is
# defended by the *absence* of one flag in two YAML files, and adding it is the
# kind of one-line change that happens at launch, under time pressure, for a
# sales walkthrough — exactly when #2271 is being worked.
#
# The pytest half of this guard lives in
# `packages/api/tests/apps/projects/test_demo_readonly_posture.py` and asserts
# the runtime properties (zero login-capable accounts, no registration route,
# GET-only public surface). It cannot see these two files, because nothing
# imports them. Hence a grep. It is crude, and it is exactly the drift being
# guarded.
#
# Comment lines are ignored on purpose: both manifests carry a comment that
# *names* the flag to explain why it is absent, and those comments are load-
# bearing documentation. The check matches the flag in command position only —
# the same "syntax, not prose" distinction the enterprise-boundary gate makes.
#
# Exit codes:
#   0  posture intact
#   1  a demo manifest carries --with-personas
#   2  invocation / setup error (a guarded file is missing)
#
# Modes:
#   bash scripts/check-demo-readonly.sh             # check the manifests
#   bash scripts/check-demo-readonly.sh --self-test # prove the check can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The two files that deploy the public demo. A third deployment path would need
# adding here — that is the known limit of a grep-level guard.
GUARDED_FILES=(
  "docker-compose.demo.yml"
  "packages/helm/templates/demo-seed-job.yaml"
)

FLAG="--with-personas"

# Strip comments, then look for the flag. A YAML comment starts at an unquoted
# `#`; for these two files (no `#` inside any command string) trimming from the
# first `#` is sufficient and keeps the check readable.
scan_file() {
  local file="$1" hits
  hits="$(sed 's/#.*//' "$file" | grep -n -- "$FLAG" || true)"
  if [ -n "$hits" ]; then
    echo "VIOLATION: $file carries $FLAG outside a comment:"
    echo "$hits" | sed 's/^/    /'
    return 1
  fi
  return 0
}

run_check() {
  local root="$1" violations=0 file

  for file in "${GUARDED_FILES[@]}"; do
    if [ ! -f "$root/$file" ]; then
      echo "ERROR: guarded demo manifest not found: $file" >&2
      echo "       If it moved, update GUARDED_FILES in $0 — do not delete the guard." >&2
      return 2
    fi
    scan_file "$root/$file" || violations=$((violations + 1))
  done

  if [ "$violations" -gt 0 ]; then
    cat >&2 <<'MSG'

ERROR: the hosted demo's read-only posture has been inverted.

`--with-personas` creates six login-capable accounts with a shared password.
On the public demo that turns a zero-account, no-auth-write-path instance into
one where a visitor can log in and reach the write surface — including the
ungoverned `legacy:full` token path (#2749).

If you need personas for a walkthrough, run a private instance. If this flag is
genuinely required on the public demo, that is a security decision that needs an
ADR, not a manifest edit.

See: packages/api/tests/apps/projects/test_demo_readonly_posture.py (#2773)
MSG
    return 1
  fi

  echo "OK: no demo manifest enables persona logins (${#GUARDED_FILES[@]} file(s) checked)."
  return 0
}

# Prove the grep can actually fail — a guard that has never been seen to fire is
# indistinguishable from a guard with a typo in its pattern.
self_test() {
  local tmp status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  mkdir -p "$tmp/packages/helm/templates"

  # Case 1: the real posture — flag named only in a comment. Must pass.
  printf 'command: >\n  sh -c "python manage.py seed_demo_project"\n# NOTE: runs WITHOUT --with-personas\n' \
    > "$tmp/docker-compose.demo.yml"
  printf '# seed_demo_project runs WITHOUT --with-personas\ncommand:\n  - python manage.py seed_demo_project\n' \
    > "$tmp/packages/helm/templates/demo-seed-job.yaml"
  status=0
  run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a comment mentioning $FLAG was treated as a violation" >&2
    return 1
  fi

  # Case 2: the drift — flag in command position. Must fail.
  printf 'command: >\n  sh -c "python manage.py seed_demo_project --with-personas"\n' \
    > "$tmp/docker-compose.demo.yml"
  status=0
  run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: $FLAG in command position was not caught (exit $status)" >&2
    return 1
  fi

  # Case 3: a guarded file that has moved must error, not silently pass.
  rm "$tmp/docker-compose.demo.yml"
  status=0
  run_check "$tmp" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 2 ]; then
    echo "SELF-TEST FAIL: a missing manifest exited $status, expected 2" >&2
    return 1
  fi

  echo "SELF-TEST OK: comment ignored, command-position flag caught, missing file errors."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT"
fi
