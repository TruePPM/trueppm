#!/usr/bin/env bash
# The hosted demo's read-only posture, enforced at the manifest level (#2773).
#
# `try.trueppm.com` is read-only by construction: `load_sample_project` runs
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
# A second, unrelated posture is checked here too (#3932): the compose demo
# stack must set TRUEPPM_DEMO_READ_ONLY=true, which DemoReadOnlyMiddleware reads
# to refuse every unsafe method under /api/. The two Helm manifests get an
# equivalent assertion in CI's helm:template job, which can render the chart and
# inspect the actual env list; docker-compose.demo.yml has no analogous
# render-time check, so it needs its own presence check here.
#
# Exit codes:
#   0  posture intact
#   1  a demo manifest carries --with-personas, or is missing TRUEPPM_DEMO_READ_ONLY
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
  "packages/helm/templates/demo-reset-cronjob.yaml"
)

# The install hook and the scheduled reset must run the SAME seed. They are two
# copies of one command in two files, and the persona/superuser guard above is only
# as good as its coverage of both, so a copy that quietly diverged (say, gained a
# flag in a rewrite of one file) would be the exact "changed the thing, missed the
# shadow copy" failure. Each helm template must carry this as an exact list item.
SEED_COMMAND="python manage.py load_sample_project && python manage.py create_demo_share_link"
SEED_COMMAND_FILES=(
  "packages/helm/templates/demo-seed-job.yaml"
  "packages/helm/templates/demo-reset-cronjob.yaml"
)

# The compose demo stack's copy of the write fence (#3932). Only docker-compose.demo.yml
# is checked here — the two Helm manifests are asserted by rendering the chart in CI's
# helm:template job, which can see the actual env list rather than grepping source text.
READONLY_ENV_FILE="docker-compose.demo.yml"
READONLY_ENV_PATTERN='^[[:space:]]*TRUEPPM_DEMO_READ_ONLY:[[:space:]]*"true"[[:space:]]*$'

# Two patterns, one posture. `--with-personas` creates login-capable persona
# accounts; `create_admin` creates a superuser (#3187). Either one alone makes
# the demo's baked, public SECRET_KEY a forgeable token for a real account, so
# the guard has to cover both — it previously covered only the first, while
# docker-compose.demo.yml ran create_admin and three of its own comments claimed
# it did not.
# `--with-personas` is matched as an ERE that ALSO accepts every prefix argparse
# would resolve to it: Django's CommandParser leaves allow_abbrev on, so `--with-pers`
# or `--with` (when unambiguous) enables persona logins exactly as the full flag
# does, and a literal-string ban would wave it through. The boundary after the last
# letter stops `--wait` and `--workers` from matching.
BANNED_PATTERNS=(
  '--w(i(t(h(-(p(e(r(s(o(n(a(s)?)?)?)?)?)?)?)?)?)?)?)?([^a-zA-Z-]|$)'
  'create_admin'
)
BANNED_LABELS=(
  "--with-personas (or an argparse abbreviation of it)"
  "create_admin"
)

# Strip comments, then look for the patterns. A YAML comment starts at an
# unquoted `#`; for these files (no `#` inside any command string) trimming from
# the first `#` is sufficient and keeps the check readable. Comments that NAME a
# pattern to explain why it is absent are load-bearing documentation and must
# keep passing — the check matches command position only.
scan_file() {
  local file="$1" pattern hits rc=0 i
  local stripped
  # A YAML comment starts at a `#` that begins the line or follows whitespace. A `#`
  # inside a token (`sh -c "x '#' --with-personas"`) is NOT a comment, so stripping
  # from any `#` would let a flag hide behind one.
  stripped="$(sed -E 's/(^|[[:space:]])#.*//' "$file")"
  for i in "${!BANNED_PATTERNS[@]}"; do
    pattern="${BANNED_PATTERNS[$i]}"
    hits="$(printf '%s\n' "$stripped" | grep -nE -- "$pattern" || true)"
    if [ -n "$hits" ]; then
      echo "VIOLATION: $file carries ${BANNED_LABELS[$i]} outside a comment:"
      echo "$hits" | sed 's/^/    /'
      rc=1
    fi
  done
  return "$rc"
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

  local drift=0 seed_file
  for seed_file in "${SEED_COMMAND_FILES[@]}"; do
    # The command must be an exact YAML list item on its own line: a commented-out
    # copy, or the command with something appended, is drift, not parity.
    if ! grep -qxF -- "$SEED_COMMAND" <<<"$(sed -E 's/^[[:space:]]*-[[:space:]]+//' "$root/$seed_file")"; then
      echo "DRIFT: $seed_file no longer carries the shared seed command:" >&2
      echo "    $SEED_COMMAND" >&2
      drift=$((drift + 1))
    fi
  done

  if [ "$violations" -gt 0 ]; then
    cat >&2 <<'MSG'

ERROR: the hosted demo's read-only posture has been inverted.

`--with-personas` creates six login-capable accounts with a shared password.
`create_admin` creates a superuser. On the public demo either one turns a
zero-account, no-auth-write-path instance into one where an account can log in
and reach the write surface — including the ungoverned `legacy:full` token path
(#2749).

It is worse than it looks on this stack specifically: docker-compose.demo.yml
bakes a PUBLIC SECRET_KEY, and JWT_SIGNING_KEY derives from it, so any
login-capable account is one whose tokens anyone can forge from a value printed
in this repository. The only thing between that and the internet is the `/api/`
allowlist in nginx/demo.conf.template — one config line, no defense behind it.

If you need personas for a walkthrough, run a private instance. If either is
genuinely required on the public demo, the baked keys must go first, and that is
a security decision that needs an ADR, not a manifest edit.

See: packages/api/tests/apps/projects/test_demo_readonly_posture.py (#2773, #3187)
MSG
    return 1
  fi

  if [ "$drift" -gt 0 ]; then
    cat >&2 <<'MSG'

ERROR: the demo's install hook and its scheduled reset no longer run the same seed.

Both helm templates must carry the seed command verbatim (SEED_COMMAND in this
script). If you changed the seed on purpose, change it in BOTH files and here in
the same commit; the reset is a second copy of the hook, and a reset that seeds
differently from the install turns the demo into something nobody deployed.
MSG
    return 1
  fi

  local readonly_missing=0
  if [ ! -f "$root/$READONLY_ENV_FILE" ]; then
    echo "ERROR: guarded demo manifest not found: $READONLY_ENV_FILE" >&2
    echo "       If it moved, update READONLY_ENV_FILE in $0 — do not delete the guard." >&2
    return 2
  fi
  if ! grep -qE -- "$READONLY_ENV_PATTERN" "$root/$READONLY_ENV_FILE"; then
    readonly_missing=1
  fi

  if [ "$readonly_missing" -gt 0 ]; then
    cat >&2 <<MSG

MISSING: $READONLY_ENV_FILE does not set TRUEPPM_DEMO_READ_ONLY: "true".

DemoReadOnlyMiddleware refuses every unsafe method under /api/ except sign-in,
token refresh, and sign-out when TRUEPPM_DEMO_READ_ONLY is on — it merged as
#3924 but nothing set the variable in any deployment artifact (#3932). The two
Helm manifests (demo-seed-job.yaml, demo-reset-cronjob.yaml) render it
unconditionally now; the compose demo stack must carry it as a literal line in
its x-api-env anchor:

    TRUEPPM_DEMO_READ_ONLY: "true"

MSG
    return 1
  fi

  echo "OK: no demo manifest enables persona logins or bootstraps a superuser (${#GUARDED_FILES[@]} file(s) x ${#BANNED_PATTERNS[@]} pattern(s)); the install hook and the reset run the same seed; the compose stack sets TRUEPPM_DEMO_READ_ONLY."
  return 0
}

# Prove the grep can actually fail — a guard that has never been seen to fire is
# indistinguishable from a guard with a typo in its pattern.
self_test() {
  local tmp compose job reset
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  mkdir -p "$tmp/packages/helm/templates"
  compose="$tmp/docker-compose.demo.yml"
  job="$tmp/packages/helm/templates/demo-seed-job.yaml"
  reset="$tmp/packages/helm/templates/demo-reset-cronjob.yaml"

  # A helm fixture that is compliant: the seed command as an exact list item, and a
  # comment that NAMES the flag to explain its absence.
  ok_helm() { printf '# load_sample_project runs WITHOUT --with-personas\ncommand:\n  - %s\n' "$SEED_COMMAND" > "$1"; }

  # The compose fixture body always carries a compliant TRUEPPM_DEMO_READ_ONLY line
  # appended, so every case below isolates the ONE failure mode it names — without
  # this every persona/create_admin case would also fail the readonly-env check.
  READONLY_LINE='  TRUEPPM_DEMO_READ_ONLY: "true"'
  # $1 may contain \n escapes, as every case below already wrote inline — `%b`
  # expands them in the DATA argument (unlike `%s`, which would print them
  # literally), so the compliant readonly line can be appended as a real
  # second line without interpolating $1 into the format string itself.
  write_compose() {
    local body
    body="$(printf '%b' "$1")"
    printf '%s\n%s\n' "$body" "$READONLY_LINE" > "$compose"
  }

  # expect <exit code> <what the case proves> [text the output must contain]. The
  # text check is what stops two different failures (a banned flag vs seed drift)
  # from being indistinguishable: both exit 1, so the exit code alone would let a
  # drift case pass for the wrong reason.
  expect() {
    local want="$1" msg="$2" needle="${3:-}" status=0 out
    out="$(run_check "$tmp" 2>&1)" || status=$?
    if [ "$status" -ne "$want" ]; then
      echo "SELF-TEST FAIL: $msg (exit $status, expected $want)" >&2
      return 1
    fi
    if [ -n "$needle" ] && ! grep -q -- "$needle" <<<"$out"; then
      echo "SELF-TEST FAIL: $msg (exit $status as expected, but the output did not say '$needle')" >&2
      return 1
    fi
  }

  # Case 1: the real posture — flag named only in a comment. Must pass.
  write_compose 'command: >\n  sh -c "python manage.py load_sample_project"\n# NOTE: runs WITHOUT --with-personas'
  ok_helm "$job"; ok_helm "$reset"
  expect 0 "a comment mentioning the persona flag was treated as a violation" || return 1

  # Case 1b: options that merely START with --w are not the banned flag.
  write_compose 'command: >\n  sh -c "python manage.py migrate --wait --workers 2"'
  expect 0 "--wait / --workers were treated as the persona flag" || return 1

  # Case 2: the drift — flag in command position. Must fail.
  write_compose 'command: >\n  sh -c "python manage.py load_sample_project --with-personas"'
  expect 1 "--with-personas in command position was not caught" VIOLATION || return 1

  # Case 2a: an argparse abbreviation enables the same behavior. Must fail.
  write_compose 'command: >\n  sh -c "python manage.py load_sample_project --with-pers"'
  expect 1 "an abbreviated --with-pers was not caught" VIOLATION || return 1

  # Case 2a2: a `#` inside a token is not a comment and must not hide the flag.
  write_compose 'command: >\n  sh -c "echo x#y --with-personas"'
  expect 1 "a flag after a mid-token # was hidden by comment stripping" VIOLATION || return 1

  # Case 2b: the #3187 drift — create_admin in command position. Must fail.
  write_compose 'command: >\n  sh -c "python manage.py migrate && python manage.py create_admin"'
  expect 1 "create_admin in command position was not caught" VIOLATION || return 1

  # Case 2c: create_admin named only in a comment must still pass — the demo
  # manifests explain at length why they do NOT run it, and that prose has to
  # survive the guard.
  write_compose 'command: >\n  sh -c "python manage.py migrate"\n# deliberately no create_admin here'
  printf '# and no create_admin here either\ncommand:\n  - %s\n' "$SEED_COMMAND" > "$job"
  printf '# and no create_admin here either\ncommand:\n  - %s\n' "$SEED_COMMAND" > "$reset"
  expect 0 "a comment mentioning create_admin was treated as a violation" || return 1

  # Case 2d: the scheduled reset is guarded like the install hook. The flag is in its
  # OWN list item so the seed line stays intact and only the ban can fire.
  printf 'command:\n  - %s\n  - --with-personas\n' "$SEED_COMMAND" > "$reset"
  expect 1 "--with-personas in the reset template was not caught" VIOLATION || return 1
  printf 'command:\n  - %s\n  - --with-pers\n' "$SEED_COMMAND" > "$reset"
  expect 1 "an abbreviated flag in the reset template was not caught" VIOLATION || return 1
  ok_helm "$reset"

  # Case 2e: the two seed copies must not diverge. Each variant leaves the banned
  # patterns alone, so only the parity check can fire.
  printf 'command:\n  - python manage.py load_sample_project\n' > "$reset"
  expect 1 "a reset template that dropped the shared seed command was not caught" DRIFT || return 1
  printf '# - %s\ncommand:\n  - python manage.py load_sample_project\n' "$SEED_COMMAND" > "$reset"
  expect 1 "a commented-out seed command satisfied the parity check" DRIFT || return 1
  printf 'command:\n  - %s && echo done\n' "$SEED_COMMAND" > "$reset"
  expect 1 "a seed command with something appended satisfied the parity check" DRIFT || return 1
  ok_helm "$reset"

  # Case 3: a guarded file that has moved must error, not silently pass.
  rm "$compose"
  expect 2 "a missing compose manifest did not error" || return 1
  write_compose 'command: >\n  sh -c "python manage.py load_sample_project"'

  # Case 3b: the same for the new template — deleting it must error, not pass.
  rm "$reset"
  expect 2 "a missing reset template did not error" || return 1
  ok_helm "$reset"

  # Case 4: the compose stack's own copy of the write fence (#3932). A
  # persona-clean compose file that never wires TRUEPPM_DEMO_READ_ONLY must
  # still fail — this is a second, independent posture, not covered by the
  # persona/create_admin scan above.
  printf 'command: >\n  sh -c "python manage.py load_sample_project"\n' > "$compose"
  expect 1 "a compose file missing TRUEPPM_DEMO_READ_ONLY was not caught" MISSING || return 1

  # Case 4b: present but not the accepted literal must still fail —
  # parse_demo_read_only is strict about the exact word, and this check mirrors
  # that rather than accepting any truthy-looking value.
  printf 'command: >\n  sh -c "python manage.py load_sample_project"\nTRUEPPM_DEMO_READ_ONLY: "false"\n' > "$compose"
  expect 1 "a compose file with TRUEPPM_DEMO_READ_ONLY: \"false\" was not caught" MISSING || return 1

  # Case 4c: restore compliance — the guard must not stay stuck failing.
  write_compose 'command: >\n  sh -c "python manage.py load_sample_project"'
  expect 0 "a fully compliant compose file was flagged" || return 1

  echo "SELF-TEST OK: comments ignored, both command-position patterns (incl. abbreviations) caught in all three files, seed drift caught three ways, missing file errors, TRUEPPM_DEMO_READ_ONLY presence enforced in the compose stack."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT"
fi
