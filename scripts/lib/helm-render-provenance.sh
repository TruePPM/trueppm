# shellcheck shell=bash
#
# Failure-path diagnostics shared by the two gates that assert on a rendered
# `helm template` of packages/helm (#3146).
#
# Both gates have red main with a violation naming a chart regression that did
# not exist. On 2026-08-28 `nginx:headers` reported that the *demo* render
# emitted the production block; the same evening `helm:template` reported that
# the *production* render emitted a demo-shaped `/admin/` with no `deny all`.
# Mirror images of one shape: an `{{- if }}` on a values `enabled` flag in
# templates/web/configmap.yaml selecting the wrong branch, on a tree with no
# chart change, clearing on a retry of the identical sha. The pinned CI image
# renders that tree correctly 120 times out of 120 locally, so the
# non-determinism is in what the render READ, not in the chart or in helm.
#
# The cost is not the retry — it is that the violation text points at the chart.
# An operator reading "production nginx /admin/ block has no 'deny all'" on a red
# main has every reason to go looking for a chart regression, and there is
# nothing there. Nothing in the job log separates "the chart is wrong" from "the
# render did not read the chart".
#
# So this prints, on the failure path ONLY, the three facts that separate them:
# which tree the render actually read, what the on-disk flags say, and whether
# the render reproduces. It deliberately does NOT suppress or retry the failure —
# a `retry:` on these jobs would hide a real chart regression just as well as it
# hides this, and catching that regression is the whole point of the gates.

# Print render provenance for $1 (chart path) to stderr. Never fails: every
# probe is guarded, because this runs immediately before the caller's own
# `exit 1` and must not mask it or crash under `set -euo pipefail`.
helm_render_provenance() {
  local chart="${1:-packages/helm}"
  local values="$chart/values.yaml"
  local sha dirty

  {
    echo ""
    echo "--- render provenance (#3146) ---"

    # 1. WHICH TREE did this render read? A commit that disagrees with
    #    CI_COMMIT_SHA, or a dirty worktree in a CI job, means the render and the
    #    pipeline were not looking at the same code — the stale-build-directory
    #    hypothesis, confirmed or killed in one line.
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

    # 3. DOES THE RENDER REPRODUCE? Two identical invocations that disagree is
    #    proof of an environment fault, decided here rather than left to a
    #    human's hunch about whether a retry is honest.
    if command -v helm >/dev/null 2>&1; then
      local r1 r2
      r1="$(_helm_provenance_render "$chart")"
      r2="$(_helm_provenance_render "$chart")"
      _helm_provenance_verdict "$r1" "$r2"
      if [ -n "$r1" ]; then
        echo "  rendered /admin/ block:"
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

# The default-values web ConfigMap render, which is the one both gates' /admin/
# assertions read. Errors are swallowed on purpose: an empty result is itself
# reported above, and this must never be the thing that kills the caller.
_helm_provenance_render() {
  helm template trueppm "$1" --set image.tag=latest \
    --show-only templates/web/configmap.yaml 2>/dev/null || true
}

# The reproducibility verdict, split out from the probe above so it can be
# exercised directly: this is failure-path-only code that will almost never run
# in anger, which is exactly the code a typo hides in forever. Driven by
# check-nginx-security-headers.sh --self-test, which CI runs on every pipeline.
_helm_provenance_verdict() {
  local r1="$1" r2="$2"
  if [ -z "$r1" ]; then
    echo "  re-render         : produced NOTHING — helm template is failing outright"
  elif [ "$r1" != "$r2" ]; then
    echo "  re-render         : NOT REPRODUCIBLE — two identical renders disagreed"
    echo "  VERDICT: the render is non-deterministic in this environment. This is an"
    echo "           environment fault, not a chart regression: RETRY THE JOB, and"
    echo "           add the job URL to #3146."
  else
    echo "  re-render         : reproducible (2 identical renders)"
    echo "  VERDICT: the render is stable HERE. Compare the /admin/ block below"
    echo "           against the flags above — if they agree, this is a real chart"
    echo "           regression and the gate is right; if they contradict each other,"
    echo "           the render read a different tree: RETRY and note it on #3146."
  fi
}
