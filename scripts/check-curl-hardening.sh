#!/usr/bin/env bash
# curl redirect-hardening guard (issue #2990).
#
# WHY THIS EXISTS
# ---------------
# `curl -L` follows redirects, and by default will follow one from https:// onto
# plaintext http://. In #2988 `curl -sSL` in scripts/helm-netpol-drill.sh could be
# bounced onto http:// and the fetched bytes were then `kubectl apply`d as
# cluster-admin. Nothing in pre-push or the MR pipeline looked at curl invocations;
# the only detector was the scheduled-only Sonar scan (shell:S6506), three days
# after the code reached main. The convention already exists
# (.gitlab/ci-images/wasm.Dockerfile pins `--proto '=https' --proto-redir '=https'`)
# but was unenforced, so each new script re-decided it.
#
# WHAT IS CHECKED
#   Every tracked *.sh file. A `curl` invocation (continuation lines joined) that
#   follows redirects -- `-L`, `--location`, `--location-trusted`, or a short-option
#   bundle containing L such as `-fsSL` / `-sSfL` -- must also carry
#   `--proto-redir '=https'` (quoted or not). Comment lines are ignored.
#
# SCOPE LIMITS (honest about them)
#   - scripts/tests/pre-bash-deny.test.sh is excluded: its curl lines are command
#     STRINGS fed to the deny hook as fixtures, never executed.
#   - Only *.sh files. curl lines inside .gitlab-ci.yml / .gitlab/ci/*.yml (dozens of
#     pinned-checksum tool downloads) and Dockerfiles are NOT scanned; widening this
#     needs its own triage and is not claimed here.
#   - A redirect-following flag assembled in a variable (`OPTS=-L; curl $OPTS`) is
#     invisible to text matching.
#   - --proto-redir proves the scheme only. Payload integrity is a separate control
#     (checksum verification), so a pinned site still wants a sha256 check.
#
# WAIVER
#   A site that legitimately must allow http (e.g. a self-hosted GitLab reached via
#   ${CI_API_V4_URL}) carries a comment on the line above, or at the end of the
#   curl line, of the form:
#       # curl-hardening-ok: <reason>
#   The reason is required; a bare marker is rejected.
#
# USAGE
#   check-curl-hardening.sh [file ...]   # default: git ls-files '*.sh'
#   check-curl-hardening.sh --self-test  # prove the gate fails when it should
#
# EXIT CODES
#   0  every redirect-following curl is pinned or waived
#   1  at least one unpinned, unwaived curl -L
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scan() {
    # POSIX awk (BSD awk on macOS, BusyBox in CI): no gawk extensions.
    awk '
    function flush(   line, n, i, tok, follows, pinned, waived) {
        if (buf == "") return
        line = buf; buf = ""
        if (line ~ /^[[:space:]]*#/) { prev = line; return }
        if (line !~ /(^|[^A-Za-z0-9_.\/-])curl([[:space:]]|$)/) { prev = line; return }
        follows = 0; pinned = 0
        n = split(line, tok, /[[:space:]]+/)
        for (i = 1; i <= n; i++) {
            if (tok[i] == "--location" || tok[i] == "--location-trusted") follows = 1
            else if (tok[i] ~ /^-[A-Za-z]*L[A-Za-z]*$/) follows = 1
        }
        if (line ~ /--proto-redir[= ]+["\047]?=https/) pinned = 1
        waived = 0
        if ((prev ~ /curl-hardening-ok:[[:space:]]*[^[:space:]]/) || (line ~ /curl-hardening-ok:[[:space:]]*[^[:space:]]/)) waived = 1
        if (follows && !pinned && !waived) {
            printf "%s:%d: curl follows redirects without --proto-redir \047=https\047\n", FILENAME, startno
            bad = 1
        }
        prev = line
    }
    FNR == 1 { flush(); prev = "" }
    {
        if (buf == "") startno = FNR
        if ($0 ~ /\\[[:space:]]*$/) { sub(/\\[[:space:]]*$/, " "); buf = buf $0; next }
        buf = buf $0
        flush()
    }
    END { flush(); exit bad + 0 }
    ' "$@"
}

if [[ "${1:-}" == "--self-test" ]]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    fail=0

    # expect <name> <rejected|accepted> <body>
    expect() {
        local name="$1" want="$2" body="$3" rc=0
        printf '%s\n' "$body" >"$tmp/$name.sh"
        scan "$tmp/$name.sh" >/dev/null 2>&1 || rc=$?
        if [[ "$want" == rejected && $rc -ne 0 ]] || [[ "$want" == accepted && $rc -eq 0 ]]; then
            echo "✓ self-test '$name': correctly ${want}"
        else
            echo "✖ self-test '$name': expected ${want}, scan exit was $rc"
            fail=1
        fi
    }

    expect bare-L rejected 'curl -L https://example.com/x -o x'
    expect bundle-fsSL rejected 'curl -fsSL https://example.com/x -o x'
    expect bundle-sSfL rejected 'curl -sSfL https://example.com/x -o x'
    expect long-location rejected 'curl --location https://example.com/x'
    expect continuation rejected $'curl -sS \\\n  -L \\\n  https://example.com/x'
    expect proto-only-not-enough rejected "curl -fsSL --proto '=https' https://example.com/x"
    expect pinned accepted "curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://example.com/x"
    expect pinned-continuation accepted $'curl -fsSL \\\n  --proto-redir =https \\\n  https://example.com/x'
    expect no-redirect accepted 'curl -s -o /dev/null -w "%{http_code}" https://example.com/x'
    expect comment-ignored accepted '# curl -L is dangerous without --proto-redir'
    expect waived-above accepted $'# curl-hardening-ok: self-hosted GitLab may be http\ncurl -fsSL "${API}/x"'
    expect waived-bare-marker rejected $'# curl-hardening-ok:\ncurl -fsSL "${API}/x"'
    expect not-curl-word accepted 'my_curl -L https://example.com/x'

    clean=()
    while IFS= read -r f; do clean+=("$f"); done < <(git ls-files '*.sh' ':!:scripts/tests/pre-bash-deny.test.sh')
    if scan "${clean[@]}" >/dev/null 2>&1; then
        echo "✓ self-test 'clean-tree': correctly accepted"
    else
        echo "✖ self-test 'clean-tree': the repo should pass"
        fail=1
    fi

    [[ "$fail" -eq 0 ]] && echo "" && echo "✓ self-test passed"
    exit "$fail"
fi

if [[ $# -gt 0 ]]; then
    scan "$@"
    exit $?
fi

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files '*.sh' ':!:scripts/tests/pre-bash-deny.test.sh')
if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "check-curl-hardening: no tracked *.sh files found" >&2
    exit 1
fi

if scan "${FILES[@]}"; then
    echo "check-curl-hardening: ${#FILES[@]} shell files scanned, every redirect-following curl is pinned or waived"
else
    echo "" >&2
    echo "Pin the call with --proto '=https' --proto-redir '=https', or waive a site that" >&2
    echo "must allow http with a '# curl-hardening-ok: <reason>' comment above it." >&2
    exit 1
fi
