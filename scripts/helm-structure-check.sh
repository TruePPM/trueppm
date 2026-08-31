#!/usr/bin/env bash
# Structural invariants for the TruePPM Helm chart (#2279).
#
# `helm lint` and `helm template` prove the chart RENDERS; they do not prove the
# rendered manifests still honor the runtime contract the beta QA plan §2.4 checks
# by hand. This script asserts that contract statically — no cluster — so a
# refactor that reorders the init containers, drops the shared admin-password
# volume, or stops propagating the operator's secret to an init container fails in
# the lint stage instead of at deploy time.
#
# Requires: helm, yq (mikefarah v4) on PATH.
#
# Modes:
#   bash scripts/helm-structure-check.sh [chart]   # assert the contract
#   bash scripts/helm-structure-check.sh --self-test
set -euo pipefail

# ---------------------------------------------------------------------------
# Self-test (#3195)
# ---------------------------------------------------------------------------
# This gate's failure mode is a GREEN pipeline over a chart that no longer holds
# the contract, so "it passed" is not evidence that it can still fail. That is
# not hypothetical: `boundary:imports` passed a real Apache-2.0 violation for its
# entire existence (#3172) while carrying a test suite that ran in a different
# image. scripts/check-gate-selftest-parity.sh requires the proof to run in the
# gate's OWN job, because the job is the only way to name the image.
#
# SCOPE — stated plainly, because a self-test that looks comprehensive and is not
# is worse than none. The fixtures below exercise SECTION 5 ONLY: the
# NetworkPolicy datastore-client contract, i.e. np_components / np_allows and the
# workload loop that consumes them. Nothing else in this file is fixture-driven.
# The list of what is NOT covered is at the end of this block; read it before
# citing this self-test as evidence about any other assertion.
#
# Section 5 is the one that earns a fixture. It has a live failure history in
# BOTH directions: it missed the `backup` CronJob and the `demo-seed` Job
# entirely on an enforcing CNI (#2560), and once written its parse produced a
# confident, specific, WRONG failure under any yq older than 4.44 (#3147).
if [ "${1:-}" = "--self-test" ]; then
  st_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  st_src="$st_root/packages/helm"
  command -v helm >/dev/null 2>&1 || { echo "SELF-TEST ERROR: helm is not on PATH." >&2; exit 2; }
  command -v yq   >/dev/null 2>&1 || { echo "SELF-TEST ERROR: yq is not on PATH." >&2; exit 2; }
  [ -d "$st_src" ] || { echo "SELF-TEST ERROR: no chart at $st_src." >&2; exit 2; }
  st_real_yq="$(command -v yq)"

  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $st_tmp now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_path_prefix=""

  # A fixture chart is a COPY of the shipped chart with one line changed, never a
  # hand-written minimal one: the other ~18 assertions here read the init
  # containers, NOTES.txt, values.schema.json, the backup CronJob, the media
  # claim and the placement knobs, so anything smaller than the real chart is
  # rejected for reasons that have nothing to do with the planted violation.
  ST_CHART=""
  st_make_chart() { # <name> [file-relative-to-chart] [sed-expression]
    ST_CHART="$st_tmp/$1"
    # `cp -R "$st_src" "$ST_CHART"` would COPY THE SYMLINK if packages/helm is one
    # (BSD and GNU cp -R both preserve a symlinked source operand), and every
    # mutation below would then be written straight through it into the real
    # chart. Copying the directory's CONTENTS forces the traversal.
    mkdir -p "$ST_CHART"
    cp -R "$st_src"/. "$ST_CHART"/
    [ -n "${2:-}" ] || return 0
    sed "$3" "$ST_CHART/$2" > "$ST_CHART/$2.st" && mv "$ST_CHART/$2.st" "$ST_CHART/$2"
    # A mutation that silently no-ops reads exactly like a gate that stopped
    # detecting — the probe below would report "accepted and must not be" while
    # the truth is that the chart moved and the fixture planted nothing. Say so.
    if cmp -s "$ST_CHART/$2" "$st_src/$2"; then
      echo "SELF-TEST ERROR: fixture '$1' planted nothing — '$3' no longer matches $2." >&2
      st_rc=1
    fi
  }

  st_probe() { # <desc> <expect-pass|expect-fail> <chart-dir> [required-message-fragment]
    local desc="$1" expect="$2" chart="$3" want="${4:-}" out rc=0 got
    if [ -n "$st_path_prefix" ]; then
      out="$(PATH="$st_path_prefix:$PATH" TRUEPPM_SELFTEST_REAL_YQ="$st_real_yq" \
             bash "$0" "$chart" 2>&1)" || rc=$?
    else
      out="$(bash "$0" "$chart" 2>&1)" || rc=$?
    fi

    if [ "$rc" -eq 0 ]; then
      if [ "$expect" = "expect-pass" ]; then
        echo "SELF-TEST OK: $desc accepted."
      else
        echo "SELF-TEST FAILED: $desc was accepted and must not be." >&2
        st_rc=1
      fi
      return 0
    fi

    if [ "$expect" != "expect-fail" ]; then
      echo "SELF-TEST FAILED: $desc was rejected and must not be:" >&2
      printf '%s\n' "$out" | sed -n '1,3p' >&2
      st_rc=1
      return 0
    fi

    # Rejected as expected — but by the RIGHT assertion? This file makes ~19
    # independent assertions, and a fixture that broke the chart in some
    # unrelated way would also exit non-zero and would read exactly like
    # detection. Pin the message, or the probe proves only that helm ran.
    if [ -n "$want" ] && ! printf '%s\n' "$out" | grep -qF "$want"; then
      got="$(printf '%s\n' "$out" | grep '^FAIL:' | sed -n '1p' || true)"
      echo "SELF-TEST FAILED: $desc was rejected, but not by the assertion under test." >&2
      echo "  expected a message containing: $want" >&2
      echo "  got: ${got:-<no FAIL: line>}" >&2
      st_rc=1
      return 0
    fi
    echo "SELF-TEST OK: $desc correctly rejected."
  }

  # ── Family 1: a real chart-level violation ────────────────────────────────
  # The defect the gate exists to catch, in each of its three shapes. All three
  # render, all three pass `helm lint`, kubeconform and the helm:install drill
  # (kind's default CNI does not enforce NetworkPolicy), and all three drop the
  # workload's datastore traffic on a cluster that does enforce.
  st_make_chart clean
  st_probe "the shipped chart, unmodified" expect-pass "$ST_CHART"

  st_make_chart missing_pg templates/networkpolicy.yaml 's/"backup" "demo-seed"/"backup"/'
  st_probe "a DATABASE_URL client dropped from the postgresql allow-list" \
    expect-fail "$ST_CHART" "is NOT in the postgresql NetworkPolicy ingress allow-list"

  st_make_chart missing_vk templates/networkpolicy.yaml 's/"celery-beat" "demo-seed"/"celery-beat"/'
  st_probe "a REDIS_URL client dropped from the valkey allow-list" \
    expect-fail "$ST_CHART" "is NOT in the valkey NetworkPolicy ingress allow-list"

  # The label is what every ingress rule matches ON, so a workload without one is
  # unreachable by any policy — a hole the allow-list check cannot see, because
  # there is nothing to look up.
  st_make_chart no_component templates/demo-seed-job.yaml '/app.kubernetes.io\/component: demo-seed/d'
  st_probe "a datastore client carrying no app.kubernetes.io/component label" \
    expect-fail "$ST_CHART" "carries no app.kubernetes.io/component label"

  # ── Family 2: the #3147 yq-separator regression ───────────────────────────
  # np_components reads a MULTI-DOCUMENT stream on stdin. The pinned v4.44.3
  # emits a blank line for each document `select()` skips; v4.35.2 (what alpine
  # packages) emits a `---` DOCUMENT SEPARATOR instead. The old parse joined the
  # result into a comma string and substring-matched it, so the separator landed
  # inside the list — `,---api,celery-worker,celery-beat,demo-seed---,` — and
  # every membership test failed, naming a chart file to go edit for a
  # NetworkPolicy regression that was not there.
  #
  # The shim INJECTS the separators rather than rewriting whatever the local yq
  # emits: yq >= 4.53 emits neither a blank line nor a separator here, so a
  # rewrite-based shim would be a silent no-op on a developer laptop and this
  # case would prove nothing there while appearing to pass.
  #
  # Two scopings, both load-bearing:
  #   * stdin only — any argument that is an existing file passes straight
  #     through. assert_url_env_bindings queries single-document doc_N.yml FILES,
  #     where BOTH yq versions emit a blank line; rewriting those invents a
  #     failure in a check that has nothing to do with #3147.
  #   * NetworkPolicy queries only — the call site #3147 was about. This is NOT a
  #     claim that the whole script is yq-version-independent, and it must not be
  #     read as one: section 9c compares a single-value stdin `select()` against
  #     `[ "$x" = "op-db/url" ]` and would genuinely break under a real v4.35.2.
  st_shim="$st_tmp/oldyq"
  mkdir -p "$st_shim"
  cat > "$st_shim/yq" <<'ST_SHIM'
#!/usr/bin/env bash
# yq shim: emulate v4.35.2's `---`-per-skipped-document output style, for
# NetworkPolicy queries read from stdin only. Installed by --self-test (#3147).
set -o pipefail
real="${TRUEPPM_SELFTEST_REAL_YQ:?}"
for a in "$@"; do
  if [ -f "$a" ]; then exec "$real" "$@"; fi
done
case "$*" in
  *NetworkPolicy*) ;;
  *) exec "$real" "$@" ;;
esac
echo '---'
"$real" "$@" | sed 's/^$/---/'
rc=$?
echo '---'
exit "$rc"
ST_SHIM
  chmod +x "$st_shim/yq"

  # The shim has to be shown to be LIVE. If PATH ordering, a rename or a changed
  # yq invocation ever disarms it, both cases below would pass on the pinned yq
  # and this family would silently become decoration — the exact shape of failure
  # the parity gate exists to remove.
  st_stream='kind: NetworkPolicy
metadata:
  name: probe-postgresql
---
kind: ConfigMap
metadata:
  name: probe-cm'
  st_expr='select(.kind == "NetworkPolicy") | .metadata.name'
  st_shimmed="$(printf '%s\n' "$st_stream" | PATH="$st_shim:$PATH" \
                TRUEPPM_SELFTEST_REAL_YQ="$st_real_yq" yq "$st_expr")"
  if printf '%s\n' "$st_shimmed" | grep -qx -- '---' \
     && printf '%s\n' "$st_shimmed" | grep -qx 'probe-postgresql'; then
    echo "SELF-TEST OK: the v4.35.2-style yq shim is live (separators present in the stream)."
  else
    echo "SELF-TEST FAILED: the yq shim did not emit '---' separators, so the two cases" >&2
    echo "  below would prove nothing. Shim output was:" >&2
    printf '%s\n' "$st_shimmed" | sed -n '1,6p' | sed 's/^/    /' >&2
    st_rc=1
  fi

  st_path_prefix="$st_shim"
  st_make_chart clean_oldyq
  st_probe "the shipped chart under a v4.35.2-style yq" expect-pass "$ST_CHART"

  # ...and the separators must not blind the check either: a version-independent
  # parse that stopped detecting would be the #3147 fix overshooting.
  st_make_chart missing_pg_oldyq templates/networkpolicy.yaml 's/"backup" "demo-seed"/"backup"/'
  st_probe "an allow-list violation under a v4.35.2-style yq" \
    expect-fail "$ST_CHART" "is NOT in the postgresql NetworkPolicy ingress allow-list"
  st_path_prefix=""

  # ── SELF-TEST NOT COVERED ─────────────────────────────────────────────────
  # Everything except section 5. Named rather than summarized, so nobody has to
  # infer the gap from what the cases happen to be:
  #   1  init-container order (migrate -> bootstrap)
  #   2  operator envFrom secret reaching every init container and the api container
  #   3  the shared admin-password emptyDir
  #   4  / 4b  web nginx upstream, ConfigMap mount, and the security-header defaults
  #   6  the production /admin/ block (deny all, limit_req, allow-before-deny, 404)
  #   7  the celery --concurrency pin and its knobs
  #   8  the default image tag
  #   9  connection-URL secretKeyRef bindings, both shapes
  #   10 / 11  the NOTES.txt boot-guard notice
  #   12 values.schema.json closing the root
  #   N  probe Host header · N+1 collectstatic · N+2 media claim
  #   N+3 backup destinations and MANIFEST parity · N+4 placement knobs
  # Each of those is asserted against the real chart on the real run only; none
  # has been shown to still be able to fail. They are candidates for more
  # fixtures, not gaps this self-test quietly covers.

  if [ "$st_rc" -eq 0 ]; then echo "SELF-TEST: all cases passed."; fi
  exit "$st_rc"
fi

CHART="${1:-packages/helm}"
# A representative operator secret name so we can assert it propagates everywhere
# it must. The name is arbitrary; only the wiring is asserted.
ENV_SECRET="trueppm-env-probe"

# shellcheck source-path=SCRIPTDIR source=lib/helm-render-provenance.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/helm-render-provenance.sh"

# Every assertion below reads a `helm template` render, so every failure has two
# possible causes: the chart is wrong, or the render did not read the chart
# (#3146). The message alone cannot tell them apart — it always names the chart —
# so dump the provenance that can, on the failure path only.
fail() { echo "FAIL: $*" >&2; helm_render_provenance "$CHART"; exit 1; }

# Render only the api Deployment, with an operator envFrom secret set so we can
# follow it into every container that must receive it.
DEP="$(helm template trueppm "$CHART" \
  --set image.tag=latest \
  --set "envFrom[0].secretRef.name=${ENV_SECRET}" \
  --show-only templates/api/deployment.yaml)"

# 1. Init-container ORDER: migrate must run before bootstrap(create_admin).
#    create_admin against an unmigrated database throws, so the schema must exist
#    first. This ordering is the whole point of two init containers.
i0="$(echo "$DEP" | yq '.spec.template.spec.initContainers[0].name')"
i1="$(echo "$DEP" | yq '.spec.template.spec.initContainers[1].name')"
[ "$i0" = "migrate" ]   || fail "initContainers[0] is '$i0', expected 'migrate'"
[ "$i1" = "bootstrap" ] || fail "initContainers[1] is '$i1', expected 'bootstrap'"

# 2. The operator secret (SECRET_KEY / INTEGRATION_ENCRYPTION_KEY / ALLOWED_HOSTS)
#    must reach EVERY init container AND the api container: settings.prod's
#    import-time boot guards (#1002, #775, #1550) crash-loop migrate, bootstrap
#    and collectstatic too, not just the long-running app — so a secret wired
#    only to the app would still fail the deploy at the first init step.
#
#    Enumerated over initContainers[] rather than by index (#3183): the list was
#    hardcoded to [0] and [1], so a third init container could be added with no
#    envFrom and no gate would name why the pod crash-looped.
init_count="$(echo "$DEP" | yq '.spec.template.spec.initContainers | length')"
[ "$init_count" -ge 2 ] || fail "expected at least 2 init containers, found $init_count"
env_checked=0
for i in $(seq 0 $((init_count - 1))); do
  path=".spec.template.spec.initContainers[$i]"
  name="$(echo "$DEP" | yq "${path}.name")"
  found="$(echo "$DEP" | yq "[${path}.envFrom[].secretRef.name] | contains([\"${ENV_SECRET}\"])")"
  [ "$found" = "true" ] || fail "init container '$name' does not envFrom secret '${ENV_SECRET}'"
  env_checked=$((env_checked + 1))
done
api_found="$(echo "$DEP" | yq "[.spec.template.spec.containers[0].envFrom[].secretRef.name] | contains([\"${ENV_SECRET}\"])")"
[ "$api_found" = "true" ] || fail "the api container does not envFrom secret '${ENV_SECRET}'"
env_checked=$((env_checked + 1))

# 3. The one-time admin password lands in a shared emptyDir that BOTH the
#    bootstrap init container (writer) and the api container (reader) mount at the
#    same path, so `kubectl exec <api-pod> -- cat` can retrieve it after deploy.
vol="$(echo "$DEP" | yq '[.spec.template.spec.volumes[] | select(.name == "admin-password") | has("emptyDir")] | any')"
[ "$vol" = "true" ] || fail "no 'admin-password' emptyDir volume on the api pod"

boot_mount="$(echo "$DEP" | yq '.spec.template.spec.initContainers[1].volumeMounts[] | select(.name == "admin-password") | .mountPath')"
api_mount="$(echo "$DEP" | yq '.spec.template.spec.containers[0].volumeMounts[] | select(.name == "admin-password") | .mountPath')"
[ -n "$boot_mount" ] && [ "$boot_mount" != "null" ] || fail "bootstrap init container does not mount admin-password"
[ "$boot_mount" = "$api_mount" ] || fail "admin-password mountPath differs: bootstrap=$boot_mount api=$api_mount"

# 4. The web pod's nginx reverse-proxy must target the release-scoped API Service
#    (`<fullname>-api`), NOT the docker-compose-only host `api` baked into the
#    image's nginx.conf. nginx resolves a literal upstream at startup, so a stale
#    `api` host crash-loops web with "host not found in upstream" (#2279). The chart
#    renders default.conf into a ConfigMap and mounts it over the baked file; assert
#    both the correct upstream and that the mount is actually wired.
WEB_CM="$(helm template trueppm "$CHART" --set image.tag=latest \
  --show-only templates/web/configmap.yaml)"
web_upstream="$(echo "$WEB_CM" | yq '.data["default.conf"]')"
echo "$web_upstream" | grep -q 'proxy_pass http://trueppm-api:' \
  || fail "web nginx ConfigMap does not proxy to the release-scoped 'trueppm-api' Service"
echo "$web_upstream" | grep -q 'proxy_pass http://api:' \
  && fail "web nginx ConfigMap still proxies to the compose-only host 'api' (won't resolve in k8s)"

WEB_DEP="$(helm template trueppm "$CHART" --set image.tag=latest \
  --show-only templates/web/deployment.yaml)"
cm_mount="$(echo "$WEB_DEP" | yq '.spec.template.spec.containers[0].volumeMounts[] | select(.mountPath == "/etc/nginx/conf.d/default.conf") | .subPath')"
[ "$cm_mount" = "default.conf" ] \
  || fail "web deployment does not mount the nginx ConfigMap over /etc/nginx/conf.d/default.conf"

# 4b. The SPA document must ship security response headers ON A DEFAULT INSTALL
#     (#2849). Django's XFrameOptions / SECURE_CONTENT_TYPE_NOSNIFF / CSP
#     middleware only decorate responses DJANGO produces; index.html and every
#     JS bundle are served off disk by this nginx and never reach Django. Before
#     0.4 this branch set NONE of them while both compose templates set four —
#     so Helm, the path the docs recommend for production, was the weakest.
#
#     Asserted on the DEFAULT render specifically: web.securityHeaders.* is
#     operator-tunable by design (a CSP that breaks the app is worse than none),
#     so what has to be pinned is that the shipped default is the secure one.
#     scripts/check-nginx-security-headers.sh compares this render against the
#     four sibling nginx configs; this keeps the headline invariant visible in
#     the chart's own contract test.
for hdr in \
  'add_header X-Frame-Options        "DENY" always;' \
  'add_header X-Content-Type-Options "nosniff" always;'; do
  echo "$web_upstream" | grep -qF "$hdr" \
    || fail "web nginx ConfigMap does not set '$hdr' on a default install — the SPA document carries no such protection, and Django cannot add it (#2849)"
done
echo "$web_upstream" | grep -q 'add_header Content-Security-Policy .*always;' \
  || fail "web nginx ConfigMap sets no Content-Security-Policy on a default install (#2849)"
echo "$web_upstream" | grep -q "frame-ancestors 'none'" \
  || fail "web nginx ConfigMap's default CSP has no \`frame-ancestors 'none'\` (#2849)"

#     …and the knob must actually be a knob: an operator behind their own WAF
#     has to be able to replace the CSP or drop the set entirely, or they will
#     delete the block instead of tuning it.
custom_csp="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set "web.securityHeaders.contentSecurityPolicy=default-src 'self' https://cdn.example" \
  --show-only templates/web/configmap.yaml | yq '.data["default.conf"]')"
echo "$custom_csp" | grep -q "default-src 'self' https://cdn.example" \
  || fail "web.securityHeaders.contentSecurityPolicy is not honored — the CSP is effectively hardcoded (#2849)"

off_csp="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set web.securityHeaders.enabled=false \
  --show-only templates/web/configmap.yaml | yq '.data["default.conf"]')"
echo "$off_csp" | grep -q 'add_header X-Frame-Options' \
  && fail "web.securityHeaders.enabled=false still renders headers (#2849)"

# 5. NetworkPolicy allow-lists must cover every datastore client (#2560).
#
#    The datastore policies allow ingress by `app.kubernetes.io/component`. A
#    workload that receives DATABASE_URL / REDIS_URL but is missing from the
#    corresponding list has its connections DROPPED on any policy-enforcing CNI —
#    while `helm lint`, `helm template`, kubeconform, and the helm:install drill
#    (which runs on kind's non-enforcing default CNI) all stay green. That is
#    exactly how the `backup` CronJob and `demo-seed` Job came to be omitted.
#
#    This is the cheap static half of the guarantee; scripts/helm-netpol-drill.sh
#    proves enforcement for real on a Calico cluster. This one runs in seconds with
#    no cluster, so a newly-added datastore client fails in the lint stage.
#
#    Rendered with backup + demo enabled because both are off by default and both
#    open PostgreSQL — a default-values render cannot see them at all.
# backup.persistence is set alongside backup.enabled at every render site in this
# script: the chart refuses to render a backup with no destination (#3185), so
# `--set backup.enabled=true` alone no longer produces a CronJob to check.
NP_ALL="$(helm template trueppm "$CHART" \
  --set image.tag=latest \
  --set backup.enabled=true \
  --set backup.persistence.enabled=true \
  --set demo.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=structurecheckschedule \
  --set demo.shareToken.board=structurecheckboard)"

np_split="$(mktemp -d)"
trap 'rm -rf "$np_split"' EXIT
# shellcheck disable=SC2016  # $index is a yq expression variable, not a shell one
echo "$NP_ALL" | (cd "$np_split" && yq -s '"doc_" + $index' >/dev/null)

# The rendered allow-lists, ONE COMPONENT PER LINE.
#
# Do not join these into a comma string and substring-match. That form inherits
# its correctness from one yq build's separator style: `select()` over a
# multi-document stream emits a BLANK LINE per non-matching document on the
# pinned v4.44.3, but a `---` DOCUMENT SEPARATOR on older builds (alpine ships
# v4.35.2). `---` is not whitespace, so a `tr -d '[:space:]'` sized for the
# blank-line form leaves the separator inside the joined list, and every
# substring test then fails against `,---api,celery-worker,…,demo-seed---,`
# — naming a chart file to go edit for a NetworkPolicy regression that is not
# there (#3147). The failure is confident, specific, and wrong, which makes it
# indistinguishable from a real one.
#
# Emitting one component per line and matching WHOLE LINES states the dependency
# instead of inheriting it: both separator styles are dropped explicitly below,
# so the check reads the same under any yq.
np_components() {
  echo "$NP_ALL" \
    | yq "select(.kind == \"NetworkPolicy\" and (.metadata.name | test(\"$1\$\"))) | [.spec.ingress[].from[].podSelector.matchLabels[\"app.kubernetes.io/component\"]] | map(select(. != null)) | .[]" \
    | awk '{ gsub(/[[:space:]]/, "", $0); if ($0 != "" && $0 != "---") print }'
}

# Whole-line membership. awk exits 0 either way, so this is safe under `set -e`
# where a bare `grep -x` with no match would abort the script.
np_allows() { # <allow-list> <component>
  printf '%s\n' "$1" | awk -v want="$2" '$0 == want { hit = 1 } END { exit hit ? 0 : 1 }'
}

# Human-readable rendering for failure messages only — never for matching.
np_render() { printf '%s\n' "$1" | awk 'NR > 1 { printf ", " } { printf "%s", $0 } END { print "" }'; }

pg_allowed="$(np_components postgresql)"
vk_allowed="$(np_components valkey)"
[ -n "$pg_allowed" ] || fail "could not read the postgresql NetworkPolicy ingress allow-list"
[ -n "$vk_allowed" ] || fail "could not read the valkey NetworkPolicy ingress allow-list"

np_checked=0
for f in "$np_split"/doc_*.yml; do
  kind="$(yq '.kind' "$f")"
  case "$kind" in Deployment|StatefulSet|Job|CronJob|Pod) ;; *) continue ;; esac

  # Datastore pods are the policy TARGETS, not clients — they carry no chart
  # component label and must not be required to appear in their own allow-list.
  ds_name="$(yq '[.spec.template.metadata.labels["app.kubernetes.io/name"], .metadata.labels["app.kubernetes.io/name"]] | map(select(. != null)) | .[0] // ""' "$f")"
  case "$ds_name" in postgresql|valkey) continue ;; esac

  wl_name="$(yq '.metadata.name' "$f")"
  # CronJob nests its pod template one level deeper than Deployment/Job.
  comp="$(yq '[.spec.jobTemplate.spec.template.metadata.labels["app.kubernetes.io/component"], .spec.template.metadata.labels["app.kubernetes.io/component"], .metadata.labels["app.kubernetes.io/component"]] | map(select(. != null)) | .[0] // ""' "$f")"
  urls="$(yq '[(.spec.jobTemplate.spec.template.spec, .spec.template.spec, .spec) | select(. != null) | (.containers // []) + (.initContainers // []) | .[].env // [] | .[].name] | map(select(. == "DATABASE_URL" or . == "REDIS_URL")) | unique | join(",")' "$f")"

  case ",$urls," in
    *,DATABASE_URL,*)
      [ -n "$comp" ] || fail "$kind/$wl_name receives DATABASE_URL but carries no app.kubernetes.io/component label, so no NetworkPolicy rule can ever match it"
      if np_allows "$pg_allowed" "$comp"; then
        np_checked=$((np_checked + 1))
      else
        fail "$kind/$wl_name (component '$comp') receives DATABASE_URL but is NOT in the postgresql NetworkPolicy ingress allow-list ($(np_render "$pg_allowed")) — its connections are dropped on an enforcing CNI. Add it in templates/networkpolicy.yaml."
      fi
      ;;
  esac
  case ",$urls," in
    *,REDIS_URL,*)
      [ -n "$comp" ] || fail "$kind/$wl_name receives REDIS_URL but carries no app.kubernetes.io/component label"
      if np_allows "$vk_allowed" "$comp"; then
        np_checked=$((np_checked + 1))
      else
        fail "$kind/$wl_name (component '$comp') receives REDIS_URL but is NOT in the valkey NetworkPolicy ingress allow-list ($(np_render "$vk_allowed")) — its connections are dropped on an enforcing CNI. Add it in templates/networkpolicy.yaml."
      fi
      ;;
  esac
done
# A zero here would mean the loop matched nothing and the check silently proved
# nothing — the same false-assurance failure mode this check exists to close.
[ "$np_checked" -gt 0 ] || fail "NetworkPolicy client check inspected no workloads — the render or the yq paths changed"

# 6. The PRODUCTION nginx render must not publish Django admin (#2569).
#
#    This assertion is the one that was missing. CI asserted `/admin/` was closed
#    only on the DEMO render, so the production block sat unrestricted — an
#    unthrottled, internet-reachable password-guessing surface against the
#    superuser the `bootstrap` initContainer creates on every deploy — while every
#    gate stayed green. Django admin is a plain Django view, so no DRF throttle
#    scope covers it and there is no lockout backend; nginx is the only control.
#    Assert the production render here so the same gap cannot reopen.
prod_admin_block() {
  helm template trueppm "$CHART" --set image.tag=latest "$@" \
    --show-only templates/web/configmap.yaml \
    | yq '.data["default.conf"]' \
    | awk '/location \/admin\/ \{/{f=1} f{print} f&&/^[[:space:]]*\}[[:space:]]*$/{exit}'
}

# 6a. Default values (empty allowlist) must fail CLOSED with a bare `deny all`.
admin_default="$(prod_admin_block)"
[ -n "$admin_default" ] || fail "could not extract the /admin/ block from the production web ConfigMap"
echo "$admin_default" | grep -qE '^[[:space:]]*deny all;' \
  || fail "production nginx /admin/ block has no 'deny all' on default values — a default install publishes Django admin to the internet (#2569)"
echo "$admin_default" | grep -qE '^[[:space:]]*allow ' \
  && fail "production nginx /admin/ renders an 'allow' directive on DEFAULT values — the allowlist must be empty (deny-by-default) unless the operator sets web.adminAccess.allowCIDRs"

# 6b. The admin surface must be rate-limited, and the zone it references must
#     actually be declared — nginx refuses to start on an unknown limit_req zone,
#     so a half-rendered pair is a crash-loop, not a soft failure.
echo "$admin_default" | grep -q 'limit_req zone=admin_login' \
  || fail "production nginx /admin/ block has no 'limit_req' — admin login is unthrottled (#2569)"
helm template trueppm "$CHART" --set image.tag=latest --show-only templates/web/configmap.yaml \
  | yq '.data["default.conf"]' | grep -q 'limit_req_zone .* zone=admin_login:' \
  || fail "the admin_login limit_req zone is referenced but never declared — nginx will refuse to start"

# 6c. A supplied CIDR must render an `allow` BEFORE the `deny all`. nginx takes
#     the first matching allow/deny rule, so an allow emitted after `deny all` is
#     dead config and the operator's allowlist would silently do nothing.
admin_cidr="$(prod_admin_block --set 'web.adminAccess.allowCIDRs={10.42.0.0/16}')"
echo "$admin_cidr" | grep -qE '^[[:space:]]*allow 10\.42\.0\.0/16;' \
  || fail "web.adminAccess.allowCIDRs did not render a matching 'allow' directive"
allow_ln="$(echo "$admin_cidr" | grep -nE '^[[:space:]]*allow ' | head -1 | cut -d: -f1)"
deny_ln="$(echo "$admin_cidr" | grep -nE '^[[:space:]]*deny all;' | head -1 | cut -d: -f1)"
[ -n "$allow_ln" ] && [ -n "$deny_ln" ] && [ "$allow_ln" -lt "$deny_ln" ] \
  || fail "'allow' (line $allow_ln) must precede 'deny all' (line $deny_ln) — nginx honors the first match, so this allowlist is inert"

# 6d. adminAccess.enabled=false removes the surface entirely.
admin_off="$(prod_admin_block --set web.adminAccess.enabled=false)"
echo "$admin_off" | grep -q 'return 404' \
  || fail "web.adminAccess.enabled=false must render 'return 404' for /admin/"

# 7. The Celery worker must run with a PINNED --concurrency (#2571).
#
#    Celery prefork defaults to cpu_count(), which inside a container reads the
#    NODE's core count and ignores the cgroup CPU limit — a 32-core node forks 32
#    children at ~150-250 MB RSS each against a 2Gi limit, so the worker OOMKills
#    at zero load and takes CPM recalculation, imports, email, and Beat with it.
#    The chart previously hardcoded the command with no flag AND no values knob,
#    so a values-only operator could not fix it at all.
worker_cmd() {
  helm template trueppm "$CHART" --set image.tag=latest "$@" \
    --show-only templates/celery-worker/deployment.yaml \
    | yq '.spec.template.spec.containers[0].command | join(" ")'
}

wc_default="$(worker_cmd)"
echo "$wc_default" | grep -qE -- '--concurrency=[0-9]+' \
  || fail "celery worker command has no explicit --concurrency — Celery falls back to cpu_count() and OOMKills the background tier on any multi-core node (#2571)"

# The default must be a small pinned value, NOT the node's core count.
wc_n="$(echo "$wc_default" | sed -nE 's/.*--concurrency=([0-9]+).*/\1/p')"
[ "$wc_n" -ge 1 ] || fail "default --concurrency is '$wc_n' — must be >= 1"

# The knob must actually be wired, not just present with a default.
worker_cmd --set celeryWorker.concurrency=4 | grep -q -- '--concurrency=4' \
  || fail "celeryWorker.concurrency=4 did not render '--concurrency=4' — the values knob is not wired"

# extraArgs must append verbatim AND in the declared order.
wc_extra="$(worker_cmd --set 'celeryWorker.extraArgs={--queues=exports,--prefetch-multiplier=1}')"
echo "$wc_extra" | grep -q -- '--queues=exports' \
  || fail "celeryWorker.extraArgs did not render into the worker command"
case "$wc_extra" in
  *"--queues=exports"*"--prefetch-multiplier=1"*) ;;
  *) fail "celeryWorker.extraArgs rendered out of order: $wc_extra" ;;
esac

# concurrency=0 must be REJECTED, not passed through: Celery reads
# `--concurrency=0` as "use the default", i.e. cpu_count() — the exact OOMKill
# this knob exists to prevent. A silent 0 would reopen #2571 through the very
# setting that fixed it, so the render has to fail.
if worker_cmd --set celeryWorker.concurrency=0 >/dev/null 2>&1; then
  fail "celeryWorker.concurrency=0 rendered successfully — it must fail the render, because Celery treats --concurrency=0 as cpu_count() (#2571)"
fi

# 8. The DEFAULT render must ask for an image tag that the release pipeline
#    actually publishes to the registry the chart points at (#2811).
#
#    Every other assertion in this file — and the helm:template job that runs it —
#    renders with `--set image.tag=latest`, so nothing exercised the default path
#    at all. That is how the chart shipped pinned to a bare `{{ .Chart.AppVersion }}`
#    while api:publish / web:publish push only `:${CI_COMMIT_TAG}` (v-prefixed) and
#    `:latest` to the GitLab registry: a stock `helm install` resolved
#    `.../api:0.4.0`, a tag that had never existed and that CI has no step to
#    create. The operator gets ImagePullBackOff on the `migrate` initContainer,
#    with no application log to diagnose from.
#
#    The bare-version tag is not merely absent, it is unsafe to add: the registry
#    cleanup policy keeps `^v.*$|^latest$` (#2803), so a bare `0.4.0` would be
#    reaped by the daily sweep. v-prefixed is the only durable form.
#
#    Rendered with demo enabled so templates/demo-seed-job.yaml — which carries two
#    more copies of the same reference and is off by default — is covered too.
APP_VERSION="$(yq '.appVersion' "$CHART/Chart.yaml")"
case "$APP_VERSION" in
  v*) fail "Chart.yaml appVersion is '$APP_VERSION' — it must be the bare semver ('0.4.0'); the 'v' prefix is added by trueppm.imageTag, so a v-prefixed appVersion renders 'vv0.4.0'" ;;
esac
EXPECTED_TAG="v${APP_VERSION}"

# The two first-party repositories. Only these are checked: the bundled
# postgresql / valkey subcharts and the backup / helm-test images are upstream
# third-party images on their own independent tag schemes.
API_REPO="$(yq '.image.repository' "$CHART/values.yaml")"
WEB_REPO="$(yq '.image.webRepository' "$CHART/values.yaml")"

# Collect every container/initContainer image from a DEFAULT-values render. No
# --set image.tag here — that is the entire point of this check.
default_images() {
  helm template trueppm "$CHART" "$@" \
    | yq ea '[.. | select(has("image") and has("name")) | .image] | .[]' \
    | grep -v '^null$' | sort -u
}

FIRST_PARTY_IMAGES="$(default_images \
  --set demo.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=structurecheckschedule \
  --set demo.shareToken.board=structurecheckboard \
  | grep -E "^(${API_REPO}|${WEB_REPO}):" || true)"

[ -n "$FIRST_PARTY_IMAGES" ] \
  || fail "default render produced no image reference for '$API_REPO' or '$WEB_REPO' — the render or the repository values changed, so this check proved nothing"

tag_checked=0
while IFS= read -r img; do
  [ -n "$img" ] || continue
  img_tag="${img##*:}"
  [ "$img_tag" = "$EXPECTED_TAG" ] || fail "default render asks for '$img' — expected tag '$EXPECTED_TAG'. The GitLab registry only ever receives v-prefixed release tags and ':latest', so this reference can never be pulled (#2811). Fix trueppm.imageTag in templates/_helpers.tpl."
  tag_checked=$((tag_checked + 1))
done <<EOF
$FIRST_PARTY_IMAGES
EOF

# An explicit operator tag must still win outright — no 'v' prepended to it.
# Existing installs pin image.tag, and silently rewriting their tag would break
# every one of them.
override_images="$(default_images --set image.tag=1.2.3-rc1 \
  | grep -E "^(${API_REPO}|${WEB_REPO}):" || true)"
echo "$override_images" | grep -q ":1.2.3-rc1\$" \
  || fail "an explicit image.tag override did not render verbatim — trueppm.imageTag must pass .Values.image.tag straight through"
echo "$override_images" | grep -q ":v1.2.3-rc1\$" \
  && fail "an explicit image.tag override was rewritten with a 'v' prefix — the prefix belongs to the appVersion fallback only"

# 9. Connection URLs are ALWAYS injected by reference, never rendered in
#    plaintext into a workload — on BOTH supported shapes (#2810).
#
#    The chart's headline security claim is "no plaintext credentials in any
#    Deployment", and on the managed-DB path it was false: `trueppm.appEnv`
#    included the operator's `env.DATABASE_URL` verbatim AND the secretKeyRef, so
#    the database password rendered into every api/worker/beat/init container.
#    Kubernetes keeps the last duplicate, so the plaintext copy did not even take
#    effect — it was pure leakage into `kubectl get deploy -o yaml`, into GitOps
#    repos, and into every cluster-state backup. The documented alternative (a
#    secretKeyRef map) was worse: it stringified into the connection Secret as
#    `map[secretKeyRef:map[…]]` and crash-looped the app on an unparseable URL.
#
#    Nothing caught either one, because both render valid YAML that kubeconform
#    accepts. So assert the property directly, on a rendered manifest, for both
#    shapes.
PG_SENTINEL="s3ntinelpgpassword"
RD_SENTINEL="s3ntinelrdpassword"

# The managed-datastore posture, with the URLs given as plaintext STRINGS — the
# shape the README's production quickstart tells operators to use. backup is
# enabled so the CronJob (a separate DATABASE_URL consumer) is in the render.
url_render() {
  helm template trueppm "$CHART" -f "$CHART/values-prod.yaml" \
    --set image.tag=latest --set backup.enabled=true \
    --set backup.persistence.enabled=true "$@"
}
STRING_RENDER="$(url_render \
  --set "env.DATABASE_URL=postgres://u:${PG_SENTINEL}@db.example.com:5432/trueppm?sslmode=require" \
  --set "env.REDIS_URL=redis://:${RD_SENTINEL}@cache.example.com:6379")"

url_split="$(mktemp -d)"
trap 'rm -rf "$np_split" "$url_split"' EXIT
# shellcheck disable=SC2016  # $index is a yq expression variable, not a shell one
echo "$STRING_RENDER" | (cd "$url_split" && yq -s '"doc_" + $index' >/dev/null)

# 9a. The credential appears in the chart-owned Secret and NOWHERE else. Scoped by
#     kind rather than by grepping the whole render, because the Secret is the one
#     object that is SUPPOSED to hold it.
#     Written as `if grep; then fail; fi` rather than `grep && fail`: under
#     `set -e` the latter leaves the loop's exit status equal to the LAST grep's,
#     so a clean render (every grep failing to match, which is the passing case)
#     would abort the script instead of falling through to the checks below.
url_secret_hits=0
for f in "$url_split"/doc_*.yml; do
  kind="$(yq '.kind' "$f")"
  name="$(yq '.metadata.name' "$f")"
  if [ "$kind" = "Secret" ]; then
    if grep -q "$PG_SENTINEL" "$f"; then url_secret_hits=$((url_secret_hits + 1)); fi
    continue
  fi
  if grep -q "$PG_SENTINEL" "$f"; then
    fail "$kind/$name renders the DATABASE_URL password in plaintext — the chart guarantees no plaintext credential in any workload manifest (#2810)"
  fi
  if grep -q "$RD_SENTINEL" "$f"; then
    fail "$kind/$name renders the REDIS_URL password in plaintext — the chart guarantees no plaintext credential in any workload manifest (#2810)"
  fi
done
[ "$url_secret_hits" -eq 1 ] \
  || fail "the operator's DATABASE_URL was found in $url_secret_hits Secret(s), expected exactly 1 (the chart-owned connection Secret) — it must be stored once and injected by reference"

# 9b. Structural form of the same invariant, over every workload in a render:
#     a DATABASE_URL / REDIS_URL env entry must use valueFrom, never a literal
#     `value:`, and must appear EXACTLY ONCE per container. A duplicate is how the
#     leak hid in plain sight — the effective value looked correct because
#     Kubernetes keeps the last entry, so the wrong copy was invisible at runtime
#     while sitting in the manifest.
url_env_checked=0
assert_url_env_bindings() {
  local shape="$1" dir="$2" f kind name containers literal var n
  for f in "$dir"/doc_*.yml; do
    kind="$(yq '.kind' "$f")"
    case "$kind" in Deployment|StatefulSet|Job|CronJob|Pod) ;; *) continue ;; esac
    name="$(yq '.metadata.name' "$f")"
    # CronJob nests its pod template one level deeper than Deployment/Job.
    containers='[(.spec.jobTemplate.spec.template.spec, .spec.template.spec, .spec) | select(. != null) | (.containers // []) + (.initContainers // []) | .[]]'

    literal="$(yq "${containers} | map(.env // [] | map(select((.name == \"DATABASE_URL\" or .name == \"REDIS_URL\") and has(\"value\"))) | .[].name) | flatten | join(\",\")" "$f")"
    [ -z "$literal" ] \
      || fail "[$shape] $kind/$name has a literal \`value:\` for $literal — connection URLs must always be injected via valueFrom.secretKeyRef (#2810)"

    for var in DATABASE_URL REDIS_URL; do
      n="$(yq "${containers} | map(.env // [] | map(select(.name == \"$var\")) | length) | max // 0" "$f")"
      [ "$n" -le 1 ] \
        || fail "[$shape] $kind/$name declares $var $n times in one container — a duplicate env key silently masks whichever copy is wrong (#2810)"
      if [ "$n" -eq 1 ]; then url_env_checked=$((url_env_checked + 1)); fi
    done
  done
  return 0
}
assert_url_env_bindings "string form" "$url_split"

# 9c. The documented external-Secret form: `env.DATABASE_URL` as a secretKeyRef
#     MAP must pass through to the operator's own Secret, and the chart must not
#     write a second copy of a credential it was only asked to point at.
MAP_RENDER="$(url_render \
  --set env.DATABASE_URL.secretKeyRef.name=op-db \
  --set env.DATABASE_URL.secretKeyRef.key=url \
  --set env.REDIS_URL.secretKeyRef.name=op-cache \
  --set env.REDIS_URL.secretKeyRef.key=cache-url)"

# The map form gets the same structural sweep: it is the shape most likely to end
# up double-emitted, because the operator's own secretKeyRef looks correct on its
# own and the duplicate is only visible next to the chart's.
map_split="$(mktemp -d)"
trap 'rm -rf "$np_split" "$url_split" "$map_split"' EXIT
# shellcheck disable=SC2016  # $index is a yq expression variable, not a shell one
echo "$MAP_RENDER" | (cd "$map_split" && yq -s '"doc_" + $index' >/dev/null)
assert_url_env_bindings "secretKeyRef map form" "$map_split"

[ "$url_env_checked" -gt 0 ] \
  || fail "the connection-URL env check inspected no workloads — the render or the yq paths changed"

# The failure this replaces rendered a stringified Go map into the Secret. It is
# valid YAML, so only an explicit check catches it.
if echo "$MAP_RENDER" | grep -q 'map\[secretKeyRef'; then
  fail "the secretKeyRef map form stringified into the manifest as map[secretKeyRef:…] — the documented external-Secret form is broken (#2810)"
fi

# yq exits non-zero on unparseable YAML: proves the whole map-form render is a
# manifest a cluster would accept, not just that helm produced output.
echo "$MAP_RENDER" | yq -e 'select(.kind != null) | .kind' >/dev/null \
  || fail "the secretKeyRef map form produced an unparseable manifest (#2810)"

map_api_ref() {
  echo "$MAP_RENDER" | yq "select(.kind == \"Deployment\" and .metadata.name == \"trueppm-api\") | .spec.template.spec.containers[0].env[] | select(.name == \"$1\") | .valueFrom.secretKeyRef | .name + \"/\" + .key"
}
[ "$(map_api_ref DATABASE_URL)" = "op-db/url" ] \
  || fail "api does not read DATABASE_URL from the operator's Secret op-db/url (got '$(map_api_ref DATABASE_URL)') (#2810)"
[ "$(map_api_ref REDIS_URL)" = "op-cache/cache-url" ] \
  || fail "api does not read REDIS_URL from the operator's Secret op-cache/cache-url (got '$(map_api_ref REDIS_URL)') (#2810)"

# The backup CronJob is the workload nobody watches until a restore, so assert it
# resolves identically rather than trusting it to have been updated too.
map_backup_ref="$(echo "$MAP_RENDER" | yq 'select(.kind == "CronJob") | [.spec.jobTemplate.spec.template.spec.initContainers // [], .spec.jobTemplate.spec.template.spec.containers] | flatten | .[].env[] | select(.name == "DATABASE_URL") | .valueFrom.secretKeyRef | .name + "/" + .key' | sort -u)"
[ "$map_backup_ref" = "op-db/url" ] \
  || fail "the backup CronJob does not read DATABASE_URL from the operator's Secret op-db/url (got '$map_backup_ref') (#2810)"

map_secret_keys="$(echo "$MAP_RENDER" | yq 'select(.kind == "Secret" and (.metadata.name | test("-trueppm-connection$"))) | .stringData | keys | join(",")')"
case ",$map_secret_keys," in
  *,DATABASE_URL,*|*,REDIS_URL,*)
    fail "the chart-owned connection Secret still carries a URL the operator supplied by reference (keys: $map_secret_keys) — it must not hold a second copy (#2810)" ;;
esac

# 9d. The contradictory config must FAIL the render rather than be ignored.
#     With the bundled datastore on, the chart builds the URL from its own
#     generated password; an operator's env.DATABASE_URL cannot win and used to be
#     dropped in silence (while still leaking into the manifest).
if helm template trueppm "$CHART" --set image.tag=latest \
    --set 'env.DATABASE_URL=postgres://u:p@h:5432/d' >/dev/null 2>&1; then
  fail "env.DATABASE_URL alongside the bundled postgresql rendered successfully — it must fail, because the chart-built URL always wins and the operator's value would be silently ignored (#2810)"
fi

# 10. NOTES.txt must warn when NO app-env source is configured (#2812).
#    settings.prod validates SECRET_KEY, ALLOWED_HOSTS, INTEGRATION_ENCRYPTION_KEY
#    and the attachment-storage choice at import time, so an install that supplies
#    none of them crash-loops in the migrate init container — and every documented
#    minimal install was exactly that shape. The chart cannot fail the render on it
#    (an `envFrom` Secret's keys are invisible at render time), so the post-install
#    notes are the only place the operator is told. Assert BOTH directions: the
#    warning fires on a bare install and stays silent once a source is configured,
#    because a notice that always prints is a notice nobody reads.
#    `helm install --dry-run` is the natural way to exercise NOTES.txt and does not
#    work here: even with --dry-run=client it needs a reachable cluster, and this
#    job has none. So the notice lives in the trueppm.bootGuardNotice helper and is
#    rendered through a throwaway probe template copied into a scratch chart — the
#    shipped logic, reachable offline. NOTES.txt itself is asserted to include it.
grep -q 'trueppm.bootGuardNotice' "$CHART/templates/NOTES.txt" \
  || fail "NOTES.txt does not include the trueppm.bootGuardNotice helper — the boot-guard warning below is rendered but never shown to the operator (#2812)"

PROBE_DIR="$(mktemp -d)"
# A second `trap ... EXIT` REPLACES the first rather than adding to it, so this one
# has to clean up section 5's temp dir too or that directory leaks on every run.
trap 'rm -rf "$np_split" "$url_split" "$map_split" "$PROBE_DIR"' EXIT
cp -R "$CHART" "$PROBE_DIR/chart"
cat > "$PROBE_DIR/chart/templates/zz-boot-guard-probe.yaml" <<'PROBE'
apiVersion: v1
kind: ConfigMap
metadata:
  name: boot-guard-notice-probe
data:
  notice: |
{{ include "trueppm.bootGuardNotice" . | indent 4 }}
PROBE

notes() {
  helm template trueppm "$PROBE_DIR/chart" --set image.tag=latest "$@" \
    --show-only templates/zz-boot-guard-probe.yaml 2>&1
}

bare_notes="$(notes)"
for key in SECRET_KEY ALLOWED_HOSTS INTEGRATION_ENCRYPTION_KEY TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE; do
  echo "$bare_notes" | grep -q "$key" \
    || fail "NOTES.txt on a bare install does not name '$key' — the operator is not told why the pod will crash-loop (#2812)"
done
echo "$bare_notes" | grep -q "WILL NOT START" \
  || fail "NOTES.txt on a bare install does not warn that the release will not start (#2812)"

# Configured via envFrom (the README quickstart) — the warning must go away.
if notes --set "envFrom[0].secretRef.name=${ENV_SECRET}" | grep -q "WILL NOT START"; then
  fail "NOTES.txt still warns about missing secrets when envFrom is configured (#2812)"
fi

# Configured via env.* (the values-file idiom) — same.
if notes --set env.SECRET_KEY=x --set env.ALLOWED_HOSTS=h \
     --set env.INTEGRATION_ENCRYPTION_KEY=k \
     --set env.TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true | grep -q "WILL NOT START"; then
  fail "NOTES.txt still warns about missing secrets when every key is set under env.* (#2812)"
fi

# 10b. The port-forward path must name ALLOWED_HOSTS, and every prescribed
#      ALLOWED_HOSTS must cover it (#3238).
#
#      With ingress.enabled=false — the chart DEFAULT — NOTES.txt's port-forward
#      command is the only route into the app. The web tier's nginx proxies /api/
#      with `Host $host`, so Django sees `Host: localhost`. Omitting it fails in
#      the most misleading way available: nginx serves the SPA and its bundles off
#      disk without ever touching Django, so the app RENDERS and then every
#      /api/v1/... call answers 400, with nothing naming the cause.
#
#      Probed through the same offline mechanism as the boot-guard notice above:
#      the text lives in trueppm.portForwardHostNotice, because
#      `helm install --dry-run` needs a reachable cluster even with
#      --dry-run=client and this job has none.
grep -q 'trueppm.portForwardHostNotice' "$CHART/templates/NOTES.txt" \
  || fail "NOTES.txt does not include the trueppm.portForwardHostNotice helper — it prints a port-forward command with no word that ALLOWED_HOSTS must contain localhost (#3238)"

cat > "$PROBE_DIR/chart/templates/zz-portfwd-notice-probe.yaml" <<'PFPROBE'
apiVersion: v1
kind: ConfigMap
metadata:
  name: port-forward-notice-probe
data:
  notice: |
{{ include "trueppm.portForwardHostNotice" . | indent 4 }}
PFPROBE

# Both topologies reach the API under `localhost`: through the web tier's nginx
# proxy, and directly when web.enabled=false. The notice must fire in each.
for pf_web in true false; do
  pf_notice="$(helm template trueppm "$PROBE_DIR/chart" --set image.tag=latest \
    --set "web.enabled=$pf_web" --show-only templates/zz-portfwd-notice-probe.yaml 2>&1)"
  echo "$pf_notice" | grep -q "ALLOWED_HOSTS" \
    || fail "the port-forward notice does not name ALLOWED_HOSTS with web.enabled=$pf_web (#3238)"
  echo "$pf_notice" | grep -q "localhost" \
    || fail "the port-forward notice does not name 'localhost' with web.enabled=$pf_web — that is the Host Django actually receives (#3238)"
done

# ...and the docs must prescribe an ALLOWED_HOSTS that contains it. Asserted as an
# AGREEMENT between chart and docs rather than a string match on either alone,
# because the defect was exactly that they disagreed: NOTES.txt told the operator
# to port-forward while the README and the deployment guide prescribed a list
# without localhost.
#
# The docs path is anchored on THIS SCRIPT's location, not on $CHART: the
# self-test passes a fixture chart copied into a temp dir, from which no docs
# tree is reachable. Anchoring on $CHART made the assertion count 1 source
# instead of 2 and fail the self-test — which is the counter working.
pf_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pf_docs_checked=0
for src in "$CHART/README.md" \
           "$pf_repo_root/packages/website/src/content/docs/administration/deployment.md"; do
  [ -f "$src" ] || continue
  pf_docs_checked=$((pf_docs_checked + 1))
  while IFS= read -r line; do
    case "$line" in
      *localhost*) : ;;
      *) fail "$(basename "$src") prescribes '$line' — no localhost, while NOTES.txt tells operators to port-forward. The SPA loads and every /api/ call 400s (#3238)" ;;
    esac
  done < <(grep -o 'ALLOWED_HOSTS=[A-Za-z0-9.,_-]*' "$src" || true)
done
[ "$pf_docs_checked" -eq 2 ] \
  || fail "expected to check 2 ALLOWED_HOSTS doc sources, checked $pf_docs_checked — a path moved and this assertion silently stopped covering it (#3238)"

# 11. The quiet branch must NAME the envFrom sources it is trusting (#2879).
#    `len(envFrom) > 0` is a weak signal: `envFrom` is a list, so a values file that
#    sets it REPLACES the operator's entry instead of appending. A release whose only
#    source became an unrelated Secret still passes the length test and still
#    crash-loops. The chart cannot read a Secret's keys at render time, so the honest
#    check is to print the list rather than only measure it.
trusted_notes="$(notes --set "envFrom[0].secretRef.name=${ENV_SECRET}")"
echo "$trusted_notes" | grep -q "Secret/${ENV_SECRET}" \
  || fail "NOTES.txt does not name the envFrom sources it trusts for the boot-guard keys — an operator whose list was replaced by another values file has nothing to notice (#2879)"
echo "$trusted_notes" | grep -qi 'replaces it wholesale' \
  || fail "NOTES.txt does not say envFrom is replace-not-merge — that is the mechanism by which the list silently loses the app-env Secret (#2879)"

# 12. values.schema.json must exist and REJECT an unknown top-level key (#2879).
#    Helm accepts a values key no template reads, so a wrong or invented key
#    ('extraEnv', a typo) changes nothing on the pod while the operator believes it
#    was applied — the #2860 mechanism, which recurs for every next wrong key. The
#    root schema being closed is the only thing that turns that silence into an error.
[ -f "$CHART/values.schema.json" ] \
  || fail "$CHART/values.schema.json is missing — an unknown values key is accepted silently and changes nothing on the pod (#2879)"
if helm template trueppm "$CHART" --set image.tag=latest --set 'extraEnv[0].name=X' >/dev/null 2>&1; then
  fail "an unknown top-level values key ('extraEnv') rendered successfully — values.schema.json must close the root with additionalProperties:false (#2879)"
fi
# ...and the keys the chart DOES read must still validate, in every shipped overlay.
for overlay in "" "$CHART/values-dev.yaml" "$CHART/values-prod.yaml"; do
  if [ -n "$overlay" ]; then set -- -f "$overlay"; else set --; fi
  helm lint "$CHART" "$@" >/dev/null 2>&1 \
    || fail "helm lint failed for overlay '${overlay:-<defaults>}' — values.schema.json rejects a value the chart ships (#2879)"
done

# N. Probe Host header (#3183, #3237). kubelet dials a probe by POD IP, so with
#    no Host header Django validates `<podIP>:8000` against ALLOWED_HOSTS in
#    get_host() — before any view, and out of reach of SECURE_REDIRECT_EXEMPT —
#    and answers 400 DisallowedHost. The pod never turns Ready and the Ingress
#    serves 503, with nothing in the failure naming ALLOWED_HOSTS.
#
#    Both branches are asserted, because until #3237 this block tested only ONE
#    and read the wrong values key to do it: it rendered with DEFAULTS —
#    ingress.enabled is false by default — and then asserted the header equalled
#    values.yaml's ingress.hosts[0].host. That passed for the wrong reason and
#    pinned the defect in place: the helper read ingress.hosts without testing
#    ingress.enabled, so every no-Ingress install got the placeholder
#    `trueppm.example.com` stamped onto both probes and never turned Ready.
probe_host() { # <release> [extra helm args...]
  local rel="$1"; shift
  helm template "$rel" "$CHART" --set image.tag=latest "$@" \
    --show-only templates/api/deployment.yaml \
    | yq '.spec.template.spec.containers[0].readinessProbe.httpGet.httpHeaders[] | select(.name == "Host") | .value'
}

# N.a — no Ingress (the chart DEFAULT). Must be the api Service DNS name, which
#       is what templates/tests/api-connection.yaml curls and what the README
#       tells operators to put in ALLOWED_HOSTS. Must NOT be an ingress host.
noing_host="$(probe_host trueppm)"
default_ing="$(yq '.ingress.hosts[0].host' "$CHART/values.yaml")"
[ -n "$noing_host" ] && [ "$noing_host" != "null" ] \
  || fail "readinessProbe carries no Host header with ingress.enabled=false — kubelet will send Host: <podIP> and Django will 400 it against ALLOWED_HOSTS (#3237)"
[ "$noing_host" != "$default_ing" ] \
  || fail "probe Host header is the ingress placeholder '$default_ing' while ingress.enabled is false — no ALLOWED_HOSTS contains it, so both probes 400 and the pod never turns Ready (#3237)"
[ "$noing_host" = "trueppm-api" ] \
  || fail "probe Host header with no Ingress is '$noing_host', expected the api Service name 'trueppm-api' — it must match what helm test curls and what ALLOWED_HOSTS is documented to hold (#3237)"
# The Service name must track the release, or a non-'trueppm' release names a Service that does not exist.
[ "$(probe_host ppm)" = "ppm-trueppm-api" ] \
  || fail "probe Host header does not follow trueppm.fullname for release 'ppm' (got '$(probe_host ppm)') (#3237)"
# ...and it must be the name the helm test Job actually resolves.
grep -q '{{ include "trueppm.fullname" . }}-api' "$CHART/templates/tests/api-connection.yaml" \
  || fail "helm test no longer curls '<fullname>-api' — the no-Ingress probe Host fallback was derived from it and the two have drifted (#3237)"

# N.b — Ingress enabled. Must be the first ingress host, the name the operator
#       already had to put in ALLOWED_HOSTS to serve traffic at all (#3183).
ing_host="$(probe_host trueppm --set ingress.enabled=true)"
[ "$ing_host" = "$default_ing" ] \
  || fail "with ingress.enabled=true the probe Host header '$ing_host' does not resolve to the first ingress host '$default_ing' (#3183)"

# N.c — both probes must agree, on the default (no-Ingress) path.
live_host="$(echo "$DEP" | yq '.spec.template.spec.containers[0].livenessProbe.httpGet.httpHeaders[] | select(.name == "Host") | .value')"
[ "$live_host" = "$noing_host" ] \
  || fail "livenessProbe Host header is '$live_host', expected '$noing_host' — the two probes must agree (#3183)"

# N.d — the explicit override must win over BOTH branches, so an operator can
#       always name the host themselves.
[ "$(probe_host trueppm --set probes.api.hostHeader=probe.example.test)" = "probe.example.test" ] \
  || fail "probes.api.hostHeader override did not take effect with no Ingress (#3183)"
[ "$(probe_host trueppm --set ingress.enabled=true --set probes.api.hostHeader=probe.example.test)" = "probe.example.test" ] \
  || fail "probes.api.hostHeader override did not beat the ingress host (#3237)"

# N+1. collectstatic (#3183). The image does not bake collectstatic output
#      (packages/api/Dockerfile:103 — it "writes here at startup"), the api
#      container serves /static/ through WhiteNoise from STATIC_ROOT, and the
#      chart mounts an emptyDir over that path. Without a collectstatic step the
#      directory stays empty and every /static/ asset 404s: unstyled Django admin
#      (the surface web.adminAccess exists to expose) and a blank Swagger UI.
#      Assert the step exists, shares the volume, and agrees with STATIC_ROOT.
cs_sel='.spec.template.spec.initContainers[] | select(.name == "collectstatic")'
cs_name="$(echo "$DEP" | yq "$cs_sel | .name")"
[ "$cs_name" = "collectstatic" ] \
  || fail "api Deployment has no 'collectstatic' init container — /static/ will 404 (#3183)"
cs_cmd="$(echo "$DEP" | yq "$cs_sel | .command | join(\" \")")"
case "$cs_cmd" in
  *collectstatic*) : ;;
  *) fail "init container 'collectstatic' does not run collectstatic (command: $cs_cmd)" ;;
esac
static_root="$(echo "$DEP" | yq '.spec.template.spec.containers[0].env[] | select(.name == "STATIC_ROOT") | .value')"
[ -n "$static_root" ] && [ "$static_root" != "null" ] \
  || fail "api container sets no STATIC_ROOT — the settings default resolves inside the read-only venv (#3183)"
cs_mount="$(echo "$DEP" | yq "$cs_sel | .volumeMounts[] | select(.name == \"staticfiles\") | .mountPath")"
api_static_mount="$(echo "$DEP" | yq '.spec.template.spec.containers[0].volumeMounts[] | select(.name == "staticfiles") | .mountPath')"
[ "$cs_mount" = "$static_root" ] \
  || fail "collectstatic mounts staticfiles at '$cs_mount' but STATIC_ROOT is '$static_root' — it would write where nothing reads (#3183)"
[ "$api_static_mount" = "$static_root" ] \
  || fail "the api container mounts staticfiles at '$api_static_mount' but STATIC_ROOT is '$static_root' — WhiteNoise would serve an empty directory (#3183)"

# N+2. Media volume / TRUEPPM_MEDIA_ROOT lockstep (#3184).
#      settings.prod probes MEDIA_ROOT for writability at IMPORT time, so a
#      container that mounts the media claim but never receives the env var (or
#      the reverse) either probes the wrong path or has no path to probe — and
#      because migrate/bootstrap/collectstatic import the same settings, that
#      crash-loops the api pod before the api container is ever created. This
#      exact drift happened during the fix: all three init containers had the
#      mount and none had the env, and nothing in the render said so.
#
#      The check is written against the CLASS, not the four containers that
#      exist today: it walks every container in every workload of the rendered
#      release and requires mount and env to agree, so a workload added later
#      is covered without editing this script. The non-default mountPath is
#      deliberate — the default happens to equal settings/base.py's own default,
#      so a render that never set the env var would still look correct.
MEDIA_PATH="/srv/trueppm-media-probe"
MEDIA_RENDER="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set persistence.media.enabled=true \
  --set "persistence.media.mountPath=$MEDIA_PATH" 2>&1)" \
  || fail "chart failed to render with persistence.media.enabled=true (#3184)"

media_report="$(echo "$MEDIA_RENDER" | yq eval-all '
  select(.kind == "Deployment") as $d
  | $d.metadata.name as $n
  | ($d.spec.template.spec.initContainers // []) + $d.spec.template.spec.containers
  | .[]
  | ($n + "/" + .name)
    + " mount=" + (([.volumeMounts[]? | select(.name == "media") | .mountPath] | .[0]) // "-")
    + " env=" + (([.env[]? | select(.name == "TRUEPPM_MEDIA_ROOT") | .value] | .[0]) // "-")
' - | grep ' mount=')"
[ -n "$media_report" ] || fail "no containers found in the persistence.media render (#3184)"

media_checked=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  c_mount="${line##* mount=}"; c_mount="${c_mount%% env=*}"
  c_env="${line##* env=}"
  c_name="${line%% mount=*}"
  case "$c_name" in
    */web) continue ;;   # nginx imports no Django settings and needs neither
  esac
  media_checked=$((media_checked + 1))
  [ "$c_mount" = "$MEDIA_PATH" ] \
    || fail "$c_name mounts the media claim at '$c_mount', expected '$MEDIA_PATH' — a container that imports settings.prod without the claim crash-loops on the MEDIA_ROOT probe (#3184)"
  [ "$c_env" = "$MEDIA_PATH" ] \
    || fail "$c_name has TRUEPPM_MEDIA_ROOT='$c_env' but mounts the claim at '$MEDIA_PATH' — the boot probe would test a path nothing is mounted at (#3184)"
done <<EOF
$media_report
EOF

# And the access-mode guard must actually refuse, not merely warn.
if helm template trueppm "$CHART" --set image.tag=latest \
     --set persistence.media.enabled=true \
     --set persistence.media.accessMode=ReadWriteOnce \
     --set replicaCount=2 >/dev/null 2>&1; then
  fail "a ReadWriteOnce media claim rendered alongside replicaCount=2 — an upload accepted by one api pod would 404 from the other (#3184)"
fi
# N+3. A backup must have somewhere durable to land (#3185).
#      backup.enabled with no destination rendered a CronJob whose `backups`
#      volume was an emptyDir: the Job dumped, exited 0, the artifact died with
#      the pod, and the CronJob reported success forever. The only guard was a
#      comment in values.yaml, and a comment cannot fail a render.
#
#      Asserted from BOTH sides, because a guard that only rejects is as broken
#      as one that only accepts: the four documented destinations must each
#      render, and the no-destination case must not.
if helm template trueppm "$CHART" --set image.tag=latest --set backup.enabled=true >/dev/null 2>&1; then
  fail "backup.enabled=true rendered with no destination — the artifact would go to an emptyDir and be discarded while the CronJob reports success (#3185)"
fi
# extraVolumes WITHOUT mediaDir must also be refused: cronjob-backup.yaml renders
# extraVolumes only inside `if .Values.backup.mediaDir`, so accepting it alone
# would wave through the exact emptyDir fallback this guard exists to stop.
if helm template trueppm "$CHART" --set image.tag=latest --set backup.enabled=true \
     --set 'backup.extraVolumes[0].name=own' >/dev/null 2>&1; then
  fail "backup.extraVolumes without backup.mediaDir was accepted as a destination, but the template ignores extraVolumes unless mediaDir is set (#3185)"
fi
backup_dest_checked=0
for dest in \
  "--set backup.persistence.enabled=true" \
  "--set backup.persistence.existingClaim=my-backups" \
  "--set backup.s3.enabled=true --set backup.s3.bucket=b" \
  "--set backup.mediaDir=/var/lib/trueppm/media --set backup.extraVolumes[0].name=own --set backup.extraVolumes[0].emptyDir.medium="
do
  # shellcheck disable=SC2086
  helm template trueppm "$CHART" --set image.tag=latest --set backup.enabled=true $dest >/dev/null 2>&1 \
    || fail "a documented backup destination was refused by the render: $dest (#3185)"
  backup_dest_checked=$((backup_dest_checked + 1))
done

# The CronJob's inline command and scripts/backup.sh are two producers of one
# artifact format. They diverged silently before (#3185): the template's tar
# swallowed failures with `|| true` and its MANIFEST carried two of the script's
# seven fields, so an artifact could not tell a restorer whether media was in it.
BACKUP_CMD="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set backup.enabled=true --set backup.persistence.enabled=true \
  --show-only templates/cronjob-backup.yaml \
  | yq eval-all 'select(.kind == "CronJob") | .spec.jobTemplate.spec.template.spec.containers[0].command[2]' -)"
[ -n "$BACKUP_CMD" ] || fail "could not extract the backup CronJob's inline command (#3185)"
manifest_fields_checked=0
for field in created_utc run_context pg_dump_version db_included media_included redis_included s3_destination; do
  echo "$BACKUP_CMD" | grep -q "echo \"$field:" \
    || fail "the CronJob's MANIFEST omits '$field', which scripts/backup.sh writes — a restorer cannot read one artifact the way they read the other (#3185)"
  grep -q "echo \"$field:" "$(cd "$(dirname "$0")" && pwd)/backup.sh" \
    || fail "scripts/backup.sh no longer writes MANIFEST field '$field' but the CronJob still does — the two producers have drifted (#3185)"
  manifest_fields_checked=$((manifest_fields_checked + 1))
done
echo "$BACKUP_CMD" | grep -q 'tar -czf "$STAGE/media.tar.gz".*|| true' \
  && fail "the CronJob's media tar swallows failure with '|| true' — it would ship an artifact whose MANIFEST claims media it does not carry (#3185)"

# N+4. Placement knobs exist and reach every workload (#3188).
#      values.schema.json closes the root with additionalProperties:false, so a
#      missing knob is REJECTED rather than ignored — `--set
#      imagePullSecrets[0].name=regcred` failed schema validation, which meant a
#      private-registry / air-gapped install was impossible without forking the
#      chart. Assert the four that were verified broken, then assert the render
#      actually carries them: schema acceptance alone would pass with the
#      templates never reading the values.
place_checked=0
for kv in "nodeSelector.disktype=ssd" "tolerations[0].key=x" "imagePullSecrets[0].name=regcred" "priorityClassName=high"; do
  helm template trueppm "$CHART" --set image.tag=latest --set "$kv" >/dev/null 2>&1 \
    || fail "--set $kv is rejected — the chart has no air-gapped/placement path (#3188)"
  place_checked=$((place_checked + 1))
done

PLACE_RENDER="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set 'imagePullSecrets[0].name=regcred' \
  --set priorityClassName=high \
  --set nodeSelector.disktype=ssd \
  --set 'topologySpreadConstraints[0].maxSkew=1' \
  --set 'topologySpreadConstraints[0].topologyKey=kubernetes.io/hostname' \
  --set 'topologySpreadConstraints[0].whenUnsatisfiable=ScheduleAnyway')"

# Every Deployment must carry all four, AND its spread constraint's labelSelector
# must name ITS OWN component. A global list applied verbatim would spread one
# tier and silently no-op on the other three, which looks identical in a diff.
place_workloads=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  name="${line%% *}"
  comp="${line##* }"
  [ "$comp" = "$(echo "$name" | sed 's/^trueppm-//')" ] \
    || fail "$name's topologySpreadConstraints labelSelector names component '$comp', not its own tier — the constraint would spread the wrong pods (#3188)"
  place_workloads=$((place_workloads + 1))
done <<EOF
$(echo "$PLACE_RENDER" | yq eval '
  select(.kind == "Deployment")
  | .metadata.name + " "
    + (.spec.template.spec.topologySpreadConstraints[0].labelSelector.matchLabels["app.kubernetes.io/component"] // "MISSING")
' - | grep -v '^---$' | grep ' ')
EOF
[ "$place_workloads" -ge 4 ] \
  || fail "only $place_workloads workloads carry topologySpreadConstraints, expected at least 4 (#3188)"

# Captured into variables first: `grep -q` exits on its first match, which sends
# SIGPIPE to yq, and under `set -o pipefail` that failure becomes the pipeline's
# — a false FAIL on a render that is actually correct.
place_pull="$(echo "$PLACE_RENDER" | yq eval 'select(.kind == "Deployment") | .spec.template.spec.imagePullSecrets[0].name' -)"
case "$place_pull" in
  *regcred*) ;;
  *) fail "imagePullSecrets does not reach the rendered pod specs (#3188)" ;;
esac
place_prio="$(echo "$PLACE_RENDER" | yq eval 'select(.kind == "Deployment") | .spec.template.spec.priorityClassName' -)"
case "$place_prio" in
  *high*) ;;
  *) fail "priorityClassName does not reach the rendered pod specs (#3188)" ;;
esac

# An HPA and a static `replicas` must never both own the same tier: every helm
# upgrade would reset the count and the HPA would scale it back, a scale-down
# flap per release.
hpa_replicas="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set autoscaling.enabled=true --set autoscaling.worker.enabled=true \
  | yq eval 'select(.kind == "Deployment") | .metadata.name + "=" + (.spec.replicas // "unset" | tostring)' - \
  | grep -E 'api|celery-worker')"
echo "$hpa_replicas" | grep -qv 'unset' && {
  case "$hpa_replicas" in
    *api=unset*) ;;
    *) fail "the api Deployment still sets .spec.replicas while an HPA owns the tier (#3188): $hpa_replicas" ;;
  esac
  case "$hpa_replicas" in
    *celery-worker=unset*) ;;
    *) fail "the celery-worker Deployment still sets .spec.replicas while its HPA owns the tier (#3188): $hpa_replicas" ;;
  esac
}

# The web tier must follow replicaCount, and must have a PDB. It shipped as a
# truthy `1`, so its documented fallback could never fire and a values-prod
# render was api=2 worker=2 web=1 with zero PodDisruptionBudgets.
web_replicas="$(helm template trueppm "$CHART" --set image.tag=latest --set replicaCount=3 \
  | yq eval 'select(.kind == "Deployment" and .metadata.name == "trueppm-web") | .spec.replicas' - | grep -v '^---$' | grep -v '^$')"
[ "$web_replicas" = "3" ] \
  || fail "web rendered $web_replicas replicas at replicaCount=3 — the documented fallback does not fire (#3188)"
pdb_names="$(helm template trueppm "$CHART" --set image.tag=latest --set podDisruptionBudget.enabled=true \
  | yq eval 'select(.kind == "PodDisruptionBudget") | .metadata.name' -)"
case "$pdb_names" in
  *trueppm-web*) ;;
  *) fail "no PodDisruptionBudget for the web tier — the only tier a browser loads is the unprotected one (#3188)" ;;
esac

echo "helm structure check GREEN:"
echo "  - init order: migrate -> bootstrap"
echo "  - operator envFrom secret reaches all $env_checked containers that import settings.prod"
echo "  - shared admin-password emptyDir mounted by bootstrap ($boot_mount) and api ($api_mount)"
echo "  - web nginx proxies to release-scoped trueppm-api (baked compose 'api' host overridden)"
echo "  - web nginx ships X-Frame-Options + nosniff + a frame-ancestors CSP by default, and web.securityHeaders.* still overrides/disables them"
echo "  - all $np_checked datastore-client bindings are covered by the NetworkPolicy allow-lists"
echo "  - production nginx /admin/ fails closed (deny all + limit_req; allow precedes deny)"
echo "  - celery worker pins --concurrency=$wc_n and honors concurrency/extraArgs overrides"
echo "  - all $tag_checked first-party images default to '$EXPECTED_TAG' (a tag the release pipeline publishes); explicit image.tag still wins"

echo "  - connection URLs: no plaintext credential in any workload; $url_env_checked env bindings are secretKeyRef-only and unduplicated"
echo "  - the external-Secret (secretKeyRef map) form passes through to op-db/op-cache and is not copied into the chart Secret"
echo "  - NOTES.txt names all four boot-guard keys on a bare install, and stays quiet once they are configured"
echo "  - NOTES.txt names each trusted envFrom source and says the list is replace-not-merge"
echo "  - values.schema.json rejects an unknown top-level key and accepts every shipped overlay"
echo "  - both api probes send Host: $noing_host with no Ingress, $ing_host with one (kubelet would otherwise send the pod IP and Django would 400 it)"
echo "  - collectstatic runs and shares STATIC_ROOT ($static_root) with the api container"
echo "  - media claim: all $media_checked settings-importing containers agree on mount and TRUEPPM_MEDIA_ROOT; RWO above one replica is refused"
echo "  - backup: no-destination render refused; all $backup_dest_checked documented destinations accepted; CronJob and scripts/backup.sh agree on all $manifest_fields_checked MANIFEST fields"
echo "  - placement: $place_checked previously-rejected keys accepted; $place_workloads workloads carry a self-scoped spread constraint; HPA owns replicas alone; web follows replicaCount and has a PDB"
