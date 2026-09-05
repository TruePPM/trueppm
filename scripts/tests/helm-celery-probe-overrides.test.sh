#!/usr/bin/env bash
# scripts/tests/helm-celery-probe-overrides.test.sh
#
# The two runtime drills — scripts/helm-install-drill.sh and
# scripts/helm-netpol-drill.sh — each carry a CELERY_PROBE_OVERRIDES array, and
# they must hold the SAME values (#3218, #3230).
#
# Why that needs a test rather than the prose "keep the two in sync" note it had:
# the two drills install the same chart the same way, and #3218 established that
# they fail the same way when the celery exec probes are left at chart defaults on
# a loaded kind-in-dind node. If the arrays drift, the drills silently start
# testing different probe postures — and the direction that matters is invisible,
# because the drill whose override is now weaker just goes bimodal again. That
# reads as a flake, not as a config drift, and it is the exact misdiagnosis #3218
# spent two jobs unwinding.
#
# Both drills need a kind cluster, Calico, and the release images, so neither can
# run outside CI. This is the part that can be checked in milliseconds with no
# cluster: whether the two definitions still agree, whether each is actually USED,
# and whether every key they name is one values.schema.json still accepts.
#
# That last one is not decoration. The chart's root schema is closed
# (additionalProperties: false), so a renamed probe key does not degrade — it makes
# `helm install` refuse outright, and it does so only inside the expensive runtime
# job, minutes in, with a message about the values file rather than about the
# rename. #3230 renamed nothing, but it moved the celery probes to a per-probe
# shape (probes.worker.liveness.* / .readiness.*) and made the four flat keys a
# shared override, which is exactly the kind of change that leaves a drill pointing
# at a key that no longer exists.
#
# The arrays are EXTRACTED from the shipping drills, not restated here, so this
# test cannot pass against a definition it invented. If a rename ever breaks the
# extraction, the guards below fire rather than the test vacuously passing over two
# empty arrays.
#
# Run: bash scripts/tests/helm-celery-probe-overrides.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DRILL="$REPO_ROOT/scripts/helm-install-drill.sh"
NETPOL_DRILL="$REPO_ROOT/scripts/helm-netpol-drill.sh"
SCHEMA="$REPO_ROOT/packages/helm/values.schema.json"

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
  return 0
}
die() { echo "FAIL: $*" >&2; exit 1; }

for f in "$INSTALL_DRILL" "$NETPOL_DRILL" "$SCHEMA"; do
  [ -f "$f" ] || die "$f not found"
done

# --- Extract both arrays from the shipping drills ---------------------------
# The drills are not sourceable (each creates a kind cluster on load), so lift the
# literal array assignment out and re-evaluate just that.
extract_overrides() { # extract_overrides <drill-path> <target-array-name>
  local body
  body="$(awk '/^CELERY_PROBE_OVERRIDES=\(/,/^\)[[:space:]]*$/' "$1" \
    | sed '1s/^CELERY_PROBE_OVERRIDES=(/(/')"
  case "$body" in
    '('*')') ;;
    *) return 1 ;;
  esac
  eval "$2=$body"
}

extract_overrides "$INSTALL_DRILL" INSTALL_OVERRIDES \
  || die "could not extract CELERY_PROBE_OVERRIDES from helm-install-drill.sh — did it get renamed or reformatted? (#3230)"
extract_overrides "$NETPOL_DRILL" NETPOL_OVERRIDES \
  || die "could not extract CELERY_PROBE_OVERRIDES from helm-netpol-drill.sh — did it get renamed or reformatted? (#3230)"

# A pair of empty arrays would compare equal and prove nothing. This is the guard
# that keeps the whole file from going vacuous after an unrelated edit.
[ "${#INSTALL_OVERRIDES[@]}" -gt 0 ] \
  || die "helm-install-drill.sh CELERY_PROBE_OVERRIDES extracted as empty — the comparison below would be vacuous (#3230)"
[ "${#NETPOL_OVERRIDES[@]}" -gt 0 ] \
  || die "helm-netpol-drill.sh CELERY_PROBE_OVERRIDES extracted as empty — the comparison below would be vacuous (#3230)"

# --- 1. The two definitions must agree, element for element -----------------

check "both drills declare the same number of probe overrides" \
  "${#INSTALL_OVERRIDES[@]}" "${#NETPOL_OVERRIDES[@]}"

if [ "${#INSTALL_OVERRIDES[@]}" -eq "${#NETPOL_OVERRIDES[@]}" ]; then
  i=0
  while [ "$i" -lt "${#INSTALL_OVERRIDES[@]}" ]; do
    check "override[$i] matches across the two drills" \
      "${INSTALL_OVERRIDES[$i]}" "${NETPOL_OVERRIDES[$i]}"
    i=$((i + 1))
  done
else
  echo "  install: ${INSTALL_OVERRIDES[*]}"
  echo "  netpol:  ${NETPOL_OVERRIDES[*]}"
fi

# --- 2. Each array must actually be PASSED to helm install ------------------
# A synced-but-unreferenced array is the same defect wearing a disguise: the
# drill reverts to chart defaults and goes bimodal, while this file stays green.

for drill in "$INSTALL_DRILL" "$NETPOL_DRILL"; do
  name="$(basename "$drill")"
  if grep -q '"${CELERY_PROBE_OVERRIDES\[@\]}"' "$drill"; then
    check "$name passes CELERY_PROBE_OVERRIDES to helm install" yes yes
  else
    check "$name passes CELERY_PROBE_OVERRIDES to helm install" yes no
  fi
done

# --- 3. Every key named must be one values.schema.json still accepts --------
# The chart schema is closed, so an override naming a key the chart no longer has
# does not degrade — `helm install` refuses, minutes into the runtime job.

if command -v jq >/dev/null 2>&1; then
  # Walk dotted values paths through the schema, following $ref. A key absent from
  # `properties` is a key `additionalProperties: false` will reject.
  schema_accepts() { # schema_accepts probes.worker.liveness.enabled
    jq -e --arg p "$1" '
      . as $root
      | def deref:
          if (type == "object") and (has("$ref"))
          then (.["$ref"] | ltrimstr("#/") | split("/")) as $q | ($root | getpath($q))
          else . end;
        reduce ($p | split(".") | .[]) as $k (.;
          if . == null then null else (deref | .properties[$k]) end)
      | . != null
    ' "$SCHEMA" >/dev/null 2>&1
  }

  # Self-check the walker before trusting its verdicts: a jq program that silently
  # returned false for everything would report every override as invalid, and one
  # that returned true for everything would report none — both look like a
  # decisive answer.
  schema_accepts probes.worker.enabled \
    && check "schema walker resolves a known key" yes yes \
    || check "schema walker resolves a known key" yes no
  schema_accepts probes.worker.thisKeyDoesNotExist \
    && check "schema walker rejects an invented key" no yes \
    || check "schema walker rejects an invented key" no no

  for arg in "${INSTALL_OVERRIDES[@]}"; do
    case "$arg" in
      --set) continue ;;
      *=*)
        key="${arg%%=*}"
        if schema_accepts "$key"; then
          check "values.schema.json accepts '$key'" yes yes
        else
          check "values.schema.json accepts '$key'" yes no
        fi
        ;;
    esac
  done
else
  echo "  NOTE: jq not on PATH — skipping the values.schema.json key check."
fi

if [ "$fail_count" -gt 0 ]; then
  echo "helm-celery-probe-overrides: ${fail_count} failed, ${pass} passed"
  exit 1
fi
echo "helm-celery-probe-overrides: ${pass} checks passed"
