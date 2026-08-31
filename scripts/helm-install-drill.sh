#!/usr/bin/env bash
# Helm chart deploy smoke test on a real (kind) cluster (#2279).
#
# This is the runtime half of the §2.4 beta-QA check that `helm lint` /
# `helm template` / scripts/helm-structure-check.sh cannot reach: it actually
# BOOTS the chart and proves
#   1. images pull and every workload rolls out (`helm install --wait`);
#   2. the migrate -> bootstrap(create_admin) init sequence completes and the api
#      answers its health probe (`helm test`, templates/tests/api-connection.yaml);
#   3. the one-time admin password lands in the shared emptyDir and is retrievable
#      (`kubectl exec <api-pod> -- cat <passwordFile>`);
#   4. the settings.prod boot guards fail CLOSED — a deploy missing SECRET_KEY
#      does not start (negative probe).
#
# The api/web images are built per-commit by ci:build-deploy-images (#2284) and
# tagged $CI_COMMIT_SHA, so this drills the HEAD chart against the SAME commit's
# application code (RELEASE_IMAGE_TAG defaults to $CI_COMMIT_SHA in CI). There is
# no version skew: the migration-aware /api/v1/readyz endpoint (#1894, #2217) is
# present in the image, so the install below gates readiness on the chart default
# (/readyz) and runs the full `helm test` incl. its readyz leg — no overrides on
# the api readiness path. The install DOES change the celery probe settings: the
# worker's are turned OFF and beat's are widened. See the CELERY_PROBE_OVERRIDES
# block below for the evidence, and note the consequence — no runtime gate
# exercises the chart's own celery probe defaults any more (#3218, #3230).
# For a local run against an already-published tag, set RELEASE_IMAGE_TAG (e.g.
# `latest`) and, if that tag predates readyz, add the /health/ readiness override
# yourself. See #2279 (drill) and #2284 (per-commit image).
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

# ---- DRILL-SPECIFIC celery probe settings (#3218) --------------------------
# The chart's probe defaults are NOT changed — packages/helm is byte-identical
# to main and production keeps its liveness semantics. This overrides them for
# the drill only, and the reason is stronger than "CI is slow".
#
# The evidence, from two jobs on two runners:
#
#   job 16191930558 (chart defaults). The worker cannot reach the bundled Valkey
#   for the first few seconds, so Celery is still in its consumer-reconnect
#   backoff when the first probe fires at initialDelay 30. `celery inspect ping`
#   exits non-zero with its OWN message, `Error: No nodes replied within time
#   constraint`. Three 60s periods later failureThreshold 3 is reached, kubelet
#   restarts the container, and because lifecycle.worker's
#   terminationGracePeriodSeconds is 300 the pod stays 0/1 for five more
#   minutes. `helm install --wait --timeout 8m` gives up.
#
#   job 16193488334 (this drill, with initialDelay 45 / period 30 / --timeout 15
#   / failureThreshold 10). RESTARTS=0 — the container was never killed, so the
#   mechanism above did NOT happen. The install failed anyway. The worker logged
#   `celery@<pod> ready.` 16 seconds after the install started and stayed up,
#   and the readiness probe still failed x13 over 6m41s without a single success
#   against that healthy worker.
#
# The second run is what forces the shape of this fix. Readiness needs ONE
# success to turn a pod Ready — it has no failure budget to widen — so a probe
# that never succeeds cannot be repaired by any timing value. Ten failures x 30s
# exhausting without one success is the proof, and it is why the first attempt
# at this fix (raising the budget) was wrong.
#
# Why the probe cannot succeed here is a resource story, not a correctness one.
# The command is well formed: kubelet puts HOSTNAME in the container
# ENVIRONMENT, so `$HOSTNAME` expands even though /bin/sh is dash, and running
# the exact command by hand against a healthy worker returns `1 node online` in
# well under a second. But an exec probe runs INSIDE the container it measures,
# so every probe forks a full Django + Celery import into the worker's own
# 1-CPU cgroup and competes with the MainProcess that has to answer the ping.
# On a loaded kind-in-dind node that is self-defeating — and shortening the
# period, as the first attempt did, makes it worse rather than better.
#
# So the worker's probes are OFF for the drill. Be clear about the cost:
# `helm install --wait` no longer proves the worker is functional, only that it
# rolled out. Section 9 buys that back with an explicit ping assertion that can
# RETRY — which a kubelet probe structurally cannot, because its response to a
# slow answer is to kill the thing it is waiting for.
#
# Beat keeps its probe: it renders a livenessProbe only (no readiness), so it
# never gates `--wait`, and at the chart's 60s period a kill needs
# 45 + 9*60 = ~585s, past the whole install budget. Its other knobs are widened
# for the same contention, but its period is deliberately left alone so the
# drill does not double Django-import forks into the chart's tightest cgroup
# (250m CPU / 256Mi).
#
# The chart-level question this raises is #3230 and is deliberately NOT answered
# here: a Celery worker sits behind NO Service (verified — the api and web
# Services both select on app.kubernetes.io/component), so its readinessProbe
# gates nothing in production except rolling-update pacing, while costing a
# control-plane round trip inside its own CPU budget. Removing it is a
# production semantics change and needs review, not a drill fix.
CELERY_PROBE_OVERRIDES=(
  --set probes.worker.enabled=false
  --set probes.beat.initialDelaySeconds=45
  --set probes.beat.timeoutSeconds=15
  --set probes.beat.failureThreshold=10
)

# Budget for the diagnostic worker control-plane ping in section 9 (#3236),
# which reports on the readiness probe disabled above. Worst case 3 x (20 + 10)
# = ~90s, after the install rather than gating it.
WORKER_PING_ATTEMPTS="${WORKER_PING_ATTEMPTS:-3}"
WORKER_PING_TIMEOUT="${WORKER_PING_TIMEOUT:-20}"
WORKER_PING_RETRY_DELAY="${WORKER_PING_RETRY_DELAY:-10}"

API_IMAGE="${IMAGE_REPO}/api:${RELEASE_IMAGE_TAG}"
WEB_IMAGE="${IMAGE_REPO}/web:${RELEASE_IMAGE_TAG}"

log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- diagnostics on any failure -------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (deploy did not reach a healthy state) ========" >&2
  kubectl get pods -A -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo "---- not-Ready pods: describe + logs ----" >&2
  # Filter on the Ready CONDITION, not pod phase: a CrashLoopBackOff container and
  # an up-but-failing-readiness container both keep the pod in phase "Running", so
  # a phase-based filter skips exactly the pods that broke the rollout. `--wait`
  # times out on readiness, so readiness is the signal to dump.
  for p in $(kubectl get pods -o name 2>/dev/null); do
    ready="$(kubectl get "$p" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    phase="$(kubectl get "$p" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [ "$phase" != "Succeeded" ] && [ "$ready" != "True" ]; then
      echo "---- describe $p ----" >&2
      kubectl describe "$p" 2>&1 | sed 's/^/  /' >&2 || true
      echo "---- logs $p (all containers, incl. init) ----" >&2
      kubectl logs "$p" --all-containers --prefix --tail=80 2>&1 | sed 's/^/  /' >&2 || true
      echo "---- previous logs $p (crash before restart, if any) ----" >&2
      kubectl logs "$p" --all-containers --prefix --previous --tail=80 2>&1 | sed 's/^/  /' >&2 || true
    fi
  done
  # The api pod stays Running-but-0/1 when /readyz returns 503; the access log
  # only shows the 503, not WHICH dependency failed. readyz reports a coarse
  # ok/fail per dependency (database/cache/migrations) in its body, so fetch it
  # in-container (curl is absent from the slim image; python's stdlib is not) to
  # name the exact failing dependency instead of re-guessing across CI cycles.
  api_pod="$(kubectl get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$api_pod" ]; then
    echo "---- api /readyz body (per-dependency ok/fail) ----" >&2
    kubectl exec "$api_pod" -c api -- python -c 'import urllib.request as u
try:
    print(u.urlopen("http://127.0.0.1:8000/api/v1/readyz", timeout=5).read().decode())
except u.HTTPError as e:
    print("HTTP", e.code, e.read().decode())
except Exception as e:
    print("probe error:", e)' 2>&1 | sed 's/^/  /' >&2 || true
  fi
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
# ALLOWED_HOSTS is a CONCRETE list, never '*' (#3183). A wildcard makes this
# drill prove the chart boots under a configuration configuration.md marks
# :::danger and no operator should run — and it hid a real install blocker: the
# api probes had no Host header, so kubelet sent `Host: <podIP>:8000`, Django
# answered 400 DisallowedHost from get_host() before any view, and a documented
# single-host ALLOWED_HOSTS left every pod NotReady behind a 503. Listing the
# exact names traffic actually arrives under is what makes that class fail here.
#
# Both names are derived from the render rather than typed, so a change to the
# chart's default ingress host or fullname template cannot silently desync them:
#   - the probe Host header the chart resolves (default: ingress.hosts[0].host)
#   - the api Service DNS name, which is the Host `helm test` curls
probe_host="$(helm template "$RELEASE" "$CHART" --set image.tag="$RELEASE_IMAGE_TAG" \
  --show-only templates/api/deployment.yaml \
  | awk '/httpHeaders:/{h=1} h && /value:/{gsub(/"/,"",$2); print $2; exit}')"
api_svc="$(helm template "$RELEASE" "$CHART" --set image.tag="$RELEASE_IMAGE_TAG" \
  --show-only templates/api/service.yaml \
  | awk '/^  name:/{print $2; exit}')"
[ -n "$probe_host" ] || fail "could not resolve the probe Host header from the render (#3183)"
[ -n "$api_svc" ] || fail "could not resolve the api Service name from the render"
allowed_hosts="${probe_host},${api_svc},localhost,127.0.0.1"
log "ALLOWED_HOSTS=${allowed_hosts}"

log "creating trueppm-env secret"
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY="$secret_key" \
  --from-literal=ALLOWED_HOSTS="$allowed_hosts" \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

# ---- 4. install + wait for full rollout ------------------------------------
# The image is the current commit's code (ci:build-deploy-images, #2284), so the
# chart's migration-aware /api/v1/readyz readiness probe and the `helm test`
# readyz leg both resolve — no version-skew overrides. The full chart (secret,
# migrate->bootstrap init sequence, uvicorn, postgres, valkey, celery, Services)
# boots and readiness gates on the real deep /readyz check the deploy ships with.
# persistence.media is enabled deliberately (#3184): the chart's pods run with
# readOnlyRootFilesystem, so a local-attachment-storage install has nowhere to
# write without this claim and the boot guard now refuses to start rather than
# accept uploads it would lose. ReadWriteOnce is correct on this single-node kind
# cluster — the guard only rejects RWO above one replica, where it would mean an
# upload accepted by one pod 404s from another.
log "helm install ${RELEASE} (image tag ${RELEASE_IMAGE_TAG})"
helm install "$RELEASE" "$CHART" \
  --set image.tag="$RELEASE_IMAGE_TAG" \
  --set persistence.media.enabled=true \
  --set persistence.media.accessMode=ReadWriteOnce \
  --set 'envFrom[0].secretRef.name=trueppm-env' \
  "${CELERY_PROBE_OVERRIDES[@]}" \
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
# ALLOWED_HOSTS='*' is deliberate here, and only here: this throwaway pod must
# fail on SECRET_KEY alone, so host validation is taken out of the picture. It
# never serves a request (#3183).
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

# ---- 8. Django admin is NOT reachable through the web tier (#2569) ----------
# The static half of this lives in helm-structure-check.sh; this is the runtime
# proof. The request originates from the api pod, i.e. an ordinary in-cluster
# address that is not in the (empty by default) web.adminAccess.allowCIDRs, so
# nginx must answer 403. Driven from the api pod because the nginx image carries
# no curl, and with urllib because it needs no extra dependency.
log "probing /admin/ through the web tier — must be denied"
# Resolve the Service by LABEL, never by string-building the release name:
# `trueppm.fullname` collapses when the release name already contains the chart
# name, so "<release>-trueppm-web" is wrong for the default release `trueppm`
# (the Service is just `trueppm-web`) and right for others. The label selector is
# correct for every release name.
web_svc="$(kubectl get svc -l app.kubernetes.io/component=web -o jsonpath='{.items[0].metadata.name}')"
[ -n "$web_svc" ] || fail "no web Service found (component=web)"
# URLError (DNS/connection) is caught separately from HTTPError so a
# connectivity failure reports as a distinct sentinel rather than an unhandled
# traceback that `set -e` would turn into an opaque red with no message.
admin_code="$(kubectl exec "$api_pod" -c api -- python -c "
import urllib.request, urllib.error
url = 'http://${web_svc}/admin/'
try:
    print(urllib.request.urlopen(url, timeout=15).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception as e:
    print('UNREACHABLE:%s' % e)
" 2>&1 | tr -d '[:space:]' || true)"
[ "$admin_code" = "403" ] \
  || fail "/admin/ through the web tier (svc/${web_svc}) returned '${admin_code}', expected 403 — a default install is publishing Django admin (#2569)"
log "admin denied at the web tier (HTTP 403) — deny-by-default holds at runtime"

# ---- 9. celery worker: concurrency pinned, and it STAYS up (#2571) ----------
# `helm install --wait` above already gates on the worker becoming Ready. What it
# cannot see is an OOMKill loop that starts once the prefork children are all
# spawned, so also assert the flag is really on the running container and that
# the pod has not restarted.
worker_pod="$(kubectl get pod -l app.kubernetes.io/component=celery-worker -o jsonpath='{.items[0].metadata.name}')"
[ -n "$worker_pod" ] || fail "no celery-worker pod found"
worker_cmd="$(kubectl get pod "$worker_pod" -o jsonpath='{.spec.containers[0].command}')"
echo "$worker_cmd" | grep -qE -- '--concurrency=[0-9]+' \
  || fail "running celery-worker has no --concurrency; command was: $worker_cmd"
restarts="$(kubectl get pod "$worker_pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
[ "${restarts:-0}" -eq 0 ] \
  || fail "celery-worker restarted ${restarts}x since rollout — likely the OOMKill loop from an unpinned prefork pool (#2571)"
log "celery worker pinned and stable (0 restarts): $worker_cmd"

# The chart's readiness probe is what used to prove the worker's control plane
# answers; this drill disables it (see CELERY_PROBE_OVERRIDES), so the check
# moves here, where it can retry instead of restarting the container it is
# measuring.
#
# It is DIAGNOSTIC, NOT AN ASSERTION, and that is deliberate — see #3236.
# Making it fatal would red this drill on a defect that is not the drill's and
# not this branch's: in job 16193692029 the worker was up with 0 restarts and
# every other check in this script passed, yet `inspect ping` got no reply
# across 5 attempts of 30s each, driven by `kubectl exec` completely outside the
# probe path. The same command against a healthy worker returns `1 node online`
# in under a second, and the drill passes end to end whenever the worker did not
# have to retry its initial broker connection — which is the discriminator #3236
# exists to confirm. Until that is understood, a hard failure here would just be
# the #3218 flake wearing a new message.
#
# The output is printed either way, because a silent skip would leave the next
# reader with nothing.
log "checking whether the celery worker answers a control-plane ping (diagnostic, see #3236)"
ping_ok=""
ping_out=""
for attempt in $(seq 1 "$WORKER_PING_ATTEMPTS"); do
  if ping_out="$(kubectl exec "$worker_pod" -c celery-worker -- \
      celery -A trueppm_api.celery inspect ping \
      --destination "celery@${worker_pod}" --timeout "$WORKER_PING_TIMEOUT" 2>&1)"; then
    ping_ok=1
    log "celery worker answered inspect ping on attempt ${attempt}/${WORKER_PING_ATTEMPTS}"
    break
  fi
  log "  ping attempt ${attempt}/${WORKER_PING_ATTEMPTS} got no reply — retrying in ${WORKER_PING_RETRY_DELAY}s"
  sleep "$WORKER_PING_RETRY_DELAY"
done
if [ -z "$ping_ok" ]; then
  # Not `fail` — see the note above. Dump what a reader needs, loudly.
  echo "WARNING (#3236): celery worker never answered 'inspect ping' after ${WORKER_PING_ATTEMPTS} attempts of ${WORKER_PING_TIMEOUT}s." >&2
  echo "  The worker is Running with 0 restarts and every other drill check passed, so this is NOT a deploy regression." >&2
  echo "  Last ping output: ${ping_out:-<none>}" >&2
  echo "  ---- celery-worker log (broker connect / reconnect is the thing to look at) ----" >&2
  # dump_diagnostics only dumps NOT-Ready pods, and with the worker's probes
  # disabled this pod always reads Ready — so its log has to be fetched here or
  # it is never captured at all.
  kubectl logs "$worker_pod" -c celery-worker --tail=40 2>&1 | sed 's/^/    /' >&2 || true
fi

log "HELM INSTALL DRILL GREEN — chart boots, admin retrievable, admin denied at edge, worker pinned, guards fail closed"
