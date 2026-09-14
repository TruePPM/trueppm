# shellcheck shell=bash
#
# Failure-path diagnostics shared by the two gates that assert on a rendered
# `helm template` of packages/helm (#3146, #3758).
#
# Both gates have red main with a violation naming a chart regression that did
# not exist. On 2026-08-28 `nginx:headers` reported that the *demo* render
# emitted the production block; the same evening `helm:template` reported that
# the *production* render emitted a demo-shaped `/admin/` with no `deny all`.
# Later occurrences each dropped a single header line from an otherwise intact
# render. The pinned CI image renders those trees correctly every time locally.
#
# Two things can produce that: the render read different bytes than the ones
# committed, or the render was right and the ASSERTION misfired. The second is
# real — `printf "$x" | grep -q` under `set -o pipefail` reports a present line
# as missing whenever grep exits before the writer finishes (SIGPIPE, 141), and
# both gates made dozens of such assertions until #3758.
#
# The cost is not the retry — it is that the violation text points at the chart.
# So this prints, on the failure path ONLY, the facts that separate the cases:
# which tree the render read, what the on-disk flags say, whether the render
# reproduces, and — when the caller hands over the render it actually checked —
# whether the bytes the gate asserted on are the bytes the chart produces. It
# deliberately does NOT suppress or retry the failure: a `retry:` on these jobs
# would hide a real chart regression just as well, and catching that regression
# is the whole point of the gates.

# helm_render_provenance CHART [CHECKED_RENDER_FILE LABEL [HELM_ARGS...]]
#
# Print render provenance to stderr. Never fails: every probe is guarded, because
# this runs immediately before the caller's own `exit 1` and must not mask it or
# crash under `set -euo pipefail`.
#
# With only CHART, the re-renders use default values and can say whether helm is
# deterministic here, but NOT whether the failed assertion read that render.
# Pass CHECKED_RENDER_FILE (the exact stdout the gate asserted on), a LABEL, and
# the same HELM_ARGS the gate rendered with, and the verdict compares against the
# checked bytes — the only comparison that can decide the failure.
helm_render_provenance() {
  local chart="${1:-packages/helm}"
  local checked_file="${2:-}" label="${3:-default values}"
  if [ "$#" -ge 3 ]; then shift 3; else shift "$#"; fi
  local values="$chart/values.yaml"
  local sha dirty

  {
    echo ""
    echo "--- render provenance: $label (#3146, #3758) ---"

    # 1. WHICH TREE did this render read? A commit that disagrees with
    #    CI_COMMIT_SHA, or a dirty worktree in a CI job, means the render and the
    #    pipeline were not looking at the same code.
    sha="$(git rev-parse HEAD 2>/dev/null || echo '(not a git worktree)')"
    echo "  HEAD              : $sha"
    if [ -n "${CI_COMMIT_SHA:-}" ]; then
      echo "  CI_COMMIT_SHA     : $CI_COMMIT_SHA"
      if [ "$sha" != "$CI_COMMIT_SHA" ]; then
        echo "  !! HEAD does not match CI_COMMIT_SHA — the render read a DIFFERENT tree"
        echo "     than the pipeline is testing. Environment fault: RETRY THE JOB."
      fi
    fi
    dirty="$(git status --porcelain -- "$chart" 2>/dev/null || true)"
    if [ -n "$dirty" ]; then
      echo "  worktree          : DIRTY under $chart —"
      printf '%s\n' "$dirty" | sed 's/^/                      /'
    else
      echo "  worktree          : clean under $chart"
    fi

    # 2. WHAT DO THE FLAGS SAY on disk? Every one of these selects an nginx
    #    branch in templates/web/configmap.yaml. A rendered branch that
    #    contradicts its own values file is not a chart bug.
    if command -v yq >/dev/null 2>&1 && [ -f "$values" ]; then
      echo "  branch flags in $values:"
      local key
      for key in .web.enabled .web.adminAccess.enabled \
                 .web.adminAccess.rateLimit.enabled \
                 .web.securityHeaders.enabled .demo.enabled; do
        echo "    $key = $(yq "$key" "$values" 2>/dev/null || echo '(unreadable)')"
      done
    else
      echo "  branch flags      : (yq unavailable — skipped)"
    fi
    [ "$#" -gt 0 ] && echo "  render args       : $*"

    # 3. DOES THE RENDER REPRODUCE, and is it what the gate checked?
    if command -v helm >/dev/null 2>&1; then
      local r1 r2 checked
      r1="$(_helm_provenance_render "$chart" "$@")"
      r2="$(_helm_provenance_render "$chart" "$@")"
      if [ -n "$checked_file" ] && [ -f "$checked_file" ]; then
        checked="$(cat "$checked_file")"
        _helm_provenance_verdict "$r1" "$r2" "$checked"
        if [ -n "$r1" ] && [ "$checked" != "$r1" ]; then
          echo "  checked render vs re-render (first 40 diff lines):"
          diff "$checked_file" <(printf '%s\n' "$r1") 2>/dev/null \
            | sed -n '1,40p' | sed 's/^/    /'
        fi
      else
        _helm_provenance_verdict "$r1" "$r2"
      fi
      if [ -n "$r1" ]; then
        # The lines every nginx assertion reads — not just /admin/, so a missing
        # header can be checked against the render by eye.
        echo "  re-rendered listen / try_files / add_header lines:"
        printf '%s\n' "$r1" \
          | grep -E '^[[:space:]]*(listen|try_files|add_header)[[:space:]]' \
          | sed 's/^[[:space:]]*/    /' || true
        echo "  re-rendered /admin/ block:"
        printf '%s\n' "$r1" \
          | sed -n '/location \/admin\//,/^[[:space:]]*}[[:space:]]*$/p' \
          | sed 's/^/    /'
      fi
    else
      echo "  re-render         : (helm unavailable — skipped)"
    fi
    echo "--- end render provenance ---"
  } >&2 || true
}

# The web ConfigMap render the nginx assertions read, with the caller's args.
# Errors are swallowed on purpose: an empty result is itself reported, and this
# must never be the thing that kills the caller.
_helm_provenance_render() {
  local chart="$1"; shift
  helm template trueppm "$chart" --set image.tag=latest "$@" \
    --show-only templates/web/configmap.yaml 2>/dev/null || true
}

# _helm_provenance_verdict R1 R2 [CHECKED]
#
# Split out from the probe above so it can be exercised directly: this is
# failure-path-only code that will almost never run in anger, which is exactly
# the code a typo hides in forever. Driven by
# check-nginx-security-headers.sh --self-test, which CI runs on every pipeline.
# The CHECKED argument is optional and distinguished by argument count, not by
# emptiness, so a caller that passes the checked render always gets the decisive
# comparison.
_helm_provenance_verdict() {
  local r1="$1" r2="$2"
  if [ -z "$r1" ]; then
    echo "  re-render         : produced NOTHING — helm template is failing outright"
  elif [ "$r1" != "$r2" ]; then
    echo "  re-render         : NOT REPRODUCIBLE — two identical renders disagreed"
    echo "  VERDICT: the render is non-deterministic in this environment. This is an"
    echo "           environment fault, not a chart regression: RETRY THE JOB, and"
    echo "           add the job URL to #3758."
  elif [ "$#" -ge 3 ] && [ "$3" != "$r1" ]; then
    echo "  checked render    : DIFFERS from two identical re-renders"
    echo "  VERDICT: the gate asserted on bytes this tree does not produce. This is an"
    echo "           environment fault, not a chart regression: RETRY THE JOB, and"
    echo "           add the job URL to #3758."
  elif [ "$#" -ge 3 ]; then
    echo "  checked render    : identical to two re-renders (deterministic)"
    echo "  VERDICT: the render is not the cause — the gate asserted on exactly what"
    echo "           the chart produces. If the lines below confirm the violation,"
    echo "           this is a real chart regression: fix the chart. If the line the"
    echo "           violation calls missing IS printed below, the assertion itself"
    echo "           misfired — retry the job and add its URL to #3758."
  else
    echo "  re-render         : reproducible (2 identical renders)"
    echo "  VERDICT: the render is stable HERE, but this caller did not pass the render"
    echo "           it checked, so that render was not compared. Read the lines below"
    echo "           against the failure: if they confirm it, this is a real chart"
    echo "           regression; if they contradict it, retry and note it on #3758."
  fi
}
