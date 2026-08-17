#!/usr/bin/env bash
# Datastore NetworkPolicy ENFORCEMENT drill on a Calico kind cluster (#2560).
#
# Why this exists separately from scripts/helm-install-drill.sh:
#
# `networkPolicy.enabled` defaults to true and is the chart's headline datastore
# isolation control — the bundled PostgreSQL and Valkey speak plaintext on the pod
# network, so the policy is what restricts 5432/6379 to the app tiers. The chart
# even auto-injects TRUEPPM_ALLOW_UNENCRYPTED_DB *because*
# `postgresql.enabled && networkPolicy.enabled`, i.e. it weakens the app's
# unencrypted-DB boot guard on the strength of that isolation.
#
# Nothing verified the isolation. `helm:template` proves the object RENDERS.
# `helm:install` boots the chart on kind — but kind's default CNI (kindnetd) does
# not implement NetworkPolicy, by design, so the API objects are admitted and
# silently ignored. A policy that selected the wrong pods, named a wrong port, or
# omitted a legitimate client would have passed every gate. #2560 found exactly
# that: the `backup` CronJob and `demo-seed` Job were missing from the ingress
# allow-list, so their PostgreSQL connections were being dropped under a real CNI.
#
# So this drill creates its OWN cluster with the default CNI disabled and Calico
# installed, then asserts behavior rather than rendering:
#
#   1. POSITIVE  — the api/worker/beat tiers reach 5432 and 6379 (an
#      over-restrictive policy fails here). The rollout reaching Ready is itself
#      part of this: /readyz checks both the database and the cache.
#   2. POSITIVE  — a `component: backup` pod reaches 5432 (the #2560 regression).
#   3. NEGATIVE  — a pod with NO chart labels is denied both ports.
#   4. NEGATIVE  — a pod with the chart labels but a non-client component
#      (`web`) is denied both ports, proving the allow-list is component-scoped
#      and not satisfied by name/instance alone.
#   5. EGRESS    — a datastore pod cannot dial out (default-deny egress).
#   6. CONTROL   — with the policy REMOVED, probe 3 succeeds. Without this, a
#      cluster that silently dropped all pod traffic for an unrelated reason
#      would look like a passing drill.
#
# How a verdict is measured, and why the two directions are not symmetric: a CNI
# denies by DROPPING the packet, so "denied" can only ever be inferred from silence
# — no connection within PROBE_TIMEOUT. Silence is therefore trustworthy evidence
# of a drop only after the connection has been given a fair chance, which is why
# every probe expecting ALLOWED is retried (PROBE_ALLOW_ATTEMPTS) and every probe
# expecting DENIED is single-shot. See #2647.
#
# Expects a working Docker daemon (dind in CI) and helm, kind, kubectl, docker on
# PATH. Registry auth via $CI_REGISTRY{,_USER,_PASSWORD} (set by GitLab CI).
set -euo pipefail

CHART="${CHART:-packages/helm}"
CLUSTER="${CLUSTER:-trueppm-netpol}"
RELEASE="${RELEASE:-trueppm}"
REGISTRY="${CI_REGISTRY:-registry.gitlab.com}"
IMAGE_REPO="${IMAGE_REPO:-${REGISTRY}/trueppm/trueppm}"
RELEASE_IMAGE_TAG="${RELEASE_IMAGE_TAG:-latest}"
APISERVER_HOST="${APISERVER_HOST:-docker}"
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-8m}"
CALICO_VERSION="${CALICO_VERSION:-v3.32.1}"
# Probe image: busybox carries `nc`, which reports a dropped SYN as a timeout
# (exit != 0) and an accepted connection as exit 0 — exactly the discrimination
# these probes need.
PROBE_IMAGE="${PROBE_IMAGE:-busybox:1.37}"
# Seconds nc waits before declaring the port unreachable. A DROPPED packet (which
# is how a CNI denies) only manifests as a timeout, so this doubles as the "denied"
# detection latency. Keep it short: every NEGATIVE probe pays it in full on every
# run, which is why the cure for a slow-but-allowed connection is the retry below
# and NOT a longer timeout.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-6}"
# Attempts allowed to a probe that EXPECTS to connect, before it is called denied
# (#2647).
#
# A DENIED verdict is the absence of a completed connection within PROBE_TIMEOUT —
# never a positive observation of a drop. That makes the measurement asymmetric:
#
#   * A false DENIED needs only a slow connection. A pod scheduled seconds ago may
#     still be waiting on Calico to program its policy, or on a CoreDNS answer for
#     the Service name; either lands past the timeout and reads as a denial.
#   * A false ALLOWED would need a genuinely dropped packet to complete a
#     handshake, which cannot happen.
#
# So only positive probes can flake, and retrying them cannot mask a real denial:
# a policy that actually blocks the port fails all the attempts. Negative probes
# stay single-shot — their timeout IS the measurement, and retrying them would add
# PROBE_TIMEOUT to every run to re-observe a drop that was never in doubt.
PROBE_ALLOW_ATTEMPTS="${PROBE_ALLOW_ATTEMPTS:-3}"
PROBE_RETRY_DELAY="${PROBE_RETRY_DELAY:-3}"

API_IMAGE="${IMAGE_REPO}/api:${RELEASE_IMAGE_TAG}"
WEB_IMAGE="${IMAGE_REPO}/web:${RELEASE_IMAGE_TAG}"

log() { echo "==> $*"; }
# Progress emitted from inside a `$(...)` capture. It MUST go to stderr: the
# probe helpers below echo their verdict on stdout, so a `log` there would be
# captured as part of the verdict string and silently corrupt the comparison.
note() { echo "==> $*" >&2; }
fail() { echo "FAIL: $*" >&2; exit 1; }

PG_SVC=""
VK_SVC=""

dump_diagnostics() {
  echo "======== DIAGNOSTICS (netpol drill did not reach a healthy state) ========" >&2
  kubectl get pods -A -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo "---- NetworkPolicies as admitted ----" >&2
  kubectl get networkpolicy -o yaml 2>&1 | sed 's/^/  /' >&2 || true
  echo "---- calico-node status ----" >&2
  kubectl -n kube-system get pods -l k8s-app=calico-node -o wide 2>&1 | sed 's/^/  /' >&2 || true
  for p in $(kubectl get pods -o name 2>/dev/null); do
    ready="$(kubectl get "$p" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    phase="$(kubectl get "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [ "$phase" != "Succeeded" ] && [ "$ready" != "True" ]; then
      echo "---- describe $p ----" >&2
      kubectl describe "$p" 2>&1 | sed 's/^/  /' >&2 || true
      echo "---- logs $p ----" >&2
      kubectl logs "$p" --all-containers --prefix --tail=60 2>&1 | sed 's/^/  /' >&2 || true
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

# ---- 1. cluster with NO default CNI ----------------------------------------
# disableDefaultCNI drops kindnetd; podSubnet is set to Calico's own default
# IPv4 pool (192.168.0.0/16) so the stock manifest needs no CIDR override.
log "creating kind cluster '$CLUSTER' (default CNI disabled)"
cat >/tmp/kind-netpol-config.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: "0.0.0.0"
  apiServerPort: 6443
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
kubeadmConfigPatches:
  - |
    kind: ClusterConfiguration
    apiServer:
      certSANs:
        - "${APISERVER_HOST}"
        - localhost
        - 127.0.0.1
EOF
# No --wait: without a CNI, nodes stay NotReady until Calico is installed, so
# waiting for node readiness here would always time out.
kind create cluster --name "$CLUSTER" --config /tmp/kind-netpol-config.yaml

if [ "$APISERVER_HOST" != "127.0.0.1" ] && [ "$APISERVER_HOST" != "localhost" ]; then
  kubectl config set-cluster "kind-${CLUSTER}" --server="https://${APISERVER_HOST}:6443"
fi
kubectl cluster-info

# ---- 2. install an ENFORCING CNI -------------------------------------------
log "installing Calico ${CALICO_VERSION}"
# kubectl apply -f <url> has no retry of its own, so a single transient GitHub
# rate-limit (429) or network blip fails the whole drill. raw.githubusercontent.com
# can also throttle a source IP for MINUTES, not seconds (#1989) — long enough that
# retrying the same host is not reliably survivable, so a fetch failure falls back
# to jsdelivr, which mirrors GitHub repos through separate CDN infrastructure and
# resolves the same tag.
CALICO_MANIFEST_URL="https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
CALICO_MANIFEST_MIRROR_URL="https://cdn.jsdelivr.net/gh/projectcalico/calico@${CALICO_VERSION}/manifests/calico.yaml"
if ! curl --fail -sSL --retry 5 --retry-delay 2 --retry-all-errors \
  -o /tmp/calico.yaml "$CALICO_MANIFEST_URL"; then
  log "fetching Calico manifest from raw.githubusercontent.com failed after retries, falling back to jsdelivr mirror"
  curl --fail -sSL --retry 5 --retry-delay 2 --retry-all-errors \
    -o /tmp/calico.yaml "$CALICO_MANIFEST_MIRROR_URL"
fi
kubectl apply -f /tmp/calico.yaml
log "waiting for calico-node to be ready"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=5m \
  || fail "calico-node did not become ready — no enforcing CNI, drill cannot prove anything"
kubectl wait --for=condition=Ready nodes --all --timeout=3m \
  || fail "nodes did not become Ready after Calico install"
kubectl -n kube-system rollout status deployment/coredns --timeout=3m \
  || fail "coredns did not recover after the CNI swap"

# Guard against the silent-no-op this whole drill exists to prevent: if the
# cluster somehow came up on a non-enforcing CNI, every negative probe below
# would "pass" for the wrong reason.
if kubectl -n kube-system get daemonset kindnet >/dev/null 2>&1; then
  fail "kindnetd is present — disableDefaultCNI did not take effect, enforcement would be a no-op"
fi

# ---- 3. required operator secret + install ----------------------------------
# Same secret set as the install drill. TRUEPPM_ALLOW_UNENCRYPTED_DB is
# deliberately NOT set: the chart auto-injects it because
# postgresql.enabled && networkPolicy.enabled, and this drill is what earns that.
secret_key="$(head -c 50 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 60)"
integration_key="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_')"
log "creating trueppm-env secret"
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY="$secret_key" \
  --from-literal=ALLOWED_HOSTS='*' \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

if [ -n "${CI_REGISTRY_PASSWORD:-}" ]; then
  log "docker login ${REGISTRY}"
  echo "${CI_REGISTRY_PASSWORD}" | docker login -u "${CI_REGISTRY_USER}" --password-stdin "${REGISTRY}"
fi
for img in "$API_IMAGE" "$WEB_IMAGE" "$PROBE_IMAGE"; do
  log "pull + load $img"
  docker pull "$img"
  kind load docker-image "$img" --name "$CLUSTER"
done

log "helm install ${RELEASE} with networkPolicy.enabled=true"
helm install "$RELEASE" "$CHART" \
  --set image.tag="$RELEASE_IMAGE_TAG" \
  --set networkPolicy.enabled=true \
  --set 'envFrom[0].secretRef.name=trueppm-env' \
  --wait --timeout "$INSTALL_TIMEOUT"
log "rollout complete under an enforcing CNI"
kubectl get pods -o wide
kubectl get networkpolicy

# The policies must actually exist — a values regression that flipped the default
# off would otherwise make every negative probe below fail for the wrong reason.
PG_SVC="$(kubectl get svc -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
VK_SVC="$(kubectl get svc -l app.kubernetes.io/name=valkey -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[ -n "$PG_SVC" ] || fail "no postgresql Service found"
[ -n "$VK_SVC" ] || fail "no valkey Service found"
kubectl get networkpolicy "${RELEASE}-postgresql" >/dev/null 2>&1 \
  || fail "NetworkPolicy ${RELEASE}-postgresql absent — is networkPolicy.enabled still defaulting true?"
kubectl get networkpolicy "${RELEASE}-valkey" >/dev/null 2>&1 \
  || fail "NetworkPolicy ${RELEASE}-valkey absent"

# ---- probe helper ----------------------------------------------------------
# Runs a one-shot busybox pod carrying the given labels and reports whether it
# could open host:port. Echoes "ALLOWED" or "DENIED"; never fails the script
# itself, so callers assert the expectation.
probe() {
  local name="$1" labels="$2" host="$3" port="$4"
  kubectl delete pod "$name" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  local overrides
  overrides="$(printf '{"metadata":{"labels":%s}}' "$labels")"
  if kubectl run "$name" \
      --image="$PROBE_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
      --overrides="$overrides" \
      --attach --rm --quiet \
      --command -- sh -c "nc -w ${PROBE_TIMEOUT} -z ${host} ${port} && echo __OPEN__ || echo __SHUT__" 2>/dev/null \
      | grep -q __OPEN__; then
    echo "ALLOWED"
  else
    echo "DENIED"
  fi
}

# Re-runs `probe` until it connects or the attempt budget is spent, and echoes the
# final verdict. Only ever used where ALLOWED is expected — see PROBE_ALLOW_ATTEMPTS
# for why retrying a positive probe is safe and retrying a negative one is not.
#
# A retry that eventually succeeds is REPORTED, not swallowed: a probe that needs a
# second attempt on every run is a cluster degrading toward a real failure, and the
# whole defect this fixes was a measurement that hid its own uncertainty.
probe_until_allowed() {
  local name="$1" labels="$2" host="$3" port="$4"
  local got attempt=1
  while :; do
    got="$(probe "$name" "$labels" "$host" "$port")"
    if [ "$got" = "ALLOWED" ]; then
      if [ "$attempt" -gt 1 ]; then
        note "  ${host}:${port} connected on attempt ${attempt}/${PROBE_ALLOW_ATTEMPTS} — slow, not denied (#2647)"
      fi
      echo "ALLOWED"
      return 0
    fi
    if [ "$attempt" -ge "$PROBE_ALLOW_ATTEMPTS" ]; then
      echo "DENIED"
      return 0
    fi
    note "  ${host}:${port} silent for ${PROBE_TIMEOUT}s (attempt ${attempt}/${PROBE_ALLOW_ATTEMPTS}) — retrying in ${PROBE_RETRY_DELAY}s"
    sleep "$PROBE_RETRY_DELAY"
    attempt=$((attempt + 1))
  done
}

expect_probe() {
  local want="$1" desc="$2" name="$3" labels="$4" host="$5" port="$6"
  local got detail=""
  if [ "$want" = "ALLOWED" ]; then
    got="$(probe_until_allowed "$name" "$labels" "$host" "$port")"
    detail=" after ${PROBE_ALLOW_ATTEMPTS} attempts"
  else
    got="$(probe "$name" "$labels" "$host" "$port")"
  fi
  if [ "$got" != "$want" ]; then
    fail "$desc — expected ${want}, got ${got}${detail} (${host}:${port})"
  fi
  log "OK [${want}] ${desc}"
}

CLIENT_BASE="\"app.kubernetes.io/name\":\"trueppm\",\"app.kubernetes.io/instance\":\"${RELEASE}\""

# ---- 4. CONTROL: an unlabeled pod CAN reach a port with no policy on it -----
# Proves the probe mechanism works and the cluster is not simply dropping
# everything. The web Service has no NetworkPolicy, so it must be reachable.
web_svc="$(kubectl get svc -l app.kubernetes.io/component=web -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [ -n "$web_svc" ]; then
  web_port="$(kubectl get svc "$web_svc" -o jsonpath='{.spec.ports[0].port}')"
  expect_probe ALLOWED "control: unpoliced web Service is reachable (probe mechanism works)" \
    netpol-control '{}' "$web_svc" "$web_port"
fi

# ---- 5. POSITIVE: the real app tiers reach the datastores -------------------
# The rollout above already proves this transitively (/readyz checks database and
# cache), but assert it from inside the api pod so an over-restrictive policy
# names itself here instead of surfacing as a readiness timeout.
api_pod="$(kubectl get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
log "positive probe from the real api pod (${api_pod})"
for target in "${PG_SVC} 5432" "${VK_SVC} 6379"; do
  # shellcheck disable=SC2086
  set -- $target
  host="$1"; port="$2"
  attempt=1
  # Retried on the same rule as probe_until_allowed: this is a positive assertion
  # whose only failure signal is a timeout, so one silent attempt cannot tell an
  # over-restrictive policy from a momentarily slow connection (#2647).
  until kubectl exec "$api_pod" -c api -- python -c "
import socket
socket.create_connection(('${host}', ${port}), timeout=${PROBE_TIMEOUT}).close()
" >/dev/null 2>&1; do
    if [ "$attempt" -ge "$PROBE_ALLOW_ATTEMPTS" ]; then
      fail "api pod could NOT reach ${host}:${port} in ${PROBE_ALLOW_ATTEMPTS} attempts — the policy is over-restrictive"
    fi
    log "  api pod -> ${host}:${port} silent for ${PROBE_TIMEOUT}s (attempt ${attempt}/${PROBE_ALLOW_ATTEMPTS}) — retrying in ${PROBE_RETRY_DELAY}s"
    sleep "$PROBE_RETRY_DELAY"
    attempt=$((attempt + 1))
  done
  log "OK [ALLOWED] api pod -> ${host}:${port}"
done

for component in celery-worker celery-beat; do
  expect_probe ALLOWED "positive: ${component}-labeled pod reaches PostgreSQL" \
    "netpol-pos-${component}" "{${CLIENT_BASE},\"app.kubernetes.io/component\":\"${component}\"}" \
    "$PG_SVC" 5432
done

# ---- 6. POSITIVE: the #2560 regression — backup and demo-seed --------------
# The backup CronJob's pg_dump and the demo-seed Job's migrate both open
# PostgreSQL. Both were absent from the ingress allow-list, so both were dropped
# under a real CNI while every gate stayed green. These two probes are the guard.
expect_probe ALLOWED "positive: backup-labeled pod reaches PostgreSQL (#2560 regression)" \
  netpol-pos-backup "{${CLIENT_BASE},\"app.kubernetes.io/component\":\"backup\"}" \
  "$PG_SVC" 5432
expect_probe ALLOWED "positive: demo-seed-labeled pod reaches PostgreSQL (#2560 regression)" \
  netpol-pos-demoseed "{${CLIENT_BASE},\"app.kubernetes.io/component\":\"demo-seed\"}" \
  "$PG_SVC" 5432

# ---- 7. NEGATIVE: an unlabeled pod is denied both datastores ---------------
expect_probe DENIED "negative: unlabeled pod denied PostgreSQL" \
  netpol-neg-pg '{}' "$PG_SVC" 5432
expect_probe DENIED "negative: unlabeled pod denied Valkey" \
  netpol-neg-vk '{}' "$VK_SVC" 6379

# ---- 8. NEGATIVE: right chart, wrong component ----------------------------
# `web` carries the chart's name/instance labels but is not a datastore client.
# If this is ALLOWED, the allow-list is matching on name/instance alone and the
# component dimension is decorative — a far subtler break than a missing policy.
expect_probe DENIED "negative: web-labeled pod denied PostgreSQL (component scoping holds)" \
  netpol-neg-web-pg "{${CLIENT_BASE},\"app.kubernetes.io/component\":\"web\"}" "$PG_SVC" 5432
expect_probe DENIED "negative: web-labeled pod denied Valkey (component scoping holds)" \
  netpol-neg-web-vk "{${CLIENT_BASE},\"app.kubernetes.io/component\":\"web\"}" "$VK_SVC" 6379

# ---- 9. EGRESS: datastore pods cannot dial out ----------------------------
# `egress: []` with Egress in policyTypes is a default-deny. Probe an in-cluster
# address rather than the internet so a CI job with no external egress cannot
# produce a false pass: the api Service is reachable from any unpoliced pod, so a
# failure here is attributable to the datastore's own egress rule.
api_svc="$(kubectl get svc -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
api_port="$(kubectl get svc "$api_svc" -o jsonpath='{.spec.ports[0].port}')"
expect_probe ALLOWED "control: api Service reachable from an unpoliced pod (egress baseline)" \
  netpol-egress-baseline '{}' "$api_svc" "$api_port"

for ds in postgresql valkey; do
  ds_pod="$(kubectl get pod -l "app.kubernetes.io/name=${ds}" -o jsonpath='{.items[0].metadata.name}')"
  log "egress probe from ${ds} pod (${ds_pod}) -> ${api_svc}:${api_port}"
  # Both datastore images ship bash, so /dev/tcp is available without adding a
  # sidecar. `timeout` bounds a DROPPED SYN, which never returns on its own.
  if kubectl exec "$ds_pod" -- bash -c \
      "timeout ${PROBE_TIMEOUT} bash -c 'echo > /dev/tcp/${api_svc}/${api_port}'" >/dev/null 2>&1; then
    fail "${ds} pod reached ${api_svc}:${api_port} — default-deny EGRESS is not enforced"
  fi
  log "OK [DENIED] ${ds} egress blocked"
done

# ---- 10. CONTROL: removing the policy restores access ---------------------
# The strongest evidence that the DENIED results above were caused by the policy
# and not by an unrelated CNI/DNS quirk: delete it, and the same probe passes.
log "control: deleting the postgresql NetworkPolicy — the denied probe must now pass"
kubectl delete networkpolicy "${RELEASE}-postgresql"
expect_probe ALLOWED "control: unlabeled pod reaches PostgreSQL once the policy is removed" \
  netpol-control-nopolicy '{}' "$PG_SVC" 5432

log "NETPOL DRILL GREEN — datastore isolation is enforced, not merely rendered"
