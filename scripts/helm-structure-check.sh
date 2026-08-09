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
set -euo pipefail

CHART="${1:-packages/helm}"
# A representative operator secret name so we can assert it propagates everywhere
# it must. The name is arbitrary; only the wiring is asserted.
ENV_SECRET="trueppm-env-probe"

fail() { echo "FAIL: $*" >&2; exit 1; }

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
#    must reach BOTH init containers AND the api container: settings.prod's
#    import-time boot guards (#1002, #775, #1550) crash-loop migrate and bootstrap
#    too, not just the long-running app — so a secret wired only to the app would
#    still fail the deploy at the migrate step.
for path in \
  '.spec.template.spec.initContainers[0]' \
  '.spec.template.spec.initContainers[1]' \
  '.spec.template.spec.containers[0]'; do
  name="$(echo "$DEP" | yq "${path}.name")"
  found="$(echo "$DEP" | yq "[${path}.envFrom[].secretRef.name] | contains([\"${ENV_SECRET}\"])")"
  [ "$found" = "true" ] || fail "container '$name' does not envFrom secret '${ENV_SECRET}'"
done

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
NP_ALL="$(helm template trueppm "$CHART" \
  --set image.tag=latest \
  --set backup.enabled=true \
  --set demo.enabled=true \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule=structurecheckschedule \
  --set demo.shareToken.board=structurecheckboard)"

np_split="$(mktemp -d)"
trap 'rm -rf "$np_split"' EXIT
# shellcheck disable=SC2016  # $index is a yq expression variable, not a shell one
echo "$NP_ALL" | (cd "$np_split" && yq -s '"doc_" + $index' >/dev/null)

# The rendered allow-lists, as comma-wrapped strings for substring matching.
# `select()` over a multi-document stream emits a blank line per non-matching
# document, so squeeze ALL whitespace out before wrapping — otherwise the list
# reads ",\napi,celery-worker,…" and the ",api," substring test never matches.
np_components() {
  echo "$NP_ALL" \
    | yq "select(.kind == \"NetworkPolicy\" and (.metadata.name | test(\"$1\$\"))) | [.spec.ingress[].from[].podSelector.matchLabels[\"app.kubernetes.io/component\"]] | join(\",\")" \
    | tr -d '[:space:]'
}
pg_allowed=",$(np_components postgresql),"
vk_allowed=",$(np_components valkey),"
[ "$pg_allowed" != ",," ] || fail "could not read the postgresql NetworkPolicy ingress allow-list"
[ "$vk_allowed" != ",," ] || fail "could not read the valkey NetworkPolicy ingress allow-list"

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
      case "$pg_allowed" in
        *",$comp,"*) np_checked=$((np_checked + 1)) ;;
        *) fail "$kind/$wl_name (component '$comp') receives DATABASE_URL but is NOT in the postgresql NetworkPolicy ingress allow-list (${pg_allowed}) — its connections are dropped on an enforcing CNI. Add it in templates/networkpolicy.yaml." ;;
      esac
      ;;
  esac
  case ",$urls," in
    *,REDIS_URL,*)
      [ -n "$comp" ] || fail "$kind/$wl_name receives REDIS_URL but carries no app.kubernetes.io/component label"
      case "$vk_allowed" in
        *",$comp,"*) np_checked=$((np_checked + 1)) ;;
        *) fail "$kind/$wl_name (component '$comp') receives REDIS_URL but is NOT in the valkey NetworkPolicy ingress allow-list (${vk_allowed}) — its connections are dropped on an enforcing CNI. Add it in templates/networkpolicy.yaml." ;;
      esac
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

# 9. NOTES.txt must warn when NO app-env source is configured (#2812).
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
trap 'rm -rf "$np_split" "$PROBE_DIR"' EXIT
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

echo "helm structure check GREEN:"
echo "  - init order: migrate -> bootstrap"
echo "  - operator envFrom secret reaches migrate, bootstrap, and api"
echo "  - shared admin-password emptyDir mounted by bootstrap ($boot_mount) and api ($api_mount)"
echo "  - web nginx proxies to release-scoped trueppm-api (baked compose 'api' host overridden)"
echo "  - all $np_checked datastore-client bindings are covered by the NetworkPolicy allow-lists"
echo "  - production nginx /admin/ fails closed (deny all + limit_req; allow precedes deny)"
echo "  - celery worker pins --concurrency=$wc_n and honors concurrency/extraArgs overrides"
echo "  - NOTES.txt names all four boot-guard keys on a bare install, and stays quiet once they are configured"
