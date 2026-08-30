#!/usr/bin/env bash
# scripts/check-gate-selftest-parity.sh — every CI gate proves it can still fail,
# in its own job, or carries a recorded reason why it cannot.
#
# Why this exists (#3194). `boundary:imports` — the job CLAUDE.md names as the
# enforcement of the "sacred" OSS/Enterprise boundary — passed a real
# `from trueppm_enterprise.portfolio import RollupService`, exit 0, for the whole
# life of the gate (#3172). alpine's BusyBox grep rejects `--include`, the
# script's `|| true` swallowed the option error, and empty read as "no
# violations".
#
# The part worth encoding is not that bug. It is that **both blind gates already
# had test suites**: scripts/tests/check-enterprise-imports.test.sh and
# check-suppression-issues.test.sh, run by `scripts:test`. They passed the whole
# time. `scripts:test` runs on python:3.11-slim, which has GNU grep; the gates
# ran on alpine:3.20, which does not. The suites tested the scripts in an
# environment the gates never run in, so they were evidence about python:3.11-slim
# and nothing else.
#
# So the requirement is SAME JOB, not same repo — because same job is the only
# way to say "same image" in GitLab CI, and the image is what differed. A gate
# that cannot fail is indistinguishable from one that works, and until this
# script the count of gates in that state was written down nowhere.
#
# What this cannot do: an opt-out is a rubber stamp, exactly like
# `--update-baseline` on the docs gate, and a `--self-test` that asserts only the
# happy path passes this check while proving nothing. This removes the silence,
# not the possibility of a wrong answer.
#
# Usage:  scripts/check-gate-selftest-parity.sh [--self-test]
# Exit:   0 every CI gate self-tests in-job or is opted out · 1 at least one is neither

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_FILE="${CI_FILE_OVERRIDE:-.gitlab-ci.yml}"

# Gates that cannot assert detection from a fixture. One "basename<TAB>reason" per line.
#
# ONE kind qualifies: EXTERNAL — the gate's input is not the repo, so no fixture
# can represent a violation. There is no third state. A gate either proves it can
# fail in its own job, or its input is not the repo.
#
# The PENDING category is gone (#3195). It held twelve gates whose detection had
# been verified once, by hand, during the #3194 audit — a snapshot nothing
# repeated. All twelve now carry a --self-test that plants the violation named and
# asserts both directions, run in the gate's own job. Every one of them, neutered,
# still passed on the real tree; check-prepush-parity.sh printed output BYTE-
# IDENTICAL to the healthy gate, because a compliant tree never executes the
# detection path.
#
# Do not reintroduce PENDING. "Verified by hand once" is the standing this file
# exists to refuse, and writing it down does not upgrade it.
OPT_OUT="
check-issue-boundary.sh	EXTERNAL: input is the GitLab tracker's issue labels, not the repo — a fixture cannot represent a violation
check-release-images.sh	EXTERNAL: queries the container registry for published release images; covered by scripts/tests/check-release-images.test.sh
"

opt_out_reason() {
    printf '%s\n' "$OPT_OUT" | while IFS=$'\t' read -r name reason; do
        [ -n "$name" ] || continue
        if [ "$name" = "$1" ]; then printf '%s' "$reason"; return; fi
    done
}

# Emit "job<TAB>script-basename<TAB>yes|no" for every gate invoked in CI, where the
# third field says whether THAT SAME JOB also invokes it with --self-test.
#
# Matched per job block: a self-test in a different job is what #3172 already had.
gate_invocations() {
    awk '
      /^[A-Za-z_][A-Za-z0-9_:.-]*:[ \t]*$/ { job = $0; sub(/:[ \t]*$/, "", job); skip = 0; next }
      # A path under changes:/paths:/exists: names a file that TRIGGERS the job; it is
      # not an invocation of it. `workflow:`s changes list names every gate script in
      # the repo, and reading those as invocations attributes them to the global
      # `workflow:` key — a job that does not exist.
      /^[ \t]*-?[ \t]*(changes|paths|files|exists):[ \t]*$/ { skip = 1; next }
      /^[ \t]*-?[ \t]*[A-Za-z_][A-Za-z0-9_-]*:/   { skip = 0 }
      skip { next }
      # A path named in a comment is prose, not an invocation. `pages` carries a
      # comment mentioning check-version-status.sh and runs no such command; reading
      # it as an invocation demanded a self-test from a job that never runs the gate.
      /^[ \t]*#/ { next }
      {
        line = $0
        sub(/[ \t]#.*$/, "", line)
        while (match(line, /scripts\/[A-Za-z0-9_.\/-]+\.(sh|py)/)) {
          s    = substr(line, RSTART, RLENGTH)
          rest = substr(line, RSTART + RLENGTH)
          n = split(s, parts, "/"); base = parts[n]
          # Only gates. scripts/tests/*.test.sh are test files, not gates.
          if (base ~ /\.test\.sh$/)                      { line = rest; continue }
          if (base !~ /^check[-_]/ && base !~ /-check\.(sh|py)$/) { line = rest; continue }
          if (rest ~ /^[ \t]*--self-test/) selftest[job SUBSEP base] = 1
          else                             invoked[job SUBSEP base]  = 1
          line = rest
        }
      }
      END {
        for (k in invoked) {
          split(k, a, SUBSEP)
          print a[1] "\t" a[2] "\t" ((k in selftest) ? "yes" : "no")
        }
      }
    ' "$1" | sort
}

run_scan() {
    local ci="$1" proven=0 opted=0 missing=0 job script has reason
    while IFS=$'\t' read -r job script has; do
        [ -n "$script" ] || continue
        if [ "$has" = "yes" ]; then proven=$((proven + 1)); continue; fi
        reason="$(opt_out_reason "$script")"
        if [ -n "$reason" ]; then opted=$((opted + 1)); continue; fi
        missing=$((missing + 1))
        echo "check-gate-selftest-parity: FAIL  $job runs scripts/$script but never runs it with --self-test"
    done <<< "$(gate_invocations "$ci")"

    echo "check-gate-selftest-parity: $proven self-tested in-job, $opted opted out, $missing unproven."

    if [ "$missing" -gt 0 ]; then
        cat <<'MSG'

A gate that cannot be shown to fail is indistinguishable from one that works. That is
not hypothetical here: boundary:imports passed a real Apache-2.0 violation for its
entire existence (#3172), on green pipelines, while carrying a test suite that ran in a
different image. Fix by either:

  * adding a --self-test to the script and invoking it in the SAME job, before the real
    scan (the default — the job's own image is the only environment that counts); or
  * adding it to OPT_OUT in this script with the reason a fixture cannot represent a
    violation.

Run the self-test FIRST in the job: a gate's failure mode is a green pipeline, so "it
passed" is not evidence that it can still fail.
MSG
        return 1
    fi
    return 0
}

self_test() {
    local tmp rc=0; tmp="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT

    _case() { # <name> <expect-pass|expect-fail> <ci-fixture>
        if run_scan "$3" >/dev/null 2>&1; then
            if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
            else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; rc=1; fi
        else
            if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
            else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; rc=1; fi
        fi
    }

    printf 'lint:zz:\n  script:\n    - bash scripts/check-zz-probe.sh --self-test\n    - bash scripts/check-zz-probe.sh\n' > "$tmp/ok.yml"
    _case "gate self-tested in its own job" expect-pass "$tmp/ok.yml"

    printf 'lint:zz:\n  script:\n    - bash scripts/check-zz-probe.sh\n' > "$tmp/bare.yml"
    _case "gate with no self-test anywhere" expect-fail "$tmp/bare.yml"

    # THE #3172 SHAPE, and the reason this gate matches per job rather than per repo:
    # the proof exists, in another job, therefore in another image.
    printf 'other:job:\n  script:\n    - bash scripts/check-zz-probe.sh --self-test\nlint:zz:\n  script:\n    - bash scripts/check-zz-probe.sh\n' > "$tmp/elsewhere.yml"
    _case "self-test in a DIFFERENT job" expect-fail "$tmp/elsewhere.yml"

    printf 'lint:zz:\n  script:\n    - bash scripts/check-issue-boundary.sh\n' > "$tmp/opted.yml"
    _case "opted-out gate" expect-pass "$tmp/opted.yml"

    # A non-gate script in CI must not be demanded to self-test.
    printf 'lint:zz:\n  script:\n    - bash scripts/export-openapi.sh\n' > "$tmp/nongate.yml"
    _case "non-gate script ignored" expect-pass "$tmp/nongate.yml"

    # A .test.sh under scripts/tests/ is a test file, not a gate.
    printf 'scripts:test:\n  script:\n    - bash scripts/tests/check-release-images.test.sh\n' > "$tmp/testfile.yml"
    _case "scripts/tests/*.test.sh ignored" expect-pass "$tmp/testfile.yml"

    # Prose naming a gate is not a job running one.
    printf 'pages:\n  script:\n    # enforced by scripts/check-zz-probe.sh, see above\n    - echo deploy\n' > "$tmp/comment.yml"
    _case "gate named only in a comment" expect-pass "$tmp/comment.yml"

    printf 'workflow:\n  rules:\n    - changes:\n        - scripts/check-zz-probe.sh\n' > "$tmp/changes.yml"
    _case "gate named in a changes: list" expect-pass "$tmp/changes.yml"

    [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
    return "$rc"
}

cd "$REPO_ROOT"
if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi
run_scan "$CI_FILE"
