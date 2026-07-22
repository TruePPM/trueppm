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

echo "helm structure check GREEN:"
echo "  - init order: migrate -> bootstrap"
echo "  - operator envFrom secret reaches migrate, bootstrap, and api"
echo "  - shared admin-password emptyDir mounted by bootstrap ($boot_mount) and api ($api_mount)"
echo "  - web nginx proxies to release-scoped trueppm-api (baked compose 'api' host overridden)"
