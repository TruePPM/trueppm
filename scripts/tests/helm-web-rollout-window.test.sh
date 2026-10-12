#!/usr/bin/env bash
# scripts/tests/helm-web-rollout-window.test.sh
#
# Unit tests for three small functions scripts/helm-install-drill.sh's
# demo-upgrade leg uses to force and PROVE a multi-pod old+new web rollout
# overlap (#4378) — #4348's `replicas.web: 1` demo pin shrank that leg's
# window to a scale-down-to-1-with-an-image-change, which a regression in
# the chunk-reload/nginx-404 asset-skew mechanism (#4341/#4350) could pass
# right through. None of the three touches a real cluster, so this is the
# part checkable in milliseconds with no kind/kubectl/helm available:
#
#   - web_replicas_set_arg(): picks `replicas.web` vs the pre-ADR-1248
#     `web.replicaCount` --set key by sniffing the target chart's OWN
#     values.schema.json, rather than assuming every published chart uses
#     today's key.
#   - web_rollout_window_parse(): turns one kubectl pod-dump sample into
#     "<old_ready> <new_ready>" web-pod counts.
#   - web_rollout_window_evaluate(): scans a log of those samples and
#     decides whether >1 old AND >1 new web pod were EVER Ready at the same
#     time — the assertion this leg exists to make, including the negative
#     control the issue's test plan calls for: a rollout that never puts
#     more than one pod of either generation up at once (replicas.web=1
#     forced) must FAIL this check, not pass it by accident.
#
# Each function is extracted verbatim from the shipping script (the same
# "not sourceable, the script boots a kind cluster on load" workaround
# scripts/tests/helm-upgrade-leg-version.test.sh already uses for
# resolve_previous_chart_version()), so a rename or reformat that breaks the
# extraction fails loudly below rather than silently testing nothing.
#
# Run: bash scripts/tests/helm-web-rollout-window.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRILL="$REPO_ROOT/scripts/helm-install-drill.sh"

pass=0
fail_count=0
check() { # check "<description>" <expected> <actual>
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc — expected '$expected', got '$actual'"
    fail_count=$((fail_count + 1))
  fi
}
die() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$DRILL" ] || die "$DRILL not found"

extract() { # extract <func_name> -> prints the function body or dies
  local name="$1" body
  body="$(awk "/^${name}\\(\\) \\{/,/^\\}\$/" "$DRILL")"
  case "$body" in
    "${name}"*'}') ;;
    *) die "could not extract ${name}() from helm-install-drill.sh — did it get renamed or reformatted? (#4378)" ;;
  esac
  [ -n "$body" ] || die "${name}() extracted as empty (#4378)"
  printf '%s\n' "$body"
}

PARSE_FUNC="$(extract web_rollout_window_parse)"
EVAL_FUNC="$(extract web_rollout_window_evaluate)"
SET_ARG_FUNC="$(extract web_replicas_set_arg)"

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "web_rollout_window_parse:"

run_parse() { # run_parse <desc> <stdin-text> <old_image> <new_image> <expected "old new">
  local desc="$1" input="$2" old_image="$3" new_image="$4" expected="$5" out
  out="$(
    printf '%s\n' "$input" | bash -c "
      $PARSE_FUNC
      web_rollout_window_parse \"\$1\" \"\$2\"
    " _ "$old_image" "$new_image"
  )"
  check "$desc" "$expected" "$out"
}

run_parse "all three old pods Ready, no new pods yet" \
  "web-abc web:v0.4.0-beta.6 true
web-def web:v0.4.0-beta.6 true
web-ghi web:v0.4.0-beta.6 true" \
  "web:v0.4.0-beta.6" "web:latest" "3 0"

run_parse "classic mid-rollout overlap: 2 old Ready + 2 new Ready" \
  "web-abc web:v0.4.0-beta.6 true
web-def web:v0.4.0-beta.6 true
web-jkl web:latest true
web-mno web:latest true" \
  "web:v0.4.0-beta.6" "web:latest" "2 2"

run_parse "a pod whose own readiness probe is false/empty is NOT counted on either side" \
  "web-abc web:v0.4.0-beta.6 true
web-def web:v0.4.0-beta.6 false
web-jkl web:latest true
web-mno web:latest " \
  "web:v0.4.0-beta.6" "web:latest" "1 1"

run_parse "a pod not yet scheduled (blank image/ready) is skipped, not miscounted" \
  "web-abc web:v0.4.0-beta.6 true
web-pqr  " \
  "web:v0.4.0-beta.6" "web:latest" "1 0"

run_parse "an image matching neither side (e.g. a stray leftover release) is ignored" \
  "web-abc web:v0.4.0-beta.5 true
web-def web:v0.4.0-beta.6 true
web-jkl web:latest true" \
  "web:v0.4.0-beta.6" "web:latest" "1 1"

run_parse "empty input (no web pods found yet) counts as 0/0, not an error" \
  "" "web:v0.4.0-beta.6" "web:latest" "0 0"

echo
echo "web_rollout_window_evaluate:"

run_eval() { # run_eval <desc> <log-lines...-as-one-string> <expected "observed old new">
  local desc="$1" loglines="$2" expected="$3" logfile out
  logfile="$TMPDIR_TEST/window-$$-$RANDOM"
  printf '%s\n' "$loglines" >"$logfile"
  out="$(bash -c "
    $EVAL_FUNC
    web_rollout_window_evaluate \"\$1\"
  " _ "$logfile")"
  check "$desc" "$expected" "$out"
  rm -f "$logfile"
}

run_eval "the real #4353/#4378 rollout shape (3 old -> 3 new through a 2/2 plateau): observed, reports the overlap pair" \
  "3 0
3 1
2 2
2 2
1 3" \
  "1 2 2"

run_eval "overlap only briefly visible on one sample still counts" \
  "3 0
3 1
2 1
2 2
1 3
0 3" \
  "1 2 2"

run_eval "NEGATIVE CONTROL (#4378 test plan): replicas.web=1 forced — old and new never both exceed 1 at the same sample, never overlapping — must report NOT observed" \
  "1 0
1 0
0 1
0 1" \
  "0 1 1"

run_eval "never more than 1 on EITHER side even when they do coexist (1 old + 1 new is not an overlap)" \
  "1 0
1 1
0 1" \
  "0 1 1"

run_eval "one side alone exceeding 1 is not an overlap (old=3 but new never Ready)" \
  "3 0
3 0
3 0" \
  "0 3 0"

run_eval "empty log (loop never sampled, e.g. rollout instant) reports not observed with zero maxima" \
  "" \
  "0 0 0"

echo
echo "web_replicas_set_arg:"

run_set_arg() { # run_set_arg <desc> <schema-file-path|__MISSING__> <schema-contents> <n> <expected 2nd array element>
  local desc="$1" schema_path="$2" schema_contents="$3" n="$4" expected="$5" schema_file out
  if [ "$schema_path" = "__MISSING__" ]; then
    schema_file="$TMPDIR_TEST/does-not-exist-$$-$RANDOM.json"
  else
    schema_file="$TMPDIR_TEST/schema-$$-$RANDOM.json"
    printf '%s' "$schema_contents" >"$schema_file"
  fi
  out="$(bash -c "
    $SET_ARG_FUNC
    web_replicas_set_arg \"\$1\" \"\$2\"
    printf '%s\n' \"\${PREV_WEB_REPLICAS_SET_ARGS[0]}\" \"\${PREV_WEB_REPLICAS_SET_ARGS[1]}\"
  " _ "$schema_file" "$n" | tr '\n' ' ')"
  out="${out% }"
  check "$desc" "$expected" "$out"
  rm -f "$schema_file"
}

run_set_arg "pre-ADR-1248 schema (0.4.0-beta.6 shape: no top-level \"replicas\" key) uses the old web.replicaCount key" \
  "present" '{"properties":{"web":{"properties":{"replicaCount":{"type":"integer"}}}}}' \
  3 "--set web.replicaCount=3"

run_set_arg "post-ADR-1248 schema (0.4.0-beta.7+ shape: top-level \"replicas\" key) uses the new replicas.web key" \
  "present" '{"properties":{"replicas":{"properties":{"web":{"type":["integer","string","null"]}}}}}' \
  3 "--set replicas.web=3"

run_set_arg "a missing/unreadable schema file falls back to the old key rather than erroring (grep -q on a nonexistent file is just a non-match)" \
  "__MISSING__" "" 3 "--set web.replicaCount=3"

echo
if [ "$fail_count" -gt 0 ]; then
  echo "helm-web-rollout-window: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-web-rollout-window: ${pass} checks passed"
