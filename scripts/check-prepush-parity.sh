#!/usr/bin/env bash
# scripts/check-prepush-parity.sh — every CI check script has a pre-push mirror
# or a recorded reason why it cannot have one.
#
# Why this exists (#2941): `pre-push-checks` mirrored eight bespoke CI gates, and
# `lint:design-system-v2` — a job of exactly that shape — was not among them. So the one
# gate policing hardcoded hex against the DS-v2 token ratchet was the one a developer
# could not run before pushing. A breach passed `make pre-push` cleanly and failed the
# MR pipeline, which is the round trip `pre-push` exists to prevent.
#
# The gate was not missed through carelessness. Two targets one character apart —
# `lint-web` (ran it) and `web-lint` (did not) — meant the invocation *existed* and sat
# in the target `pre-push` never called. Nobody reading either target could see the hole.
#
# The real defect is that the list was a **historical accretion**: each gate added by
# hand as it was written, with nothing asserting the list stayed complete. Fixing the
# one missing entry would leave that intact, and the next gate would fall behind the
# same way. So this script derives the CI set from `.gitlab-ci.yml` rather than
# restating it, and fails when a script appears there with neither a Makefile mirror nor
# an entry below.
#
# Usage:  scripts/check-prepush-parity.sh [--self-test]
#
# Both inputs are injectable, so `--self-test` can run the REAL scan against fixture
# files rather than keeping a second copy of the parsing to drift (#3195). Same env-var
# shape as its sibling scripts/check-gate-selftest-parity.sh:
#
#   CI_FILE_OVERRIDE=<path>    the CI config to derive the gate set from  (default .gitlab-ci.yml)
#   MAKEFILE_OVERRIDE=<path>   the Makefile to look for mirrors in        (default Makefile)
#
# Exit:   0 every CI check script is mirrored or opted out · 1 at least one is neither

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CI_FILE="${CI_FILE_OVERRIDE:-.gitlab-ci.yml}"
MAKEFILE="${MAKEFILE_OVERRIDE:-Makefile}"

# Scripts that legitimately cannot run in `pre-push`. One "basename<TAB>reason" per line.
#
# `pre-push` is a seconds-scale, offline, repo-only gate. Two things disqualify a check:
# it reads state outside the working tree (so no commit can fix a failure, and a red
# would block an unrelated push), or it needs a build artifact that pre-push does not
# produce. Both are recorded rather than assumed, because "this one is different" is
# exactly the reasoning that produced the gap in the first place.
#
# Keep this list short and re-check an entry when its script changes.
#
# A REASON THAT IS FALSE IS WORSE THAN NO ENTRY (#3217). check-package-licenses.sh
# sat here for five months under "requires installed dependency trees for five
# packages". It requires nothing of the sort — it reads LICENSE and
# packages/*/LICENSE and diffs them, offline, in 0.03s. The reason had been
# written about the *dependency*-license jobs (license:check:py|web|website|mcp|
# mobile, wasm:license-check), which genuinely do need installed trees, and that
# is exactly the conflation check-package-licenses.sh's own header exists to warn
# against: a package shipping ITS OWN license text is a different obligation from
# the licenses of its dependencies.
#
# A missing entry gets caught here on the next run. A wrong one reads as a
# considered judgement and stops anyone re-deriving it — which is why it took a
# separate audit, five months later, to notice. So write the reason from the
# script in front of you, and if it names a sibling gate rather than this one,
# that is the tell.
OPT_OUT="
check-issue-boundary.sh	reads the GitLab tracker, not the repo — a failure comes from an issue label and no commit can fix it, so as a pre-push gate it would block pushes on state the pusher did not touch (#2977)
check-suppression-issues.sh	queries the tracker for issue state
check-todo-grep.sh	resolves TODO(#NNN) against open/closed issues via the tracker
check-adr-collisions.sh	compares ADR numbers against remote branches
check-release-images.sh	verifies published release images; release-time only
check-mermaid-rendered.sh	requires a full astro build of packages/website (minutes, not seconds)
check-dts-camelcase.sh	reads the wasm-pack .d.ts, which exists only after a wasm build; the wasm tree is covered by pre-push-wasm
"

opt_out_reason() {
    # Field-split on tab so a reason containing spaces survives.
    printf '%s\n' "$OPT_OUT" | while IFS=$'\t' read -r name reason; do
        [ -n "$name" ] || continue
        if [ "$name" = "$1" ]; then
            printf '%s' "$reason"
            return
        fi
    done
}

run_scan() {
    local ci="$1" makefile="$2"
    local ci_scripts script reason
    local missing=0 mirrored=0 opted=0

    # Every check script named anywhere in the CI config. Matched on basename: jobs run
    # from different working directories (the wasm jobs `cd packages/wasm-scheduler`
    # first, so they invoke ./scripts/check-dts-camelcase.sh, which lives under that
    # package), and a path-based match would silently treat those as absent.
    ci_scripts="$({ grep -oE '[A-Za-z0-9_./-]*check-[a-z0-9-]+\.(sh|py)' "$ci" || true; } \
        | xargs -n1 basename | sort -u)"

    while IFS= read -r script; do
        [ -n "$script" ] || continue
        if grep -q "$script" "$makefile"; then
            mirrored=$((mirrored + 1))
            continue
        fi
        reason="$(opt_out_reason "$script")"
        if [ -n "$reason" ]; then
            opted=$((opted + 1))
            continue
        fi
        missing=$((missing + 1))
        echo "check-prepush-parity: FAIL  scripts/$script runs in CI but has no Makefile mirror"
    done <<< "$ci_scripts"

    echo "check-prepush-parity: $mirrored mirrored, $opted opted out, $missing unmirrored."

    if [ "$missing" -gt 0 ]; then
        cat <<'MSG'

A check that runs in CI but not in `make pre-push` costs a full pipeline round trip per
breach, which is the whole reason pre-push exists. Fix by either:

  * adding a Makefile target that runs it and listing that target in `pre-push-checks`
    (the default — prefer this for anything repo-only and fast); or
  * adding it to OPT_OUT in this script with the reason it cannot run locally.

An opt-out is a claim that the check reads state outside the working tree or needs a
build artifact pre-push does not produce. Write the reason down; the next reader cannot
re-derive it.
MSG
        return 1
    fi
    return 0
}

# Prove this gate can still fail (#3195). Its failure mode is a green pipeline: the
# whole defect it exists to catch — a CI gate nobody can run before pushing — is
# invisible until an MR round-trips, so "it passed" is not evidence that it can still
# reject anything. Every case runs the REAL run_scan against fixture files, so there is
# no second copy of the CI/Makefile parsing to drift out of step.
self_test() {
    local tmp rc=0; tmp="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand now, not at trap time
    trap "rm -rf '$tmp'" EXIT

    _case() { # <name> <expect-pass|expect-fail> <ci-fixture> <makefile-fixture>
        if run_scan "$3" "$4" >/dev/null 2>&1; then
            if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
            else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; rc=1; fi
        else
            if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
            else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; rc=1; fi
        fi
    }

    # Two Makefiles: one that mirrors the fixture gate, one that names an unrelated
    # script — the shape of a Makefile that has simply fallen behind CI.
    printf 'pre-push-checks:\n\t@bash scripts/check-zz-probe.sh\n' > "$tmp/mirrored.mk"
    printf 'pre-push-checks:\n\t@bash scripts/check-unrelated-thing.sh\n' > "$tmp/bare.mk"

    printf 'lint:zz:\n  script:\n    - bash scripts/check-zz-probe.sh\n' > "$tmp/gate.yml"
    _case "gate present in both CI and the Makefile" expect-pass "$tmp/gate.yml" "$tmp/mirrored.mk"

    # THE #2941 SHAPE: a new gate job lands in CI and the Makefile never grows the
    # mirror, so a breach passes `make pre-push` and fails the MR pipeline instead.
    _case "new CI gate job with no Makefile mirror" expect-fail "$tmp/gate.yml" "$tmp/bare.mk"

    # The documented exemption has to hold too, or the gate becomes noisy enough to get
    # disabled — which is how the protection is really lost.
    printf 'lint:zz:\n  script:\n    - bash scripts/check-issue-boundary.sh\n' > "$tmp/opted.yml"
    _case "gate in CI recorded in OPT_OUT" expect-pass "$tmp/opted.yml" "$tmp/bare.mk"

    # Basename matching, not path matching: the wasm jobs cd into their package first,
    # so the same gate is invoked under a different path in each file. A path-based
    # match would read this as unmirrored and the gate would be noise.
    printf 'wasm:zz:\n  script:\n    - cd packages/wasm-scheduler && ./scripts/check-zz-probe.sh\n' > "$tmp/relpath.yml"
    _case "gate invoked under a different path in each file" expect-pass "$tmp/relpath.yml" "$tmp/mirrored.mk"

    [ "$rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
    return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi

run_scan "$CI_FILE" "$MAKEFILE"
