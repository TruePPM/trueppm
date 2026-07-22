#!/usr/bin/env bash
# Helm chart deploy smoke test on a real (kind) cluster (#2279).
#
# This is the runtime half of the §2.4 beta-QA check that `helm lint` /
# `helm template` / scripts/helm-structure-check.sh cannot reach: it actually
# BOOTS the chart and proves
#   1. images pull and every workload rolls out (`helm install --wait`);
#   2. the migrate -> bootstrap(create_admin) init sequence completes and the api
#      answers /readyz (`helm test`, templates/tests/api-connection.yaml);
#   3. the one-time admin password lands in the shared emptyDir and is retrievable
#      (`kubectl exec <api-pod> -- cat <passwordFile>`);
#   4. the settings.prod boot guards fail CLOSED — a deploy missing SECRET_KEY
#      does not start (negative probe).
#
# KNOWN LIMITATION: there is no per-commit deployable image (the api/web images
# are built only in the tag-triggered publish stage), so this drills the CHART
# against the last released image tag ($RELEASE_IMAGE_TAG), not branch/main HEAD
# application code. See #2279.
#
# Expects a working Docker daemon (dind in CI) and helm, kind, kubectl, docker on
# PATH. Registry auth via $CI_REGISTRY{,_USER,_PASSWORD} (set by GitLab CI).
set -euo pipefail

CHART="${CHART:-packages/helm}"
CLUSTER="${CLUSTER:-trueppm-drill}"
RELEASE="${RELEASE:-trueppm}"
REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
IMAGE_REPO="${IMAGE_REPO:-${REGISTRY}/trueppm/trueppm}"
RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-latest}"
# Host:port the kubeconfig points at from OUTSIDE the dind daemon. In CI the dind
# service is reachable as `docker`; locally kind's own 127.0.0.1 mapping is used.
APISERVER_HOST="${APISERVER_HOST:-docker}"
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-8m}"

API_IMAGE="${IMAGE_REPO}/api:${RELEASE_IMAGE_TAG}"
WEB_IMAGE="${IMAGE_REPO}/web:${RELEASE_IMAGE_TAG}"

log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- diagnostics on any failure -------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (deploy did not reach a healthy state) ========" >&2
  kubectl get pods -A -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo "---- non-Running pods: describe + logs ----" >&2
  for p in $(kubectl get pods -o name 2>/dev/null); do
    phase="$(kubectl get "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [ "$phase" != "Running" ] && [ "$phase" != "Succeeded" ]; then
      echo "---- describe $p ----" >&2
      kubectl describe "$p" 2>&1 | sed 's/^/  /' >&2 || true
      echo "---- logs $p (all containers, incl. init) ----" >&2
      kubectl logs "$p" --all-containers --prefix --tail=80 2>&1 | sed 's/^/  /' >&2 || true
    fi
  done
}

cleanup() { log "deleting kind cluster '$CLUSTER'"; kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; }
on_exit() {
  local rc=$?
  [ "$rc" -ne 0 ] && dump_diagnostics
  cleanup
  exit "$rc"
}
trap on_exit EXIT

# ---- 1. cluster ------------------------------------------------------------
# apiServerAddress 0.0.0.0 + a pinned port + a `docker` cert SAN is the standard
# kind-in-dind recipe: the API server is published on the dind host and the
# kubeconfig (rewritten below) reaches it over the CI network as `docker:6443`
# with a valid TLS SAN.
log "creating kind cluster '$CLUSTER'"
cat >/tmp/kind-config.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: "0.0.0.0"
  apiServerPort: 6443
kubeadmConfigPatches:
  - |
    kind: ClusterConfiguration
    apiServer:
      certSANs:
        - "${APISERVER_HOST}"
        - localhost
        - 127.0.0.1
EOF
kind create cluster --name "$CLUSTER" --config /tmp/kind-config.yaml --wait 120s

# Repoint kubeconfig at the dind-reachable host when running in CI (the generated
# server is https://0.0.0.0:6443, unroutable from the job container).
if [ "$APISERVER_HOST" != "127.0.0.1" ] && [ "$APISERVER_HOST" != "localhost" ]; then
  kubectl config set-cluster "kind-${CLUSTER}" --server="https://${APISERVER_HOST}:6443"
fi
kubectl cluster-info
kubectl wait --for=condition=Ready nodes --all --timeout=90s

# ---- 2. preload the (private) app images ----------------------------------
# kind nodes can't authenticate to the private registry; pull with the job's
# creds and side-load so pullPolicy=IfNotPresent finds them locally. Public
# subchart images (postgres/valkey) and curl pull normally.
if [ -n "${CI_REGISTRY_PASSWORD:-}" ]; then
  log "docker login ${REGISTRY}"
  echo "${CI_REGISTRY_PASSWORD}" | docker login -u "${CI_REGISTRY_USER}" --password-stdin "${REGISTRY}"
fi
for img in "$API_IMAGE" "$WEB_IMAGE"; do
  log "pull + load $img"
  docker pull "$img"
  kind load docker-image "$img" --name "$CLUSTER"
done

# ---- 3. the required operator secret ---------------------------------------
# The three secrets settings.prod refuses to boot without (#566/#1002) plus the
# local-storage opt-in (#775). The bundled-postgres DB escape hatch
# (TRUEPPM_ALLOW_UNENCRYPTED_DB) is auto-injected by the chart because
# postgresql.enabled && networkPolicy.enabled (chart defaults), so it is NOT set
# here — proving that default path boots.
secret_key="$(head -c 50 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 60)"
integration_key="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_')"
log "creating trueppm-env secret"
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY="$secret_key" \
  --from-literal=ALLOWED_HOSTS='*' \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

# ---- 4. install + wait for full rollout ------------------------------------
log "helm install ${RELEASE} (image tag ${RELEASE_IMAGE_TAG})"
helm install "$RELEASE" "$CHART" \
  --set image.tag="$RELEASE_IMAGE_TAG" \
  --set 'envFrom[0].secretRef.name=trueppm-env' \
  --wait --timeout "$INSTALL_TIMEOUT"
log "rollout complete"
kubectl get pods -o wide

# ---- 5. helm test: api booted end to end (readyz reachable) ----------------
log "helm test ${RELEASE}"
helm test "$RELEASE" --timeout 3m

# ---- 6. admin password retrievable from the shared emptyDir ----------------
api_pod="$(kubectl get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
# Chart default admin.passwordFile; overridable via $ADMIN_PASSWORD_FILE.
pw_file="${ADMIN_PASSWORD_FILE:-/run/trueppm/admin_password}"
log "reading admin password from ${api_pod}:${pw_file}"
admin_pw="$(kubectl exec "$api_pod" -c api -- cat "$pw_file" 2>/dev/null || true)"
[ -n "$admin_pw" ] || fail "admin password file '$pw_file' empty/absent — create_admin did not write it"
log "admin password present (${#admin_pw} chars) — bootstrap wrote the shared emptyDir"

# ---- 7. negative probe: boot guard fails closed without SECRET_KEY ----------
# settings.prod reads SECRET_KEY (import-time, no default) BEFORE it ever touches
# DATABASE_URL/REDIS_URL, so the pod fails on the missing key without a database
# in reach — no connection strings needed here. It must exit non-zero rather than
# start with an insecure default.
log "negative probe: api image without SECRET_KEY must refuse to start"
kubectl run secret-guard-probe \
  --image="$API_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --env=DJANGO_SETTINGS_MODULE=trueppm_api.settings.prod \
  --env=ALLOWED_HOSTS='*' \
  --env=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --env=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true \
  --command -- python manage.py migrate --noinput
# The pod runs to completion (Never restart); wait for a terminal phase.
kubectl wait --for=jsonpath='{.status.phase}'=Failed pod/secret-guard-probe --timeout=90s \
  || fail "secret-guard probe did not FAIL — the boot guard may not be fail-closed"
probe_log="$(kubectl logs secret-guard-probe 2>&1 || true)"
echo "$probe_log" | grep -qi "SECRET_KEY" \
  || fail "probe failed but not on SECRET_KEY; log tail: $(echo "$probe_log" | tail -3)"
log "negative probe GREEN — deploy without SECRET_KEY refuses to start"

log "HELM INSTALL DRILL GREEN — chart boots, admin retrievable, guards fail closed"
