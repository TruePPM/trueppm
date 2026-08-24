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
# Usage:  scripts/check-prepush-parity.sh
# Exit:   0 every CI check script is mirrored or opted out · 1 at least one is neither

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CI_FILE=".gitlab-ci.yml"
MAKEFILE="Makefile"

# Scripts that legitimately cannot run in `pre-push`. One "basename<TAB>reason" per line.
#
# `pre-push` is a seconds-scale, offline, repo-only gate. Two things disqualify a check:
# it reads state outside the working tree (so no commit can fix a failure, and a red
# would block an unrelated push), or it needs a build artifact that pre-push does not
# produce. Both are recorded rather than assumed, because "this one is different" is
# exactly the reasoning that produced the gap in the first place.
#
# Keep this list short and re-check an entry when its script changes.
OPT_OUT="
check-issue-boundary.sh	reads the GitLab tracker, not the repo — a failure comes from an issue label and no commit can fix it, so as a pre-push gate it would block pushes on state the pusher did not touch (#2977)
check-suppression-issues.sh	queries the tracker for issue state
check-todo-grep.sh	resolves TODO(#NNN) against open/closed issues via the tracker
check-adr-collisions.sh	compares ADR numbers against remote branches
check-release-images.sh	verifies published release images; release-time only
check-mermaid-rendered.sh	requires a full astro build of packages/website (minutes, not seconds)
check-package-licenses.sh	requires installed dependency trees for five packages
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

# Every check script named anywhere in the CI config. Matched on basename: jobs run from
# different working directories (the wasm jobs `cd packages/wasm-scheduler` first, so
# they invoke ./scripts/check-dts-camelcase.sh, which lives under that package), and a
# path-based match would silently treat those as absent.
ci_scripts="$(grep -oE '[A-Za-z0-9_./-]*check-[a-z0-9-]+\.(sh|py)' "$CI_FILE" | xargs -n1 basename | sort -u)"

missing=0
mirrored=0
opted=0

while IFS= read -r script; do
    [ -n "$script" ] || continue
    if grep -q "$script" "$MAKEFILE"; then
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
    exit 1
fi
