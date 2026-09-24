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
    if [ -n "$want" ] && ! grep -qF "$want" <<<"$out"; then
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
  if grep -qx -- '---' <<<"$st_shimmed" \
     && grep -qx 'probe-postgresql' <<<"$st_shimmed"; then
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
  #   N+9 no bare `manage.py migrate` anywhere in the chart
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
grep -q 'proxy_pass http://trueppm-api:' <<<"$web_upstream" \
  || fail "web nginx ConfigMap does not proxy to the release-scoped 'trueppm-api' Service"
grep -q 'proxy_pass http://api:' <<<"$web_upstream" \
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
  grep -qF "$hdr" <<<"$web_upstream" \
    || fail "web nginx ConfigMap does not set '$hdr' on a default install — the SPA document carries no such protection, and Django cannot add it (#2849)"
done
grep -q 'add_header Content-Security-Policy .*always;' <<<"$web_upstream" \
  || fail "web nginx ConfigMap sets no Content-Security-Policy on a default install (#2849)"
grep -q "frame-ancestors 'none'" <<<"$web_upstream" \
  || fail "web nginx ConfigMap's default CSP has no \`frame-ancestors 'none'\` (#2849)"

#     …and the knob must actually be a knob: an operator behind their own WAF
#     has to be able to replace the CSP or drop the set entirely, or they will
#     delete the block instead of tuning it.
custom_csp="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set "web.securityHeaders.contentSecurityPolicy=default-src 'self' https://cdn.example" \
  --show-only templates/web/configmap.yaml | yq '.data["default.conf"]')"
grep -q "default-src 'self' https://cdn.example" <<<"$custom_csp" \
  || fail "web.securityHeaders.contentSecurityPolicy is not honored — the CSP is effectively hardcoded (#2849)"

off_csp="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set web.securityHeaders.enabled=false \
  --show-only templates/web/configmap.yaml | yq '.data["default.conf"]')"
grep -q 'add_header X-Frame-Options' <<<"$off_csp" \
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
  --set demo.reset.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=structurecheckschedule \
  --set demo.shareToken.board=structurecheckboard \
  --set networkPolicy.ingressControllerConfirmed=true)"

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
grep -qE '^[[:space:]]*deny all;' <<<"$admin_default" \
  || fail "production nginx /admin/ block has no 'deny all' on default values — a default install publishes Django admin to the internet (#2569)"
grep -qE '^[[:space:]]*allow ' <<<"$admin_default" \
  && fail "production nginx /admin/ renders an 'allow' directive on DEFAULT values — the allowlist must be empty (deny-by-default) unless the operator sets web.adminAccess.allowCIDRs"

# 6b. The admin surface must be rate-limited, and the zone it references must
#     actually be declared — nginx refuses to start on an unknown limit_req zone,
#     so a half-rendered pair is a crash-loop, not a soft failure.
grep -q 'limit_req zone=admin_login' <<<"$admin_default" \
  || fail "production nginx /admin/ block has no 'limit_req' — admin login is unthrottled (#2569)"
limit_zone_conf="$(helm template trueppm "$CHART" --set image.tag=latest --show-only templates/web/configmap.yaml \
  | yq '.data["default.conf"]')"
grep -q 'limit_req_zone .* zone=admin_login:' <<<"$limit_zone_conf" \
  || fail "the admin_login limit_req zone is referenced but never declared — nginx will refuse to start"

# 6c. A supplied CIDR must render an `allow` BEFORE the `deny all`. nginx takes
#     the first matching allow/deny rule, so an allow emitted after `deny all` is
#     dead config and the operator's allowlist would silently do nothing.
admin_cidr="$(prod_admin_block --set 'web.adminAccess.allowCIDRs={10.42.0.0/16}')"
grep -qE '^[[:space:]]*allow 10\.42\.0\.0/16;' <<<"$admin_cidr" \
  || fail "web.adminAccess.allowCIDRs did not render a matching 'allow' directive"
allow_ln="$(grep -m1 -nE '^[[:space:]]*allow ' <<<"$admin_cidr" | cut -d: -f1 || true)"
deny_ln="$(grep -m1 -nE '^[[:space:]]*deny all;' <<<"$admin_cidr" | cut -d: -f1 || true)"
[ -n "$allow_ln" ] && [ -n "$deny_ln" ] && [ "$allow_ln" -lt "$deny_ln" ] \
  || fail "'allow' (line $allow_ln) must precede 'deny all' (line $deny_ln) — nginx honors the first match, so this allowlist is inert"

# 6d. adminAccess.enabled=false removes the surface entirely.
admin_off="$(prod_admin_block --set web.adminAccess.enabled=false)"
grep -q 'return 404' <<<"$admin_off" \
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
grep -qE -- '--concurrency=[0-9]+' <<<"$wc_default" \
  || fail "celery worker command has no explicit --concurrency — Celery falls back to cpu_count() and OOMKills the background tier on any multi-core node (#2571)"

# The default must be a small pinned value, NOT the node's core count.
wc_n="$(echo "$wc_default" | sed -nE 's/.*--concurrency=([0-9]+).*/\1/p')"
[ "$wc_n" -ge 1 ] || fail "default --concurrency is '$wc_n' — must be >= 1"

# The knob must actually be wired, not just present with a default.
grep -q -- '--concurrency=4' <<<"$(worker_cmd --set celeryWorker.concurrency=4)" \
  || fail "celeryWorker.concurrency=4 did not render '--concurrency=4' — the values knob is not wired"

# extraArgs must append verbatim AND in the declared order.
wc_extra="$(worker_cmd --set 'celeryWorker.extraArgs={--queues=exports,--prefetch-multiplier=1}')"
grep -q -- '--queues=exports' <<<"$wc_extra" \
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

# ...and the chart must be the SAME version as the release it ships with (#3907).
# The default-tag assertions below are self-referential — they prove the chart
# asks for v<its own appVersion>, which is a tag that exists only if appVersion
# equals the version the images were built from. release.sh never bumped
# Chart.yaml, so it sat at 0.4.0 while api/web moved to 0.4.0-beta.1: this file
# stayed green while a stock install of the published beta chart pointed at
# `v0.4.0`, an image no pipeline ever pushed. Comparing against the API manifest
# (the canonical version source release.sh reads) is what makes that drift visible
# on every MR instead of at the next tag. `version` is held to the same value
# because it is the OCI tag helm:publish pushes under.
API_MANIFEST_VERSION="$(grep -m1 '^version = ' "$(cd "$(dirname "$0")/.." && pwd)/packages/api/pyproject.toml" | sed 's/version = "\(.*\)"/\1/')"
[ -n "$API_MANIFEST_VERSION" ] || fail "could not read the release version from packages/api/pyproject.toml"
CHART_PKG_VERSION="$(yq '.version' "$CHART/Chart.yaml")"
if [ "$CHART_PKG_VERSION" != "$API_MANIFEST_VERSION" ] || [ "$APP_VERSION" != "$API_MANIFEST_VERSION" ]; then
  fail "Chart.yaml (version: $CHART_PKG_VERSION, appVersion: $APP_VERSION) is out of lockstep with the release version $API_MANIFEST_VERSION — scripts/release.sh bumps both; a default install would otherwise pull v$APP_VERSION, which the release pipeline never publishes (#3907)"
fi

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
  --set demo.reset.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=structurecheckschedule \
  --set demo.shareToken.board=structurecheckboard \
  --set networkPolicy.ingressControllerConfirmed=true \
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
grep -q ":1.2.3-rc1\$" <<<"$override_images" \
  || fail "an explicit image.tag override did not render verbatim — trueppm.imageTag must pass .Values.image.tag straight through"
grep -q ":v1.2.3-rc1\$" <<<"$override_images" \
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
if grep -q 'map\[secretKeyRef' <<<"$MAP_RENDER"; then
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
  grep -q "$key" <<<"$bare_notes" \
    || fail "NOTES.txt on a bare install does not name '$key' — the operator is not told why the pod will crash-loop (#2812)"
done
grep -q "WILL NOT START" <<<"$bare_notes" \
  || fail "NOTES.txt on a bare install does not warn that the release will not start (#2812)"

# Configured via envFrom (the README quickstart) — the warning must go away.
if grep -q "WILL NOT START" <<<"$(notes --set "envFrom[0].secretRef.name=${ENV_SECRET}")"; then
  fail "NOTES.txt still warns about missing secrets when envFrom is configured (#2812)"
fi

# Configured via env.* (the values-file idiom) — same.
if grep -q "WILL NOT START" <<<"$(notes --set env.SECRET_KEY=x --set env.ALLOWED_HOSTS=h \
     --set env.INTEGRATION_ENCRYPTION_KEY=k \
     --set env.TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true)"; then
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
  grep -q "ALLOWED_HOSTS" <<<"$pf_notice" \
    || fail "the port-forward notice does not name ALLOWED_HOSTS with web.enabled=$pf_web (#3238)"
  grep -q "localhost" <<<"$pf_notice" \
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
grep -q "Secret/${ENV_SECRET}" <<<"$trusted_notes" \
  || fail "NOTES.txt does not name the envFrom sources it trusts for the boot-guard keys — an operator whose list was replaced by another values file has nothing to notice (#2879)"
grep -qi 'replaces it wholesale' <<<"$trusted_notes" \
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
  grep -q "echo \"$field:" <<<"$BACKUP_CMD" \
    || fail "the CronJob's MANIFEST omits '$field', which scripts/backup.sh writes — a restorer cannot read one artifact the way they read the other (#3185)"
  grep -q "echo \"$field:" "$(cd "$(dirname "$0")" && pwd)/backup.sh" \
    || fail "scripts/backup.sh no longer writes MANIFEST field '$field' but the CronJob still does — the two producers have drifted (#3185)"
  manifest_fields_checked=$((manifest_fields_checked + 1))
done
grep -q 'tar -czf "$STAGE/media.tar.gz".*|| true' <<<"$BACKUP_CMD" \
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
grep -qv 'unset' <<<"$hpa_replicas" && {
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

# N+5. Celery liveness/readiness probes must be tunable APART, and the shipped
#      defaults must stay derived from the worker's termination grace (#3230).
#
#      Until #3230 `trueppm.celeryProbe` emitted one body that the worker
#      Deployment included twice, so liveness and readiness were forced to the
#      same numbers despite opposite costs: readiness is free (a celery worker
#      sits behind no Service, so it paces rolling updates and nothing else),
#      while liveness KILLS the container and burns
#      lifecycle.worker.terminationGracePeriodSeconds — 300s per kill.
#
#      This section is also the answer to the second half of #3230, which asked
#      for a runtime gate on the shipped defaults OR a re-derivation of them.
#      A runtime gate is not available: both drills disable the worker probes
#      because an exec probe forks a full Django import into the container it is
#      measuring, and on kind-in-dind that never succeeds at any timing (#3218,
#      job 16193488334 — 13 readiness failures, zero successes, against a worker
#      that had logged `ready.` 16s in). Readiness has no failure budget to
#      widen, so no value fixes it. The defaults were re-derived instead, and
#      this is what holds the derivation: it reads the numbers out of the render
#      and binds them to the grace they were derived FROM, so moving either one
#      alone reds the lint stage.
cp_worker="$(helm template trueppm "$CHART" --set image.tag=latest \
  --show-only templates/celery-worker/deployment.yaml)"
cp_get() { # cp_get <manifest> <probe> <field>
  echo "$1" | yq ".spec.template.spec.containers[0].${2}Probe.${3}"
}

cp_live_i="$(cp_get "$cp_worker" liveness initialDelaySeconds)"
cp_live_p="$(cp_get "$cp_worker" liveness periodSeconds)"
cp_live_f="$(cp_get "$cp_worker" liveness failureThreshold)"
cp_ready_i="$(cp_get "$cp_worker" readiness initialDelaySeconds)"
cp_ready_p="$(cp_get "$cp_worker" readiness periodSeconds)"
cp_grace="$(echo "$cp_worker" | yq '.spec.template.spec.terminationGracePeriodSeconds')"

for v in "$cp_live_i" "$cp_live_p" "$cp_live_f" "$cp_ready_i" "$cp_ready_p" "$cp_grace"; do
  case "$v" in
    ''|null|*[!0-9]*) fail "celery worker probes did not render a full set of integer timings (#3230): liveness=${cp_live_i}/${cp_live_p}/${cp_live_f} readiness=${cp_ready_i}/${cp_ready_p} grace=${cp_grace}" ;;
  esac
done

# N+5.a — the split must be LIVE, not merely declared. If every field matched,
#         the two probes are back to one shared spec and the values keys are
#         decoration.
[ "$cp_live_i" != "$cp_ready_i" ] || [ "$cp_live_f" != "$(cp_get "$cp_worker" readiness failureThreshold)" ] \
  || fail "celery worker liveness and readiness rendered identical timings — the #3230 split is not reaching the render"

# N+5.b — the derivation. A liveness kill costs up to terminationGracePeriodSeconds
#         of unavailability for that pod, so the steady-state detection budget that
#         orders the kill must be at least that expensive. Before #3230 it was
#         3 x 60 = 180s against a 300s grace: one kill cost more downtime than the
#         detection that decided on it.
cp_detect=$((cp_live_f * cp_live_p))
[ "$cp_detect" -ge "$cp_grace" ] \
  || fail "celery worker liveness detection is ${cp_detect}s (failureThreshold ${cp_live_f} x period ${cp_live_p}) against a ${cp_grace}s termination grace — a kill costs more unavailability than the detection that ordered it (#3230)"

# N+5.c — readiness is the cheap probe and must reach a first success EARLIER than
#         liveness could ever kill. #3218 had to raise the shared initialDelay to
#         protect liveness, which pushed every green drill's first readiness out
#         with it; that trade is the whole reason the split exists.
[ "$cp_ready_i" -lt "$cp_live_i" ] \
  || fail "celery worker readiness initialDelaySeconds (${cp_ready_i}) is not earlier than liveness (${cp_live_i}) — the split is not being used to let readiness answer sooner (#3230)"

# N+5.d — liveness must not get CHEAPER by probing more often. It is still
#         `celery inspect ping`, an exec probe that runs INSIDE the container it
#         measures, so each one forks a Django import into the worker's own CPU
#         budget and competes with the MainProcess that has to answer the ping.
#         Shortening the period makes that worse, not better (#3218).
#
#         Readiness is EXEMPT from this floor since #3346: it no longer runs
#         `inspect ping` at all — it stats a heartbeat file a Celery signal
#         handler touches on its own ~2s timer (trueppm_api.core.worker_heartbeat),
#         which costs nothing proportional to load. That is what let its default
#         period drop from the pre-#3346 60s to 15s (see N+5.i for the mechanism
#         assertion) — a stuck worker is now caught in dozens of seconds instead
#         of up to a minute.
[ "$cp_live_p" -ge 60 ] \
  || fail "celery worker liveness period ${cp_live_p}s drops below 60s — inspect ping still forks a Django import into the cgroup it is measuring (#3218, #3230)"

# N+5.e — kubelet's own timeout must SCALE with the celery ping budget. It was
#         hardcoded at --timeout +5, and that fixed 5s has to absorb the sh fork,
#         Python start, and Django/Celery import; raise the ping budget because the
#         node is slow and the import headroom stays 5s on the same slow node. When
#         kubelet fires first there is no celery stderr, so it presents as a bare
#         `Liveness probe failed:` with an empty body.
cp_kubelet() { # cp_kubelet <celery --timeout>
  helm template trueppm "$CHART" --set image.tag=latest \
    --set "probes.worker.timeoutSeconds=$1" \
    --show-only templates/celery-worker/deployment.yaml \
    | yq '.spec.template.spec.containers[0].livenessProbe.timeoutSeconds'
}
cp_kt10="$(cp_kubelet 10)"
cp_kt20="$(cp_kubelet 20)"
[ "$cp_kt10" = "15" ] \
  || fail "kubelet probe timeout at the default celery --timeout 10 is $cp_kt10, expected 15 — the derivation must not change the shipped value (#3230)"
[ "$cp_kt20" -gt 25 ] \
  || fail "kubelet probe timeout at celery --timeout 20 is $cp_kt20 — still the old fixed +5, so the import headroom does not scale with the ping budget (#3230)"

# N+5.f — BACKWARD COMPATIBILITY. The four flat keys predate the split and meant
#         "both probes". A values file carrying only them must still render two
#         identical probes with exactly those numbers — if the per-probe layer won
#         instead, the chart's own re-derived defaults would silently override an
#         operator's existing value, which is the one break this change must not
#         cause.
cp_flat="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set probes.worker.initialDelaySeconds=45 \
  --set probes.worker.periodSeconds=90 \
  --set probes.worker.failureThreshold=7 \
  --show-only templates/celery-worker/deployment.yaml)"
for f in initialDelaySeconds:45 periodSeconds:90 failureThreshold:7; do
  cp_want="${f#*:}"; cp_field="${f%%:*}"
  for cp_kind in liveness readiness; do
    cp_got="$(cp_get "$cp_flat" "$cp_kind" "$cp_field")"
    [ "$cp_got" = "$cp_want" ] \
      || fail "a flat probes.worker.${cp_field}=${cp_want} rendered ${cp_kind}Probe.${cp_field}=${cp_got} — the pre-#3230 shared-override meaning of the flat keys is broken, so existing operator values files change behavior on upgrade (#3230)"
  done
done

# N+5.g — the master switch still removes ALL THREE probes (startup added by
#         #3346). Both runtime drills disable at least the liveness ping (see
#         CELERY_PROBE_OVERRIDES in helm-install-drill.sh/helm-netpol-drill.sh);
#         if a per-probe `enabled` shadowed the master switch, an override meant
#         to remove one probe could silently leave another rendered.
cp_off="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set probes.worker.enabled=false \
  --show-only templates/celery-worker/deployment.yaml)"
[ "$(cp_get "$cp_off" liveness initialDelaySeconds)" = "null" ] \
  && [ "$(cp_get "$cp_off" readiness initialDelaySeconds)" = "null" ] \
  && [ "$(cp_get "$cp_off" startup initialDelaySeconds)" = "null" ] \
  || fail "probes.worker.enabled=false still rendered a celery probe — the drills' override no longer removes them (#3218, #3230, #3346)"

# N+5.i — the worker's readiness and startup probes must be the heartbeat-file
#         mechanism, NOT `celery inspect ping` (#3236, #3346). This is the
#         assertion that pins the actual fix: #3236 showed a worker with 0
#         restarts, processing jobs throughout, that never once answered
#         `inspect ping` under kind-in-dind contention — an exec probe that
#         forks Django/Celery into the container it measures can starve under
#         load and fail a worker doing exactly the work it exists to do.
cp_ready_cmd="$(echo "$cp_worker" | yq '.spec.template.spec.containers[0].readinessProbe.exec.command[-1]')"
cp_startup_cmd="$(echo "$cp_worker" | yq '.spec.template.spec.containers[0].startupProbe.exec.command[-1]')"
case "$cp_ready_cmd" in
  *"inspect ping"*) fail "celery worker readiness still execs 'inspect ping' — #3236's false-fail mechanism is unfixed: $cp_ready_cmd" ;;
  *find*newermt*) ;;
  *) fail "celery worker readiness command does not look like the heartbeat-file freshness check (#3346): $cp_ready_cmd" ;;
esac
case "$cp_startup_cmd" in
  *"inspect ping"*) fail "celery worker startup still execs 'inspect ping' (#3346): $cp_startup_cmd" ;;
  *"test -e"*) ;;
  *) fail "celery worker startup command does not look like the heartbeat-file existence check (#3346): $cp_startup_cmd" ;;
esac
grep -q "TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE" <<<"$cp_worker" \
  || fail "celery-worker container does not export TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE — the app's signal handler and the chart's exec probes could disagree on the heartbeat file path (#3346)"

# N+5.j — the worker's liveness probe must still be `inspect ping` (#3346 left
#         it unchanged on purpose — see N+5.d).
cp_live_cmd="$(echo "$cp_worker" | yq '.spec.template.spec.containers[0].livenessProbe.exec.command[-1]')"
case "$cp_live_cmd" in
  *"inspect ping"*) ;;
  *) fail "celery worker liveness no longer execs 'inspect ping' — #3346 only intended to replace the READINESS mechanism: $cp_live_cmd" ;;
esac

# N+5.h — beat renders a livenessProbe ONLY. It is a pinned singleton behind no
#         Service, so a readiness probe would gate nothing while still forking a
#         Django import into the chart's tightest cgroup. The schema has no
#         `probes.beat.readiness` for the same reason: a knob nothing reads is
#         worse than a missing one.
cp_beat="$(helm template trueppm "$CHART" --set image.tag=latest \
  --show-only templates/celery-beat/deployment.yaml)"
[ "$(cp_get "$cp_beat" liveness periodSeconds)" != "null" ] \
  || fail "celery beat renders no livenessProbe (#1904)"
[ "$(cp_get "$cp_beat" readiness periodSeconds)" = "null" ] \
  || fail "celery beat rendered a readinessProbe — beat sits behind no Service, so it gates nothing and only costs a Django import in a 250m cgroup (#3230)"
helm template trueppm "$CHART" --set image.tag=latest --set probes.beat.readiness.periodSeconds=10 >/dev/null 2>&1 \
  && fail "values.schema.json accepts probes.beat.readiness — beat renders no readiness probe, so the key would be a control that writes and is never read (#3230)"

# N+6. The API tier's uvicorn worker count must be a chart value, not a fixed
#      single process baked into the image's CMD (#3833). The shipped image's
#      CMD carries no --workers flag, so uvicorn runs one process per pod and
#      request CPU pins at about one core — measured: eight concurrent Schedule
#      opens took 22.5s each against one process and 7.3s against four.
api_cmd() {
  helm template trueppm "$CHART" --set image.tag=latest "$@" \
    --show-only templates/api/deployment.yaml \
    | yq '.spec.template.spec.containers[0].command | join(" ")'
}

# N+6.a — the DEFAULT must render exactly one worker, preserving the image's
#         shipped single-process behavior. It may render an explicit
#         "--workers 1" (this chart does — an unconditional command, like the
#         celery worker's, is simpler to keep correct than a conditional one)
#         or omit the flag entirely; either is a behavioral no-op, so this
#         asserts the OUTCOME (exactly one worker) rather than which form.
ac_default="$(api_cmd)"
case "$ac_default" in
  *"--workers 1"*) ;;
  *"--workers"*) fail "api.workers default did not render as 1 worker: $ac_default" ;;
  *) ;; # flag omitted entirely — also a valid rendering of the default
esac
grep -qE -- '^uvicorn ' <<<"$ac_default" \
  || fail "api container command does not start with uvicorn — the override changed more than intended: $ac_default"
grep -q -- '--host 0.0.0.0 --port 8000' <<<"$ac_default" \
  || fail "api command dropped --host/--port from the Dockerfile CMD it is meant to only ADD --workers to: $ac_default"

# N+6.b — the knob must actually be wired, and must not silently change the
#         bind address/port the readiness/liveness probes and Service target.
ac_four="$(api_cmd --set api.workers=4)"
grep -q -- '--workers 4' <<<"$ac_four" \
  || fail "api.workers=4 did not render '--workers 4' in the api container command — the values knob is not wired"
grep -q -- '--host 0.0.0.0 --port 8000' <<<"$ac_four" \
  || fail "api.workers=4 changed --host/--port away from the Dockerfile CMD: $ac_four"

# N+6.c — 0 must be REJECTED, not passed through: uvicorn treats --workers 0 as
#         an invalid argument, so a silent 0 would crash-loop the api container
#         at whatever moment an operator or a values-merge produced it, instead
#         of failing at `helm template`/`helm upgrade --dry-run` time.
if api_cmd --set api.workers=0 >/dev/null 2>&1; then
  fail "api.workers=0 rendered successfully — it must fail the render, uvicorn requires at least one worker (#3833)"
fi

# N+7. The demo's scheduled reset (ADR-1197 D9, #3925). The CronJob is a SECOND COPY of
#      the install hook's pod, so every assertion here is a drift guard: the two
#      must keep the same command and the same env, and the reset must not exist
#      unless both switches are on. Off by default is load-bearing — an upgrade
#      that began re-seeding on a timer unprompted would be a destructive surprise.
demo_args=(--set image.tag=latest --set demo.enabled=true
  --set demo.baseUrl=https://demo.example.com
  --set demo.shareToken.schedule=struct-schedule --set demo.shareToken.board=struct-board
  --set networkPolicy.ingressControllerConfirmed=true)
reset_names() {
  helm template trueppm "$CHART" "$@" \
    | yq 'select(.kind=="CronJob" and (.metadata.name | test("-demo-reset$"))) | .metadata.name' \
    | grep -vE '^(---)?$' || true
}
reset_doc() {
  helm template trueppm "$CHART" "${demo_args[@]}" --set demo.reset.enabled=true "$@" \
    --show-only templates/demo-reset-cronjob.yaml
}

# N+7.a — absent unless BOTH demo.enabled and demo.reset.enabled.
[ -z "$(reset_names --set image.tag=latest)" ] \
  || fail "a DEFAULT render produced a demo-reset CronJob — the scheduled reset must be off by default"
[ -z "$(reset_names "${demo_args[@]}")" ] \
  || fail "demo.enabled alone rendered a demo-reset CronJob — demo.reset.enabled must be an explicit opt-in"
[ -z "$(reset_names --set image.tag=latest --set demo.reset.enabled=true)" ] \
  || fail "demo.reset.enabled without demo.enabled rendered a CronJob — the block must be inert while demo.enabled is false"
[ "$(reset_names "${demo_args[@]}" --set demo.reset.enabled=true | wc -l | tr -d ' ')" = "1" ] \
  || fail "demo.enabled + demo.reset.enabled did not render exactly one demo-reset CronJob"

# N+7.b — the shape that makes it safe to run on a timer.
rc="$(reset_doc)"
[ "$(yq '.spec.concurrencyPolicy' <<<"$rc")" = "Forbid" ] \
  || fail "demo-reset concurrencyPolicy is not Forbid — the seed is destructive, so overlapping runs would delete each other's rows"
[ "$(yq '.spec.schedule' <<<"$rc")" = "0 */6 * * *" ] \
  || fail "demo-reset default schedule is not '0 */6 * * *' (every 6 hours)"
[ "$(yq '.spec.jobTemplate.spec.activeDeadlineSeconds > 0' <<<"$rc")" = "true" ] \
  || fail "demo-reset has no activeDeadlineSeconds — a hung seed would hold the Forbid slot forever and block every later run"
[ "$(yq '.spec.startingDeadlineSeconds > 0' <<<"$rc")" = "true" ] \
  || fail "demo-reset has no startingDeadlineSeconds — after a controller outage it would fire a burst of queued resets"
[ "$(yq '.spec.jobTemplate.spec.template.spec.automountServiceAccountToken' <<<"$rc")" = "false" ] \
  || fail "demo-reset pod automounts a ServiceAccount token — the seed makes no Kubernetes API calls"
[ "$(yq '.spec.jobTemplate.spec.template.metadata.labels."app.kubernetes.io/component"' <<<"$rc")" = "demo-seed" ] \
  || fail "demo-reset pod is not labeled component=demo-seed — the NetworkPolicy selects datastore clients by that label, so the pod could not reach PostgreSQL or Valkey"

# N+7.c — it must be the SAME seed as the install hook: same command, same env.
job="$(helm template trueppm "$CHART" "${demo_args[@]}" --show-only templates/demo-seed-job.yaml)"
cmd_of() { yq '.spec.template.spec.containers[0].command | join(" ")' <<<"$1"; }
rc_cmd="$(yq '.spec.jobTemplate.spec.template.spec.containers[0].command | join(" ")' <<<"$rc")"
# Exact equality on the RENDERED command, not a grep of the source: an added flag, an
# abbreviation of --with-personas, or a suffix anywhere in the command list fails here
# regardless of how the template spelled it.
want_cmd="sh -c python manage.py load_sample_project && python manage.py create_demo_share_link"
[ "$rc_cmd" = "$want_cmd" ] \
  || fail "demo-reset command is not exactly the shared seed. got: '$rc_cmd'"
[ "$(cmd_of "$job")" = "$want_cmd" ] \
  || fail "demo-seed install hook command is not exactly the shared seed. got: '$(cmd_of "$job")'"
[ "$rc_cmd" = "$(cmd_of "$job")" ] \
  || fail "demo-reset runs a different command from the install hook. reset: '$rc_cmd' / hook: '$(cmd_of "$job")'"
env_of() { yq "$2 | [.[].name] | sort | join(\",\")" <<<"$1"; }
[ "$(env_of "$rc" '.spec.jobTemplate.spec.template.spec.containers[0].env')" = "$(env_of "$job" '.spec.template.spec.containers[0].env')" ] \
  || fail "demo-reset and the install hook seed container have different env names — the reset would seed with different tokens or connection settings"
[ "$(env_of "$rc" '.spec.jobTemplate.spec.template.spec.initContainers[0].env')" = "$(env_of "$job" '.spec.template.spec.initContainers[0].env')" ] \
  || fail "demo-reset and the install hook migrate initContainer have different env names"
# The operator's secret (SECRET_KEY et al.) must reach BOTH containers of BOTH seed pods.
# settings.prod's import-time boot guards abort a container that lacks it, so a reset pod
# that dropped envFrom would crash on its first run, hours after a green install. Section 2
# only inspects the api Deployment, so nothing else covered the seed pods (the hook
# included), and the env-NAME comparison above cannot see envFrom.
rc_es="$(reset_doc --set 'envFrom[0].secretRef.name=struct-secret')"
job_es="$(helm template trueppm "$CHART" "${demo_args[@]}" --set 'envFrom[0].secretRef.name=struct-secret' --show-only templates/demo-seed-job.yaml)"
for which in initContainers containers; do
  [ "$(yq "[.spec.jobTemplate.spec.template.spec.${which}[0].envFrom[].secretRef.name] | contains([\"struct-secret\"])" <<<"$rc_es")" = "true" ] \
    || fail "demo-reset ${which}[0] does not envFrom the operator secret — it would abort at the settings.prod boot guard on its first scheduled run"
  [ "$(yq "[.spec.template.spec.${which}[0].envFrom[].secretRef.name] | contains([\"struct-secret\"])" <<<"$job_es")" = "true" ] \
    || fail "demo-seed hook ${which}[0] does not envFrom the operator secret"
done
if sed 's/#.*//' <<<"$rc" | grep -qE -- '--with-personas|create_admin'; then
  fail "demo-reset carries --with-personas or create_admin in command position — that gives the public demo a login-capable account (#2773, #3187)"
fi

# N+7.d — the schedule is interpolated into the spec, so it is validated, not trusted.
for bad in 'x; rm -rf /' '*/5 * * *' 'every 6 hours' '0 */6 * * * *'; do
  if helm template trueppm "$CHART" "${demo_args[@]}" --set demo.reset.enabled=true \
       --set-string "demo.reset.schedule=$bad" >/dev/null 2>&1; then
    fail "demo.reset.schedule '$bad' rendered — it must be a five-field cron expression or an @-macro"
  fi
done
for good in '@daily' '30 3 * * MON' '*/15 * * * *'; do
  helm template trueppm "$CHART" "${demo_args[@]}" --set demo.reset.enabled=true \
    --set-string "demo.reset.schedule=$good" >/dev/null 2>&1 \
    || fail "demo.reset.schedule '$good' was rejected — it is a valid cron expression"
done

# N+7.e — a failed or never-running reset is observable (alerts opt-in, like backup).
#         TruePPMDemoResetFailed must NOT be built on kube_job_failed: failed Jobs are
#         retained (failedJobsHistoryLimit) and a later success does not prune them, so
#         that expression keeps firing after the demo has recovered.
rules() { helm template trueppm "$CHART" "${demo_args[@]}" --set alerts.enabled=true "$@" --show-only templates/prometheusrule.yaml; }
failed_rule="$(rules --set demo.reset.enabled=true | yq 'select(.kind=="PrometheusRule") | .spec.groups[] | select(.name=="trueppm.demo") | .rules[] | select(.alert=="TruePPMDemoResetFailed") | .expr')"
grep -q 'kube_cronjob_status_last_schedule_time' <<<"$failed_rule" \
  || fail "TruePPMDemoResetFailed does not compare last_schedule_time with last_successful_time: '$failed_rule'"
if grep -q 'kube_job_failed' <<<"$failed_rule"; then
  fail "TruePPMDemoResetFailed is built on kube_job_failed, which never clears after a transient failure while the failed Job is retained"
fi
# Rendered once into variables and matched with here-strings: `grep -q` exits on its
# first hit, so behind a pipe it can SIGPIPE the renderer under pipefail.
rules_on="$(rules --set demo.reset.enabled=true)"
rules_off="$(rules)"
for a in TruePPMDemoResetFailed TruePPMDemoResetStale TruePPMDemoResetNeverSucceeded; do
  grep -q "alert: $a" <<<"$rules_on" \
    || fail "alerts.enabled with demo.reset.enabled did not render $a — a broken reset would be silent"
  if grep -q "alert: $a" <<<"$rules_off"; then
    fail "$a rendered while demo.reset.enabled is false — the reset alerts must follow the reset switch"
  fi
done

# N+7.f. Interactive demo edge hardening (ADR-1197 D1/D6/D7, #3925 MR 2): the third
#        nginx server block, the api/celery-worker egress-deny NetworkPolicy, the
#        throttle re-aims, and the no-writable-media-path guard. The share-link demo's
#        render must stay byte-identical, which is the whole point of D1's "a third
#        block, never a widened allowlist" — asserted here, not just claimed in prose.
interactive_args=(--set image.tag=latest --set demo.interactive=true
  --set demo.loginHint.username=struct-visitor --set demo.loginHint.password=StructCheck1Pw)
cm() { helm template trueppm "$CHART" "$@" --show-only templates/web/configmap.yaml; }

cm_default="$(cm --set image.tag=latest)"
cm_interactive="$(cm "${interactive_args[@]}")"
cm_sharelink="$(cm --set image.tag=latest --set demo.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=struct-schedule --set demo.shareToken.board=struct-board \
  --set networkPolicy.ingressControllerConfirmed=true)"

grep -q 'limit_except GET HEAD OPTIONS' <<<"$cm_interactive" \
  || fail "demo.interactive=true did not render the method fence (limit_except GET HEAD OPTIONS) in the web ConfigMap"
if grep -q 'limit_except' <<<"$cm_default"; then
  fail "a DEFAULT render (demo.interactive=false) contains limit_except — the method fence must not leak into the production block"
fi
if grep -q 'limit_except' <<<"$cm_sharelink"; then
  fail "demo.enabled=true (WITHOUT demo.interactive) rendered the method fence — the two switches must stay independent, and the share-link demo's block must render exactly as it always did"
fi
for auth_path in '/api/v1/auth/token/' '/api/v1/auth/token/refresh/' '/api/v1/auth/logout/'; do
  grep -q "location = $auth_path" <<<"$cm_interactive" \
    || fail "demo.interactive=true's method fence has no exact-match carve-out for $auth_path — sign-in would be refused by the edge before it ever reaches DemoReadOnlyMiddleware"
done
# `grep -A2 ... | grep -q` would SIGPIPE the first grep under pipefail (#3942) —
# capture into a variable first, then grep the here-string.
admin_block="$(grep -A2 'location /admin/ {' <<<"$cm_interactive")"
[ -n "$admin_block" ] && grep -q 'return 404' <<<"$admin_block" \
  || fail "demo.interactive=true does not 404 /admin/ at the edge"
ws_block="$(grep -A2 'location /ws/ {' <<<"$cm_interactive")"
[ -n "$ws_block" ] && grep -q 'return 404' <<<"$ws_block" \
  || fail "demo.interactive=true does not 404 /ws/ at the edge — this mode's only broadcasts are the scheduled reset's"

# The share-link demo's own rendered block must be BYTE-IDENTICAL whether or not
# this MR's changes exist — D1's stated reason for a third block, not a patch.
cm_sharelink_default_switch="$(cm --set image.tag=latest --set demo.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=struct-schedule --set demo.shareToken.board=struct-board \
  --set networkPolicy.ingressControllerConfirmed=true \
  --set demo.interactive=false)"
[ "$cm_sharelink" = "$cm_sharelink_default_switch" ] \
  || fail "the share-link demo's rendered ConfigMap changed depending on demo.interactive's value while demo.interactive is false in both cases — it must be inert"

np_default="$(helm template trueppm "$CHART" --set image.tag=latest --show-only templates/networkpolicy.yaml)"
np_interactive="$(helm template trueppm "$CHART" "${interactive_args[@]}" --show-only templates/networkpolicy.yaml)"
if grep -qE 'egress-demo' <<<"$np_default"; then
  fail "a DEFAULT render produced a demo egress NetworkPolicy — it must not exist unless demo.interactive is true"
fi
for kind_name in "trueppm-api-egress-demo" "trueppm-celery-worker-egress-demo"; do
  grep -q "name: $kind_name" <<<"$np_interactive" \
    || fail "demo.interactive=true did not render NetworkPolicy '$kind_name'"
done
# Select and extract in ONE yq call, same as np_components above and for the
# same reason (#3147): piping select()'s output into a SECOND yq invocation
# re-parses a stream that may carry a blank-line-or-'---' artifact per skipped
# document, and a bare `[ "$x" = "api" ]` against that multi-line result fails
# even though the chart is correct. Strip whatever separator style survives.
np_api_egress_component="$(yq 'select(.kind=="NetworkPolicy" and .metadata.name=="trueppm-api-egress-demo") | .spec.podSelector.matchLabels."app.kubernetes.io/component"' <<<"$np_interactive" \
  | awk '{ gsub(/[[:space:]]/, "", $0); if ($0 != "" && $0 != "---") print }')"
[ "$np_api_egress_component" = "api" ] \
  || fail "trueppm-api-egress-demo does not select component=api"
egress_ports="$(yq 'select(.kind=="NetworkPolicy" and .metadata.name=="trueppm-api-egress-demo") | [.spec.egress[].ports[]? | .port] | join(",")' <<<"$np_interactive" \
  | awk '{ gsub(/[[:space:]]/, "", $0); if ($0 != "" && $0 != "---") print }')"
grep -q '53' <<<"$egress_ports" || fail "the demo api egress policy has no DNS (53) rule — Service names would stop resolving"
grep -q '5432' <<<"$egress_ports" || fail "the demo api egress policy has no PostgreSQL (5432) rule"
grep -q '6379' <<<"$egress_ports" || fail "the demo api egress policy has no Valkey (6379) rule"

# TRUEPPM_DEMO_READ_ONLY lockstep (#3925), same shape as N+2's media-claim check
# above and for the same reason: settings.prod's attachment-storage boot guard
# (#775) now accepts writes_disabled=DEMO_READ_ONLY as proof no request can reach
# storage, and EVERY container that imports settings.prod evaluates that guard at
# import time — not just the api container that actually serves HTTP through
# DemoReadOnlyMiddleware. This exact drift happened during the fix: only the api
# container's main process got the env var; migrate/bootstrap/collectstatic (api
# Deployment init containers) and celery-worker/celery-beat (which import
# settings.prod on every boot even though they never serve a request) did not,
# and the helm:netpol drill's demo.interactive step — not this script — is what
# caught it, because nothing here asserted per-container propagation.
#
# Scoped like the media check: every container/initContainer in the
# demo.interactive render except */web (nginx imports no Django settings).
DEMO_RO_RENDER="$(helm template trueppm "$CHART" "${interactive_args[@]}" \
  --set persistence.media.enabled=false 2>&1)" \
  || fail "chart failed to render with demo.interactive=true (#3925)"
demo_ro_report="$(echo "$DEMO_RO_RENDER" | yq eval-all '
  select(.kind == "Deployment") as $d
  | $d.metadata.name as $n
  | ($d.spec.template.spec.initContainers // []) + $d.spec.template.spec.containers
  | .[]
  | ($n + "/" + .name)
    + " env=" + (([.env[]? | select(.name == "TRUEPPM_DEMO_READ_ONLY") | .value] | .[0]) // "-")
' - | grep ' env=')"
[ -n "$demo_ro_report" ] || fail "no containers found in the demo.interactive render (#3925)"

demo_ro_checked=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  ro_name="${line%% env=*}"
  ro_env="${line##* env=}"
  case "$ro_name" in
    */web) continue ;;   # nginx imports no Django settings and needs neither
  esac
  demo_ro_checked=$((demo_ro_checked + 1))
  [ "$ro_env" = "true" ] \
    || fail "$ro_name has no TRUEPPM_DEMO_READ_ONLY under demo.interactive=true — it imports settings.prod and will crash-loop on the attachment-storage boot guard's writes_disabled=false path (#775, #3925)"
done <<EOF
$demo_ro_report
EOF
[ "$demo_ro_checked" -gt 0 ] || fail "TRUEPPM_DEMO_READ_ONLY propagation check inspected no containers (#3925)"

# TRUEPPM_DEMO_LOGIN_HINT must be exactly "username:password" (#3925). Nothing
# rendering-side ever checked its VALUE, only whether a login hint was set at all
# (interactive_args above sets one purely to clear trueppm.demoGuards) — so a prior
# version of trueppm.demoLoginHint could (and did) join the pair with " / " instead
# of ":" and still render clean. parse_demo_login_hint (core/demo_read_only.py)
# splits on the first colon and raises ImproperlyConfigured on anything else,
# refusing to boot — so the mismatch was only ever caught by an actual pod trying to
# start, which is exactly what scripts/helm-netpol-drill.sh does and this script does
# not. This assertion is what would have caught it here instead.
login_hint_val="$(yq '.spec.template.spec.containers[0].env[] | select(.name == "TRUEPPM_DEMO_LOGIN_HINT") | .value' <<<"$DEMO_RO_RENDER")"
[ "$login_hint_val" = "struct-visitor:StructCheck1Pw" ] \
  || fail "TRUEPPM_DEMO_LOGIN_HINT rendered '$login_hint_val', expected 'struct-visitor:StructCheck1Pw' — parse_demo_login_hint requires exactly username:password and refuses to boot on anything else (#3925)"

# demo.throttle.userRate must be what the api container actually gets (#3998).
# values.yaml's env block ALSO sets TRUEPPM_THROTTLE_USER_RATE as a chart default,
# and the demo value used to sit behind `not (hasKey .Values.env ...)` — always
# false — so it never rendered and the demo ran at the ordinary 1000/min while the
# values file and docs described a raised limit. Assert exactly one entry, with the
# demo value, on every container of the api Deployment.
demo_user_rate="$(yq '.demo.throttle.userRate' "$CHART/values.yaml")"
api_user_rates="$(yq eval-all 'select(.kind == "Deployment" and .metadata.name == "trueppm-api")
  | .spec.template.spec.containers[]
  | "rates=" + ([.env[]? | select(.name == "TRUEPPM_THROTTLE_USER_RATE") | .value] | join(","))' - <<<"$DEMO_RO_RENDER" \
  | grep '^rates=' | sed 's/^rates=//')"
grep -q . <<<"$api_user_rates" || fail "no api container found in the demo.interactive render (#3998)"
while IFS= read -r rates; do
  [ "$rates" = "$demo_user_rate" ] \
    || fail "api container TRUEPPM_THROTTLE_USER_RATE rendered '$rates' under demo.interactive=true, expected exactly one entry '$demo_user_rate' from demo.throttle.userRate (#3998)"
done <<EOF
$api_user_rates
EOF

# Guards: refuse to render rather than silently misconfigure (trueppm.demoGuards).
if helm template trueppm "$CHART" "${interactive_args[@]}" --set persistence.media.enabled=true >/dev/null 2>&1; then
  fail "demo.interactive=true rendered successfully with persistence.media.enabled=true — this mode must give the api pod NO writable media path"
fi
if helm template trueppm "$CHART" "${interactive_args[@]}" --set postgresql.enabled=false >/dev/null 2>&1; then
  fail "demo.interactive=true rendered successfully with postgresql.enabled=false and networkPolicy.enabled left at its true default — the demo egress policy has no rule for a managed datastore and would cut the api/worker pods off from it"
fi

# N+8. Every workload carries the pod-level fsGroup that makes a PVC writable (#3935).
#      persistence.media and backup.persistence are real CSI volumes, and most
#      dynamic provisioners hand back root:root 0755 — uid 1000 with no fsGroup gets
#      EACCES at first write, a crash-loop that names no permission. emptyDir-only
#      pods never notice, so nothing else fails when the key is dropped. Assert it on
#      every workload kind that renders .Values.podSecurityContext, with both PVCs on
#      so the pods that actually mount them are in the render.
fsg_render="$(helm template trueppm "$CHART" "${demo_args[@]}" \
  --set persistence.media.enabled=true --set persistence.media.accessMode=ReadWriteMany \
  --set backup.enabled=true --set backup.persistence.enabled=true \
  --set demo.reset.enabled=true \
  --set 'envFrom[0].secretRef.name=trueppm-env-probe' --set web.enabled=true)"
fsg_bad="$(yq 'select(.kind=="Deployment" or .kind=="CronJob" or .kind=="Job") |
  {"name": .metadata.name,
   "fs": (.spec.template.spec.securityContext.fsGroup // .spec.jobTemplate.spec.template.spec.securityContext.fsGroup)}
  | select(.fs != 1000) | .name' <<<"$fsg_render")"
[ -z "$fsg_bad" ] \
  || fail "workload(s) without podSecurityContext.fsGroup=1000, so a PVC provisioned root:root is unwritable (#3935): $fsg_bad"
fsg_checked="$(yq 'select(.kind=="Deployment" or .kind=="CronJob" or .kind=="Job") | .metadata.name' <<<"$fsg_render" | grep -c .)"
[ "$fsg_checked" -ge 7 ] \
  || fail "fsGroup check saw only $fsg_checked workloads (expected api, web, worker, beat, backup, demo-seed, demo-reset); the render lost a workload"
fsg_test_pod="$(helm template trueppm "$CHART" --set image.tag=latest --show-only templates/tests/api-connection.yaml \
  | yq '.spec.securityContext.fsGroup')"
grep -qx 1000 <<<"$fsg_test_pod" \
  || fail "the helm test pod lacks podSecurityContext.fsGroup=1000"
# fsGroup: null must still delete the key — that is the OpenShift restricted-v2 escape
# hatch (a fixed fsGroup outside the namespace range fails admission).
fsg_null_check="$(helm template trueppm "$CHART" --set image.tag=latest --set podSecurityContext.fsGroup=null \
     --show-only templates/api/deployment.yaml | yq '.spec.template.spec.securityContext')"
if grep -q fsGroup <<<"$fsg_null_check"; then
  fail "podSecurityContext.fsGroup=null did not remove fsGroup — the OpenShift restricted-v2 override is broken"
fi

# N+9. No rendered manifest invokes bare `manage.py migrate` (#3188, #3933). The api
#      Deployment's init container deliberately runs migrate_locked — a session-level
#      PostgreSQL advisory lock around `migrate` — because concurrent unserialized
#      `migrate` runs against one database race each other into a duplicate-key error,
#      a lock timeout, or a partially-applied DDL sequence (migrate_locked.py's own
#      docstring). The demo-seed install hook shipped a bare `migrate` in its own init
#      container (#3933): Helm fires post-install/post-upgrade hooks without waiting for
#      the api Deployment to become Ready, so the two init containers start at
#      essentially the same wall-clock moment and reintroduce the exact race
#      migrate_locked exists to eliminate, on every demo install AND every demo upgrade.
#      Checked by a word-boundary match on "migrate" in the joined command line, not
#      array `contains` — yq/jq `contains` does per-element SUBSTRING matching, so
#      `contains(["migrate"])` is true against `["...", "migrate_locked"]` too and
#      would fail on every legitimate init container this chart ships (caught by the
#      negative control below: it false-failed the unmodified chart on first write).
#      Runs across every Deployment/Job/CronJob container and init container, on BOTH
#      the default and the demo render — a future workload that copies the old
#      demo-seed pattern must fail here too, not just the one path this issue found.
assert_no_bare_migrate() { # <label> <full multi-doc render>
  local label="$1" full="$2" bad
  bad="$(yq 'select(.kind=="Deployment" or .kind=="Job" or .kind=="CronJob") |
    .metadata.name as $w |
    (.spec.template.spec // .spec.jobTemplate.spec.template.spec) |
    ([.initContainers[]?] + [.containers[]?])[] |
    select(((.command // []) | join(" ")) | test("(^| )migrate( |$)")) |
    $w + "/" + .name' <<<"$full" | grep -vE '^(---)?$' || true)"
  [ -z "$bad" ] \
    || fail "$label: container(s) invoke bare 'manage.py migrate' instead of migrate_locked (#3188, #3933): $bad"
}
assert_no_bare_migrate "default install" \
  "$(helm template trueppm "$CHART" --set image.tag=latest --set 'envFrom[0].secretRef.name=trueppm-env-probe')"
assert_no_bare_migrate "demo install" \
  "$(helm template trueppm "$CHART" "${demo_args[@]}" --set demo.reset.enabled=true)"

# N+10. The valkey subchart carries the same PDB / priorityClassName /
#       terminationGracePeriodSeconds knobs as its structural sibling postgresql
#       (#3934). Before this, `packages/helm/charts/valkey/templates/` had no
#       pdb.yaml at all, so a `kubectl drain` silently evicted the single-replica
#       Valkey pod — which is load-bearing for the Channels layer, the Celery
#       broker, the cache backend, AND notification throttles at once — instead
#       of blocking visibly the way the postgresql drain does. maxUnavailable: 0
#       is asserted explicitly: it is the whole point (see charts/valkey/pdb.yaml),
#       not merely "a PDB exists".
valkey_pdb_render="$(helm template trueppm "$CHART" --set image.tag=latest)"
valkey_pdb="$(echo "$valkey_pdb_render" | yq eval 'select(.kind == "PodDisruptionBudget" and .metadata.name == "trueppm-valkey-primary")' -)"
[ -n "$valkey_pdb" ] && [ "$valkey_pdb" != "null" ] \
  || fail "no PodDisruptionBudget for the bundled valkey pod on a default render — a drain would silently take Channels/Celery/cache/throttles down together (#3934)"
valkey_pdb_max="$(echo "$valkey_pdb" | yq eval '.spec.maxUnavailable' -)"
[ "$valkey_pdb_max" = "0" ] \
  || fail "valkey PodDisruptionBudget maxUnavailable is '$valkey_pdb_max', expected 0 — a single-replica PDB that isn't maxUnavailable:0 doesn't block the drain it exists to surface (#3934)"

# The PDB must also come OFF when disabled — a template `{{- if }}` that never
# actually gates would look identical on the enabled-by-default render above.
valkey_pdb_disabled="$(helm template trueppm "$CHART" --set image.tag=latest --set valkey.podDisruptionBudget.enabled=false \
  | yq eval 'select(.kind == "PodDisruptionBudget" and .metadata.name == "trueppm-valkey-primary")' -)"
[ -z "$valkey_pdb_disabled" ] || [ "$valkey_pdb_disabled" = "null" ] \
  || fail "valkey.podDisruptionBudget.enabled=false still rendered a PodDisruptionBudget for valkey (#3934)"

# priorityClassName and terminationGracePeriodSeconds must reach the rendered
# StatefulSet, the same contract N+4 asserts for the app-tier Deployments.
valkey_place_render="$(helm template trueppm "$CHART" --set image.tag=latest \
  --set valkey.priorityClassName=high --set valkey.terminationGracePeriodSeconds=45 \
  --show-only charts/valkey/templates/statefulset.yaml)"
valkey_prio="$(echo "$valkey_place_render" | yq eval '.spec.template.spec.priorityClassName' -)"
[ "$valkey_prio" = "high" ] \
  || fail "valkey.priorityClassName does not reach the rendered StatefulSet pod spec (#3934): got '$valkey_prio'"
valkey_grace="$(echo "$valkey_place_render" | yq eval '.spec.template.spec.terminationGracePeriodSeconds' -)"
[ "$valkey_grace" = "45" ] \
  || fail "valkey.terminationGracePeriodSeconds does not reach the rendered StatefulSet pod spec (#3934): got '$valkey_grace'"

# 13. NOTES.txt must warn on a split-origin deploy with no CSRF_TRUSTED_ORIGINS
#     (#3945). CSRF_TRUSTED_ORIGINS is read by the API at settings/base.py:310
#     and is required whenever TRUEPPM_FRONTEND_BASE_URL and
#     TRUEPPM_PUBLIC_API_BASE_URL name different origins — the split-origin
#     Ingress (app.example.com + api.example.com) an operator is most likely to
#     build. Without it, SSO login completes and sets the refresh cookie, and
#     then the SPA's post-login refresh request 403s with a CSRF failure, after
#     the hard part (the IdP redirect) already worked.
#
#     Probed the same way as trueppm.bootGuardNotice and
#     trueppm.portForwardHostNotice above: rendered offline through a
#     throwaway probe template in the same scratch chart, because
#     `helm install --dry-run` needs a reachable cluster this job does not have.
grep -q 'trueppm.csrfOriginNotice' "$CHART/templates/NOTES.txt" \
  || fail "NOTES.txt does not include the trueppm.csrfOriginNotice helper — a split-origin deploy with no CSRF_TRUSTED_ORIGINS gets no warning before SSO 403s (#3945)"

cat > "$PROBE_DIR/chart/templates/zz-csrf-notice-probe.yaml" <<'CSRFPROBE'
apiVersion: v1
kind: ConfigMap
metadata:
  name: csrf-notice-probe
data:
  notice: |
{{ include "trueppm.csrfOriginNotice" . | indent 4 }}
CSRFPROBE

csrf_notice() {
  helm template trueppm "$PROBE_DIR/chart" --set image.tag=latest "$@" \
    --show-only templates/zz-csrf-notice-probe.yaml 2>&1
}

# Same-origin (the chart default, and the common single-Ingress topology): silent.
if grep -q 'CSRF_TRUSTED_ORIGINS' <<<"$(csrf_notice)"; then
  fail "the CSRF-origin notice fires with both base-URL keys unset — a notice on the DEFAULT render is a notice nobody reads (#3945)"
fi
if grep -q 'CSRF_TRUSTED_ORIGINS' <<<"$(csrf_notice \
    --set env.TRUEPPM_FRONTEND_BASE_URL=https://trueppm.example.com \
    --set env.TRUEPPM_PUBLIC_API_BASE_URL=https://trueppm.example.com)"; then
  fail "the CSRF-origin notice fires when both base URLs are the SAME origin — same-origin Ingress never needs CSRF_TRUSTED_ORIGINS (#3945)"
fi

# Split origin, CSRF_TRUSTED_ORIGINS unset: must fire, and must name both keys.
csrf_split_notice="$(csrf_notice \
  --set env.TRUEPPM_FRONTEND_BASE_URL=https://app.example.com \
  --set env.TRUEPPM_PUBLIC_API_BASE_URL=https://api.example.com)"
grep -q 'TRUEPPM_FRONTEND_BASE_URL' <<<"$csrf_split_notice" \
  || fail "the CSRF-origin notice on a split-origin deploy does not name TRUEPPM_FRONTEND_BASE_URL (#3945)"
grep -q 'CSRF_TRUSTED_ORIGINS' <<<"$csrf_split_notice" \
  || fail "the CSRF-origin notice on a split-origin deploy does not name CSRF_TRUSTED_ORIGINS — the operator is not told which key fixes the coming SSO 403 (#3945)"

# Split origin, CSRF_TRUSTED_ORIGINS SET: the warning must go away.
if grep -q 'CSRF_TRUSTED_ORIGINS' <<<"$(csrf_notice \
    --set env.TRUEPPM_FRONTEND_BASE_URL=https://app.example.com \
    --set env.TRUEPPM_PUBLIC_API_BASE_URL=https://api.example.com \
    --set env.CSRF_TRUSTED_ORIGINS=https://app.example.com)"; then
  fail "the CSRF-origin notice still fires on a split-origin deploy once env.CSRF_TRUSTED_ORIGINS is set (#3945)"
fi

# 14. App-tier ingress policies: upgrade transition guard, distro peer, monitoring
#     peer (#4000, #4001).
#
#     #3850's api/web default-deny policies admit only the ingress-controller peer.
#     Left at its default (an ingress-nginx namespace), an upgrade on k3s/RKE2 —
#     whose controllers run in kube-system under an enforcing CNI — took a working
#     site offline with every pod still Ready. And the in-cluster health scrapes
#     the observability docs prescribe were dropped, so the dead-letter and beat
#     alerts went silent rather than red.
np_ingress() { # <policy name> [extra helm args...]
  local name="$1"; shift
  helm template trueppm "$CHART" "$@" --show-only templates/networkpolicy.yaml \
    | yq "select(.metadata.name == \"$name\") | .spec.ingress[0].from" -o json | tr -d ' \n'
}

# The helper's copy of the default must equal values.yaml's, or "left at the
# default" silently stops meaning anything and both behaviors below switch off.
tpl_default="$(sed -n '/define "trueppm.defaultIngressControllerSelectorJson"/{n;p;}' "$CHART/templates/_helpers.tpl")"
values_default="$(yq -o json -I0 '.networkPolicy.ingressControllerSelector' "$CHART/values.yaml")"
[ "$(yq -p json -o json -I0 'sort_keys(..)' <<<"$tpl_default")" = "$(yq -p json -o json -I0 'sort_keys(..)' <<<"$values_default")" ] \
  || fail "trueppm.defaultIngressControllerSelectorJson ($tpl_default) no longer matches values.yaml's networkPolicy.ingressControllerSelector ($values_default) (#4000)"

# 14a. The guard fires on an upgrade with the default selector (`helm template`
#      leaves lookup empty, i.e. "no api-ingress policy exists yet" — the
#      first-introduction case), and names the fix.
guard_err="$(helm template trueppm "$CHART" --is-upgrade 2>&1 >/dev/null || true)"
grep -q 'networkPolicy.ingressControllerConfirmed=true' <<<"$guard_err" \
  || fail "an upgrade introducing the app-tier ingress policies on the default selector rendered without refusing, or refused without naming networkPolicy.ingressControllerConfirmed (#4000). Output: $guard_err"
helm template trueppm "$CHART" >/dev/null \
  || fail "a fresh install (not an upgrade) tripped the NetworkPolicy transition guard (#4000)"
helm template trueppm "$CHART" --is-upgrade --set networkPolicy.ingressControllerConfirmed=true >/dev/null \
  || fail "networkPolicy.ingressControllerConfirmed=true did not satisfy the transition guard (#4000)"
helm template trueppm "$CHART" --is-upgrade --set networkPolicy.enabled=false >/dev/null \
  || fail "networkPolicy.enabled=false still tripped the transition guard (#4000)"
helm template trueppm "$CHART" --is-upgrade \
  --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}},"podSelector":{}}' >/dev/null \
  || fail "an explicit non-default ingressControllerSelector still tripped the transition guard (#4000)"

# 14b. The peer is rendered verbatim, so an ipBlock (cloud LB) is expressible —
#      the old template hardcoded namespaceSelector/podSelector keys.
got="$(np_ingress trueppm-web-ingress \
  --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":null,"podSelector":null,"ipBlock":{"cidr":"10.0.0.0/8"}}')"
[ "$got" = '[{"ipBlock":{"cidr":"10.0.0.0/8"}}]' ] \
  || fail "an ipBlock ingressControllerSelector rendered web-ingress 'from' as $got (#4000)"

# 14c. An empty selector would render a peerless `from:`, which Kubernetes reads
#      as allow-from-anywhere. It must refuse instead.
if helm template trueppm "$CHART" \
    --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":null,"podSelector":null}' >/dev/null 2>&1; then
  fail "an empty ingressControllerSelector rendered — a peerless 'from' admits every source (#4000)"
fi

# 14d. k3s/RKE2 with the default selector also admit kube-system. `helm template
#      --kube-version` strips the +k3s1 build suffix a live cluster reports, so
#      substitute the version string in a probe copy of the chart instead.
distro_from() { # <kube version string> [extra helm args...]
  local kv="$1"; shift
  rm -rf "$PROBE_DIR/distro" && cp -R "$CHART" "$PROBE_DIR/distro"
  sed -i.bak "s/\$kv := .Capabilities.KubeVersion.Version/\$kv := \"$kv\"/" "$PROBE_DIR/distro/templates/_helpers.tpl"
  grep -q "\$kv := \"$kv\"" "$PROBE_DIR/distro/templates/_helpers.tpl" \
    || fail "structure-check could not substitute the kube version into the probe chart — the distro-peer assertion would be vacuous"
  helm template trueppm "$PROBE_DIR/distro" "$@" --show-only templates/networkpolicy.yaml \
    | yq 'select(.metadata.name == "trueppm-web-ingress") | .spec.ingress[0].from' -o json | tr -d ' \n'
}
ks='{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}}}'
for kv in v1.30.4+k3s1 v1.30.4+rke2r1; do
  grep -qF "$ks" <<<"$(distro_from "$kv")" \
    || fail "web-ingress on $kv with the default selector does not admit kube-system, where the distribution runs its bundled controller (#4000)"
done
if grep -qF "$ks" <<<"$(distro_from v1.30.4)"; then
  fail "web-ingress admits kube-system on a non-k3s/RKE2 cluster (#4000)"
fi
if grep -qF "$ks" <<<"$(distro_from v1.30.4+k3s1 --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"traefik"}},"podSelector":{}}')"; then
  fail "web-ingress still adds kube-system on k3s after the operator set their own selector (#4000)"
fi

# 14e. monitoringSelector reaches the api policy only, and adds nothing when empty.
mon='{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"monitoring"}}}'
grep -qF "$mon" <<<"$(np_ingress trueppm-api-ingress --set-json "networkPolicy.monitoringSelector=$mon")" \
  || fail "networkPolicy.monitoringSelector does not reach the api-ingress policy — health scrapes and the beat Blackbox probe stay dropped (#4001)"
if grep -qF "$mon" <<<"$(np_ingress trueppm-web-ingress --set-json "networkPolicy.monitoringSelector=$mon")"; then
  fail "networkPolicy.monitoringSelector widened the web-ingress policy; nothing scrapes the web pod (#4001)"
fi
[ "$(np_ingress trueppm-api-ingress | yq -p json length)" = 3 ] \
  || fail "api-ingress admits $(np_ingress trueppm-api-ingress | yq -p json length) peers with monitoringSelector empty, expected 3 (web, test, ingress controller) (#4001)"

# 14f. The share-link demo's helm test hook curls the WEB Service, so web-ingress
#      must admit the chart's `test` pod exactly when that hook renders —
#      otherwise an enforcing CNI drops the probe and `helm test` hangs (#4018).
web_test_rules() { # [extra helm args...] -> count of web-ingress rules admitting component=test
  helm template trueppm "$CHART" "$@" --show-only templates/networkpolicy.yaml \
    | yq 'select(.metadata.name == "trueppm-web-ingress") | .spec.ingress[].from[] | select(.podSelector.matchLabels."app.kubernetes.io/component" == "test") | .podSelector.matchLabels."app.kubernetes.io/component"' \
    | grep -c '^test$' || true
}
share_demo=(-f "$CHART/values-demo.yaml" --set demo.baseUrl=https://demo.example.com
  --set demo.shareToken.schedule=structurecheckschedule --set demo.shareToken.board=structurecheckboard
  --set networkPolicy.ingressControllerConfirmed=true)
[ "$(web_test_rules "${share_demo[@]}")" = 1 ] \
  || fail "share-link demo: web-ingress does not admit the helm test pod, so templates/tests/demo-share-links.yaml cannot reach the web Service (#4018)"
[ "$(web_test_rules)" = 0 ] \
  || fail "a non-demo install admits the helm test pod to web-ingress; only the share-link demo hook needs it (#4018)"
[ "$(web_test_rules "${share_demo[@]}" --set demo.interactive=true \
  --set demo.loginHint.username=atlas-visitor --set demo.loginHint.password=struct-pass)" = 1 ] \
  || fail "interactive demo: web-ingress does not admit the helm test pod, so templates/tests/demo-read-only.yaml cannot reach the web Service (#4053)"

# 14g. web's nginx forwards `Host $host`, so the hook must send a Host that is
#      already in ALLOWED_HOSTS — demo.baseUrl's — or Django 400s it (#4018).
hook="$(helm template trueppm "$CHART" "${share_demo[@]}" --set demo.baseUrl=https://share.probe.example:8443 \
  --show-only templates/tests/demo-share-links.yaml)"
grep -qF 'public_host="share.probe.example:8443"' <<<"$hook" \
  || fail "the share-link helm test hook does not derive its Host from demo.baseUrl (#4018)"
[ "$(grep -cF -- '-H "Host: ${public_host}"' <<<"$hook")" = 2 ] \
  || fail "the share-link helm test hook does not send demo.baseUrl's host on BOTH share probes — the web Service name reaches Django and 400s DisallowedHost (#4018)"

# 15. Fresh-install (and upgrade) guard for the two documented exposure paths
#     that bypass any in-cluster ingress controller entirely: the demo's
#     Cloudflare Tunnel (values-demo.yaml's EXPOSURE block, ADR-0658 D9) and a
#     LoadBalancer/NodePort web Service (#4003).
#
#     Unlike section 14's guard, this one has no `lookup`-based "first
#     introduction" check to skip on later renders — there is no PRIOR policy to
#     compare against on a brand-new demo install, so the #4000 guard (upgrade
#     only, and only when no api-ingress policy exists yet) never sees this
#     case at all. Every assertion below uses a plain (non-upgrade) `helm
#     template` unless noted, which is the harder case: it proves the render
#     refuses even with no "transition" to detect.
demo_np_args=(-f "$CHART/values-demo.yaml" --set demo.baseUrl=https://demo.example.com
  --set demo.shareToken.schedule=ci-schedule-token --set demo.shareToken.board=ci-board-token)

# 15a. A stock default install (no demo, no LB/NodePort, no Ingress) must stay
#      exactly as friction-free as before this issue — this is the fast path
#      the guard must never touch.
helm template trueppm "$CHART" >/dev/null \
  || fail "a stock default install (ClusterIP + port-forward, no demo) tripped the #4003 exposure guard — it must never fire on the chart's own default rendering"

# 15b. demo.enabled with the untouched default selector refuses on a FRESH
#      install, and names the tunnel case specifically — not just "an ingress
#      controller".
demo_err="$(helm template trueppm "$CHART" "${demo_np_args[@]}" 2>&1 >/dev/null || true)"
grep -q '(#4003)' <<<"$demo_err" \
  || fail "demo.enabled with the default networkPolicy.ingressControllerSelector rendered on a fresh install, or refused for an unrelated reason (#4003). Output: $demo_err"
grep -qi 'tunnel' <<<"$demo_err" \
  || fail "the demo exposure guard's refusal does not name the tunnel case (#4003). Output: $demo_err"

# 15c. The SAME misconfiguration on an upgrade also refuses — this guard has no
#      once-only lookup gate, unlike section 14's.
helm template trueppm "$CHART" "${demo_np_args[@]}" --is-upgrade >/dev/null 2>&1 \
  && fail "demo.enabled with the default selector rendered on an upgrade — the #4003 guard must fire on install AND upgrade, it has no first-introduction lookup to skip on"

# 15d. ingressControllerConfirmed=true satisfies it.
helm template trueppm "$CHART" "${demo_np_args[@]}" --set networkPolicy.ingressControllerConfirmed=true >/dev/null \
  || fail "demo.enabled did not render with networkPolicy.ingressControllerConfirmed=true (#4003)"

# 15e. Pointing the EXISTING ingressControllerSelector key at the tunnel's own
#      namespace also satisfies it — no second values key was added; the same
#      selector already feeds both the api and web ingress policies.
helm template trueppm "$CHART" "${demo_np_args[@]}" \
  --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"cloudflared"}},"podSelector":{}}' >/dev/null \
  || fail "demo.enabled did not render once ingressControllerSelector named the tunnel's namespace (#4003)"

# 15f. demo.enabled with ingress.enabled=true must NOT trip THIS guard — an
#      Ingress-fronted release has a real controller-selector story, so this
#      case is out of scope for it (it still refuses, but for the pre-existing
#      #3908 reason, asserted earlier in this file).
ingress_demo_err="$(helm template trueppm "$CHART" "${demo_np_args[@]}" --set ingress.enabled=true 2>&1 >/dev/null || true)"
if grep -q '(#4003)' <<<"$ingress_demo_err"; then
  fail "demo.enabled with ingress.enabled=true tripped the #4003 exposure guard — it must be scoped to ingress.enabled=false, an Ingress-fronted release is covered by the #4000 upgrade guard instead"
fi

# 15g/h. web.service.type LoadBalancer and NodePort each refuse on a fresh
#        install with no Ingress and the default selector, and name the
#        service type in the message.
for wt in LoadBalancer NodePort; do
  wt_err="$(helm template trueppm "$CHART" --set image.tag=latest --set web.service.type="$wt" 2>&1 >/dev/null || true)"
  grep -q '(#4003)' <<<"$wt_err" \
    || fail "web.service.type=$wt with the default selector rendered, or refused for an unrelated reason (#4003). Output: $wt_err"
  grep -q "$wt" <<<"$wt_err" \
    || fail "the web-exposure guard's refusal for web.service.type=$wt does not name the service type (#4003). Output: $wt_err"
done

# 15i. ingressControllerConfirmed=true also satisfies the LoadBalancer/NodePort
#      case.
helm template trueppm "$CHART" --set image.tag=latest --set web.service.type=LoadBalancer \
  --set networkPolicy.ingressControllerConfirmed=true >/dev/null \
  || fail "web.service.type=LoadBalancer did not render with networkPolicy.ingressControllerConfirmed=true (#4003)"

# 15j. An ipBlock peer (the shape a cloud load balancer or a set of node
#      addresses needs) also satisfies it, reusing the same selector key the
#      #4000 guard's ipBlock case already proves works for the ingress
#      controller peer (section 14b).
helm template trueppm "$CHART" --set image.tag=latest --set web.service.type=NodePort \
  --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":null,"podSelector":null,"ipBlock":{"cidr":"10.0.0.0/8"}}' >/dev/null \
  || fail "web.service.type=NodePort did not render with an ipBlock ingressControllerSelector (#4003)"

# 15k. The top-level (API) service.type is a DIFFERENT knob from web.service.type
#      and must not be read by this guard — demo.enabled already refuses a
#      non-ClusterIP API Service on its own (templates/api/service.yaml,
#      #3908), and that refusal must fire, not this one, when only the API
#      Service is widened.
api_lb_err="$(helm template trueppm "$CHART" "${demo_np_args[@]}" --set service.type=LoadBalancer 2>&1 >/dev/null || true)"
grep -q 'API Service must stay ClusterIP' <<<"$api_lb_err" \
  || fail "demo.enabled with a LoadBalancer API (not web) Service did not refuse with the #3908 message — got: $api_lb_err"

# 15l. networkPolicy.enabled=false is always an escape hatch, same as section 14.
helm template trueppm "$CHART" "${demo_np_args[@]}" --set networkPolicy.enabled=false >/dev/null \
  || fail "demo.enabled with networkPolicy.enabled=false still tripped the #4003 exposure guard"

# 16. Interactive demo edge refusal is JSON, not nginx's stock HTML 403 (#4053).
#     The web app recognizes a demo refusal by status AND body code, so the fenced
#     /api/ location must route its 403 to an internal named location returning the
#     middleware's body. Share-link and production blocks must not carry it.
grep -q 'error_page 403 @demo_read_only;' <<<"$cm_interactive" \
  || fail "demo.interactive=true's /api/ fence has no 'error_page 403 @demo_read_only;' — refused writes would return nginx's stock HTML 403 and the web app would never see demo_read_only (#4053)"
grep -q 'location @demo_read_only {' <<<"$cm_interactive" \
  || fail "demo.interactive=true renders no internal @demo_read_only location (#4053)"
grep -q '"code": "demo_read_only"' <<<"$cm_interactive" \
  || fail "the @demo_read_only location does not return the demo_read_only code (#4053)"
for other_name in default sharelink; do
  other_var="cm_$other_name"
  if grep -q 'demo_read_only' <<<"${!other_var}"; then
    fail "the $other_name web ConfigMap mentions demo_read_only — the edge refusal must exist only in the interactive block (#4053)"
  fi
done

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
echo "  - Chart.yaml version and appVersion equal the release version $API_MANIFEST_VERSION (release.sh bumps them with the other manifests)"

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
echo "  - celery probes: worker liveness ${cp_live_i}/${cp_live_p}x${cp_live_f} (detection ${cp_detect}s >= ${cp_grace}s grace, still 'inspect ping') and readiness ${cp_ready_i}/${cp_ready_p} (heartbeat-file freshness, #3346) are tuned apart; startup is the heartbeat-file existence check; kubelet timeout scales with the ping budget on liveness; flat keys still drive all three probes; beat is liveness-only"
echo "  - api.workers=1 by default (image CMD behavior preserved), api.workers=4 renders --workers 4 without disturbing --host/--port, and 0 is refused (#3833)"
echo "  - demo reset: CronJob absent unless demo.enabled AND demo.reset.enabled; Forbid + deadlines + demo-seed label; same command and env as the install hook; schedule validated; three alerts follow the switch"
echo "  - interactive demo edge hardening: method fence + auth carve-outs + /admin/ /ws/ 404 only under demo.interactive; share-link demo's block stays byte-identical; api/celery-worker egress-demo NetworkPolicy scoped to DNS+datastores only; media-path and managed-datastore guards refuse to render; TRUEPPM_DEMO_READ_ONLY reaches all $demo_ro_checked settings.prod-importing containers, not just api"
echo "  - podSecurityContext.fsGroup=1000 on all $fsg_checked workloads plus the helm test pod (PVC writable under a root:root CSI volume); fsGroup: null still removes it for OpenShift"
echo "  - no Deployment/Job/CronJob container invokes bare 'manage.py migrate' — every migrate call goes through migrate_locked (#3188, #3933)"
echo "  - valkey has a PDB (maxUnavailable: 0, gated by valkey.podDisruptionBudget.enabled) and priorityClassName/terminationGracePeriodSeconds reach its StatefulSet, matching postgresql (#3934)"
echo "  - NOTES.txt warns on a split-origin deploy (differing TRUEPPM_FRONTEND_BASE_URL/TRUEPPM_PUBLIC_API_BASE_URL) with no CSRF_TRUSTED_ORIGINS, and stays quiet when same-origin or once it is set (#3945)"
echo "  - app-tier ingress NetworkPolicy: an upgrade that first introduces it refuses to render on the unconfirmed default selector; the peer renders verbatim (ipBlock works) and never empty; k3s/RKE2 also admit kube-system only while the selector is the default; monitoringSelector widens api only (#4000, #4001)"
echo "  - demo/LoadBalancer/NodePort web exposure with no Ingress and the default ingressControllerSelector refuses on install AND upgrade, names the tunnel or the service type, and is satisfied by ingressControllerConfirmed=true or a non-default selector (ipBlock included); a stock default install and an Ingress-fronted demo are untouched; the API (not web) Service LoadBalancer case still raises the #3908 message (#4003)"
echo "  - interactive demo edge: the fenced /api/ 403 routes to an internal @demo_read_only location returning the middleware JSON body; share-link and production ConfigMaps carry none of it (#4053)"
