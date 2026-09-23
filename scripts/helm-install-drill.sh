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
# DRILL_LEG (#3941) selects which of two legs runs:
#   install (default) — `helm install` the HEAD chart straight from a clean
#     cluster, as above. This is the leg the `helm:install` CI job runs on
#     every MR and main push.
#   upgrade — `helm install` the PREVIOUS released chart version (pulled from
#     the public OCI registry, oci://${CHART_GHCR_HOST}/${CHART_OCI_REPO}) at
#     its OWN default image tag, then `helm upgrade` the SAME release to the
#     HEAD chart/images, before running the identical section 5-9 assertions
#     below. This is the leg real self-hosters walk on every upgrade
#     (beta.1 -> beta.2 -> beta.3, three cuts in six days at the time #3941
#     was filed) and it is the leg with the failure modes that hurt: migration
#     ordering under a rolling update, bundled-datastore password regeneration
#     on upgrade, post-upgrade hook re-runs (the demo-seed Job), and subchart
#     field immutability. It never got a runtime drill before #3941 — only
#     `helm install` from empty ever ran. "Previous released" is resolved
#     dynamically against the OCI registry's tag list (see
#     resolve_previous_chart_version below) rather than a hardcoded version
#     string, so it keeps tracking the real last tag as releases ship. The
#     `helm:upgrade` CI job runs this leg on main pushes and the nightly
#     schedule only — not on every MR — because it doubles the cluster/install
#     cost of `helm:install` (see .gitlab-ci.yml's `helm:upgrade` job comment).
#
# The api/web images are built per-commit by ci:build-deploy-images (#2284) and
# tagged $CI_COMMIT_SHA, so this drills the HEAD chart against the SAME commit's
# application code (RELEASE_IMAGE_TAG defaults to $CI_COMMIT_SHA in CI). There is
# no version skew: the migration-aware /api/v1/readyz endpoint (#1894, #2217) is
# present in the image, so the install below gates readiness on the chart default
# (/readyz) and runs the full `helm test` incl. its readyz leg — no overrides on
# the api readiness path. The install DOES change the celery probe settings: the
# worker's LIVENESS is turned off and beat's is widened; the worker's STARTUP and
# READINESS are left at chart defaults and are genuinely exercised by
# `--wait` (#3346 — see the CELERY_PROBE_OVERRIDES block below for why liveness
# alone still needs the override, and the current evidence for readiness/startup
# no longer needing it). #3230 settled the liveness half of this: a runtime gate
# is unavailable for `inspect ping` under kind-in-dind CPU contention at ANY
# timing, so its defaults were re-derived against the 300s worker grace instead
# and are held statically by section N+5 of scripts/helm-structure-check.sh.
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
# Which leg to run — see the DRILL_LEG note in the header comment (#3941).
DRILL_LEG="${DRILL_LEG:-install}"
# The public OCI coordinates helm:publish pushes the chart under (matches
# scripts/check-chart-registry.sh's CHART_REPO/GHCR_HOST defaults exactly —
# same registry, same repo path — so the two scripts can never disagree about
# where "the published chart" lives).
CHART_GHCR_HOST="${CHART_GHCR_HOST:-ghcr.io}"
CHART_OCI_REPO="${CHART_OCI_REPO:-trueppm/charts/trueppm}"
# Two-space indent for nesting diagnostic output under its section header.
INDENT_SED='s/^/  /'

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
# So the worker's LIVENESS is off for the drill — #3230's split
# (probes.worker.liveness.* / .readiness.* / .startup.*, each with its own
# `enabled`) is what makes narrowing the override to liveness ALONE possible;
# before that split the only lever was the blunt `probes.worker.enabled=false`,
# which also removed readiness and therefore proved nothing about it.
#
# Readiness and startup are deliberately left ON (#3236, #3346). They no longer
# run `celery inspect ping` at all: the worker's own `heartbeat_sent` signal
# (trueppm_api.core.worker_heartbeat) touches a file on a fixed ~2s timer that
# runs on the MainProcess event loop independent of task load, and the probes
# just stat that file (`find`/`test`, no fork of Django, Celery, or the broker).
# That is exactly the resource story two paragraphs up, with the resource cost
# removed rather than worked around — so `helm install --wait` now gates on a
# probe that has nothing left in common with the one that failed in job
# 16193488334, and a green install is real evidence the worker answers, not
# merely that it rolled out. Section 9 below keeps an independent, RETRY-able
# `inspect ping` from OUTSIDE the probe path as a second, harder proof — and now
# treats a failure there as fatal (see that section), since a functional worker
# has nothing left to explain a failure against a probe with no load-dependent
# cost.
#
# Beat keeps its probe: it renders a livenessProbe only (no readiness), so it
# never gates `--wait`, and at the chart's 60s period a kill needs
# 45 + 9*60 = ~585s, past the whole install budget. Its other knobs are widened
# for the same contention, but its period is deliberately left alone so the
# drill does not double Django-import forks into the chart's tightest cgroup
# (250m CPU / 256Mi).
#
# This array is held identical to the one in scripts/helm-netpol-drill.sh by
# scripts/tests/helm-celery-probe-overrides.test.sh (#3230), which extracts both
# and compares them — the prose note that used to say "keep the two in sync" had
# no mechanism behind it.
#
# staleSeconds widened 30 -> 120 for the drill only (#3692). Two consecutive CI
# runs failed with the worker's readiness probe (heartbeat-file freshness)
# reporting zero successes over a full 7-8 minute --wait window, on different
# runners (nuc-4, then nuc-2), while the worker itself logged `ready.` and was
# never killed (RESTARTS=0) — i.e. the #3218 shape, but against the #3346
# mechanism that was built specifically to not have that shape. Extensive local
# repro (live Valkey under docker-compose, both unthrottled and at a synthetic
# 0.05-CPU cgroup limit; a from-scratch kind cluster on the same kind/k8s
# versions CI pins, node CPU capped to 2 and then 1 for the whole cluster) could
# not reproduce a single stale reading — heartbeat_sent kept the file within 0-2s
# of wall clock throughout every one of those runs, which rules out the file
# never being touched as an explanation reproducible from a laptop. What's left
# is genuine host-level contention on the shared NUC runner fleet at the two
# moments these jobs ran (see docs for the class: several MRs' pipelines were
# open concurrently against just two physical runners) — a story a 30s staleness
# window has very little room to absorb across ~32 checks spread over 8 minutes,
# but a 120s window has substantially more. This does not touch the chart's
# production default (still 30s in values.yaml) and is not a claim that the
# mechanism is proven safe under contention this severe — see the heartbeat-age
# diagnostic added to dump_diagnostics() below, which will show directly, on any
# future recurrence, whether the file genuinely went stale (host contention) or
# reads fresh despite a reported failure (a different bug entirely).
CELERY_PROBE_OVERRIDES=(
  --set probes.worker.liveness.enabled=false
  --set probes.worker.readiness.staleSeconds=120
  --set probes.beat.initialDelaySeconds=45
  --set probes.beat.timeoutSeconds=15
  --set probes.beat.failureThreshold=10
)

# Budget for the independent, retry-able worker control-plane ping in section 9
# (#3236, #3346) — a second, harder proof of worker function alongside the
# chart's own (now heartbeat-based) readiness probe. Worst case 3 x (20 + 10)
# = ~90s, after the install rather than gating it.
WORKER_PING_ATTEMPTS="${WORKER_PING_ATTEMPTS:-3}"
WORKER_PING_TIMEOUT="${WORKER_PING_TIMEOUT:-20}"
WORKER_PING_RETRY_DELAY="${WORKER_PING_RETRY_DELAY:-10}"

API_IMAGE="${IMAGE_REPO}/api:${RELEASE_IMAGE_TAG}"
WEB_IMAGE="${IMAGE_REPO}/web:${RELEASE_IMAGE_TAG}"

log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- admin password retrievable from the shared emptyDir (#3964) -----------
# The password file lives on an emptyDir — pod-local, not persisted across a
# pod replacement — and create_admin is deliberately idempotent: it no-ops the
# moment a superuser already exists (packages/api/.../create_admin.py). So this
# can only ever be checked against the pod bootstrap actually ran on, which for
# the upgrade leg is the PRE-upgrade pod from the initial `helm install` of the
# previous chart — `helm upgrade` rolls a new pod whose create_admin init
# container correctly skips writing the file a second time, and checking the
# post-upgrade pod for it (the original bug, #3964) fails by construction,
# not because anything is broken.
check_admin_password() {
  local api_pod pw_file admin_pw
  api_pod="$(kubectl get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
  # Chart default admin.passwordFile; overridable via $ADMIN_PASSWORD_FILE.
  pw_file="${ADMIN_PASSWORD_FILE:-/run/trueppm/admin_password}"
  log "reading admin password from ${api_pod}:${pw_file}"
  admin_pw="$(kubectl exec "$api_pod" -c api -- cat "$pw_file" 2>/dev/null || true)"
  [ -n "$admin_pw" ] || fail "admin password file '$pw_file' empty/absent — create_admin did not write it"
  log "admin password present (${#admin_pw} chars) — bootstrap wrote the shared emptyDir"
}

# ---- resolve the previous released chart version (upgrade leg only, #3941) -
# Pins "the previous version" to the real last published tag instead of a
# hardcoded string, so it keeps tracking reality as releases ship (beta.1 ->
# beta.2 -> beta.3 -> ...). Reuses the exact anonymous-pull-token + tags/list
# read that scripts/check-chart-registry.sh's list_versions() uses against the
# same registry/repo, and the same STABLE_RE/PRE_RE shape, so the two scripts
# can never disagree about what counts as a chart version vs. a stray
# cosign sha256-* tag.
#
# "Previous" is defined as: the highest published version strictly BELOW
# HEAD's own packages/helm/Chart.yaml `version`. In the common case HEAD's
# Chart.yaml already equals the just-shipped tag (release.sh bumps it AT tag
# time), so this resolves to the release before that one — e.g. HEAD ==
# 0.4.0-beta.3 resolves to 0.4.0-beta.2, the exact beta.2 -> beta.3 path users
# are walking. If HEAD has been bumped ahead of anything published yet
# (mid-cycle dev before the next tag), it falls back to the highest version
# actually in the registry. Merging HEAD's own version into the sorted list
# and walking to it (rather than comparing PRE_RE bases like the publish
# guard does) is what makes both cases fall out of the same code path without
# a special-cased "is HEAD's version already published?" branch.
resolve_previous_chart_version() {
  local head_version token body versions merged
  # HEAD_CHART_VERSION lets a test stub the version without a real Chart.yaml
  # on disk (mirrors CHART_TAGS below and check-chart-registry.sh's own
  # override style) — see scripts/tests/helm-upgrade-leg-version.test.sh.
  if [ -n "${HEAD_CHART_VERSION:-}" ]; then
    head_version="$HEAD_CHART_VERSION"
  else
    head_version="$(awk '/^version:[[:space:]]/{print $2; exit}' "${CHART}/Chart.yaml")"
  fi
  [ -n "$head_version" ] || fail "could not read 'version' from ${CHART}/Chart.yaml"

  # CHART_TAGS (whitespace-separated) skips the network read — same override
  # name and shape as scripts/check-chart-registry.sh's list_versions(), so a
  # test can stub both scripts identically.
  if [ "${CHART_TAGS+set}" = set ]; then
    versions="$(printf '%s\n' $CHART_TAGS \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$|^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$' || true)"
  else
    token="$(curl -fsS --max-time 30 --retry 3 \
      "https://${CHART_GHCR_HOST}/token?scope=repository:${CHART_OCI_REPO}:pull" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" \
      || fail "could not get an anonymous pull token from ${CHART_GHCR_HOST} for ${CHART_OCI_REPO}"
    [ -n "$token" ] || fail "empty pull token from ${CHART_GHCR_HOST} for ${CHART_OCI_REPO}"
    body="$(curl -fsS --max-time 30 --retry 3 -H "Authorization: Bearer ${token}" \
      "https://${CHART_GHCR_HOST}/v2/${CHART_OCI_REPO}/tags/list?n=1000")" \
      || fail "could not read the chart tag list for ${CHART_GHCR_HOST}/${CHART_OCI_REPO}"
    versions="$(printf '%s' "$body" \
      | sed -n 's/.*"tags":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '"' \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$|^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$' || true)"
  fi
  [ -n "$versions" ] || fail "no chart versions found in ${CHART_GHCR_HOST}/${CHART_OCI_REPO} — is the registry readable?"

  merged="$(printf '%s\n%s\n' "$versions" "$head_version" | sort -V -u)"
  PREV_CHART_VERSION="$(printf '%s\n' "$merged" | awk -v head="$head_version" '
    $0 == head { print prev; found=1; exit }
    { prev = $0 }
    END { if (!found) print prev }
  ')"

  if [ -z "$PREV_CHART_VERSION" ]; then
    log "no published chart version older than HEAD (${head_version}) found in ${CHART_GHCR_HOST}/${CHART_OCI_REPO} — nothing to upgrade FROM yet; skipping the upgrade leg"
    exit 0
  fi
  log "upgrade leg: previous released chart = ${PREV_CHART_VERSION}, HEAD chart = ${head_version}"
}

# ---- diagnostics on any failure -------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (deploy did not reach a healthy state) ========" >&2
  kubectl get pods -A -o wide 2>&1 | sed "$INDENT_SED" >&2 || true
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
      kubectl describe "$p" 2>&1 | sed "$INDENT_SED" >&2 || true
      echo "---- logs $p (all containers, incl. init) ----" >&2
      kubectl logs "$p" --all-containers --prefix --tail=80 2>&1 | sed "$INDENT_SED" >&2 || true
      echo "---- previous logs $p (crash before restart, if any) ----" >&2
      kubectl logs "$p" --all-containers --prefix --previous --tail=80 2>&1 | sed "$INDENT_SED" >&2 || true
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
    print("probe error:", e)' 2>&1 | sed "$INDENT_SED" >&2 || true
  fi
  # #3692: the worker readiness probe's own pass/fail was ALL two prior failures
  # left behind — no signal on whether the heartbeat file was genuinely stale
  # (heartbeat_sent not keeping up, pointing at host contention) or fresh despite
  # a reported failure (a different bug in the probe/exec path). Print the file's
  # actual age against wall clock so a recurrence answers that directly instead
  # of reopening the same investigation from zero.
  worker_pod="$(kubectl get pod -l app.kubernetes.io/component=celery-worker -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$worker_pod" ]; then
    echo "---- worker heartbeat file age (#3692) ----" >&2
    kubectl exec "$worker_pod" -c celery-worker -- sh -c '
      f="${TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE:-/tmp/trueppm-celery-worker-heartbeat}"
      now=$(date +%s)
      mt=$(stat -c %Y "$f" 2>&1) || { echo "stat failed: $mt"; exit 0; }
      echo "now=$now mtime=$mt age=$((now - mt))s"
    ' 2>&1 | sed "$INDENT_SED" >&2 || true
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

# Resolve the upgrade-FROM version before spinning up a cluster — a registry
# read is cheap, a kind cluster is not, and #3941's "nothing published yet"
# case exits 0 here rather than after paying for a cluster we would never use.
if [ "$DRILL_LEG" = "upgrade" ]; then
  resolve_previous_chart_version
fi

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
# kind's own node-boot wait — it tails the node container's log for a systemd
# target, separate from the --wait 120s above, which gates node Readiness —
# has no knob to lengthen and can fail in under two seconds on a loaded runner
# (#3966: "could not find a log line that matches ... Multi-User System"), the
# same runner-contention class that made this drill bimodal under load
# (#3218). Retry it: delete whatever partially came up and try again. Held in
# sync with scripts/helm-netpol-drill.sh's identical retry.
CLUSTER_CREATE_ATTEMPTS="${CLUSTER_CREATE_ATTEMPTS:-3}"
CLUSTER_CREATE_RETRY_DELAY="${CLUSTER_CREATE_RETRY_DELAY:-5}"
attempt=1
while true; do
  if kind create cluster --name "$CLUSTER" --config /tmp/kind-config.yaml --wait 120s; then
    break
  fi
  if [ "$attempt" -ge "$CLUSTER_CREATE_ATTEMPTS" ]; then
    fail "kind create cluster failed after ${CLUSTER_CREATE_ATTEMPTS} attempts"
  fi
  log "kind create cluster failed (attempt ${attempt}/${CLUSTER_CREATE_ATTEMPTS}) — deleting and retrying in ${CLUSTER_CREATE_RETRY_DELAY}s"
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  sleep "$CLUSTER_CREATE_RETRY_DELAY"
  attempt=$((attempt + 1))
done

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

# ---- 2b. preload the PREVIOUS release's images (upgrade leg only, #3941) --
# The previous OCI chart's `image.tag` default is "" (resolves to
# v<appVersion>, its OWN appVersion baked in at that historical chart
# version) — so no --set image.tag override is needed on the install-previous
# step below, but the image itself still has to be pulled and side-loaded the
# same way the HEAD images just were, from the SAME registry these release
# tags were published to (packages/helm/values.yaml's image.repository
# default, registry.gitlab.com/trueppm/trueppm/*; the docker login above
# already covers it).
if [ "$DRILL_LEG" = "upgrade" ]; then
  PREV_API_IMAGE="${IMAGE_REPO}/api:v${PREV_CHART_VERSION}"
  PREV_WEB_IMAGE="${IMAGE_REPO}/web:v${PREV_CHART_VERSION}"
  for img in "$PREV_API_IMAGE" "$PREV_WEB_IMAGE"; do
    log "pull + load $img (previous release, upgrade FROM)"
    docker pull "$img"
    kind load docker-image "$img" --name "$CLUSTER"
  done
fi

# ---- 3. the required operator secret ---------------------------------------
# The three secrets settings.prod refuses to boot without (#566/#1002) plus the
# local-storage opt-in (#775). The bundled-postgres DB escape hatch
# (TRUEPPM_ALLOW_UNENCRYPTED_DB) is auto-injected by the chart because
# postgresql.enabled && networkPolicy.enabled (chart defaults), so it is NOT set
# here — proving that default path boots.
secret_key="$(head -c 50 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-60)"
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
if [ "$DRILL_LEG" = "upgrade" ]; then
  # ---- 4a. install the PREVIOUS released chart from the public OCI registry
  # No CELERY_PROBE_OVERRIDES here on purpose: this chart version already
  # shipped, which means it already passed its OWN release drill (this same
  # script, `install` leg) against its OWN probe defaults — reapplying the
  # HEAD chart's tuning to a possibly-different probe schema would prove
  # nothing about the version actually being installed. No --set image.tag
  # either: this chart version's own default ("" -> v<appVersion>) already
  # resolves to the image just pulled and loaded above.
  log "helm install ${RELEASE} FROM PREVIOUS RELEASED CHART ${PREV_CHART_VERSION} (oci://${CHART_GHCR_HOST}/${CHART_OCI_REPO})"
  helm install "$RELEASE" "oci://${CHART_GHCR_HOST}/${CHART_OCI_REPO}" --version "$PREV_CHART_VERSION" \
    --set persistence.media.enabled=true \
    --set persistence.media.accessMode=ReadWriteOnce \
    --set 'envFrom[0].secretRef.name=trueppm-env' \
    --wait --timeout "$INSTALL_TIMEOUT"
  log "previous release ${PREV_CHART_VERSION} rolled out — now helm upgrade -> HEAD chart"
  kubectl get pods -o wide

  # ---- 4a-cont. admin password, checked against THIS pod before it is gone -
  # This is the only point in the upgrade leg where the check can pass: see
  # check_admin_password's header comment. `--wait` above already gates on the
  # pod being Ready, which means its init containers (including create_admin)
  # already ran to completion.
  check_admin_password

  # ---- 4b. upgrade THE SAME RELEASE to the HEAD chart/images ---------------
  # This is the leg #3941 exists for: migration ordering + the migrate_locked
  # advisory lock under values-prod.yaml's replicaCount: 2, bundled-datastore
  # password regeneration on upgrade (templates/secret.yaml's lookup-returns-
  # empty path), post-upgrade hook re-runs (the demo-seed Job re-fires), and
  # PVC/StatefulSet field immutability on the postgresql/valkey subcharts —
  # none of which a from-empty `helm install` can ever exercise. Same release
  # name, same namespace, same secret: a real operator upgrade never
  # recreates either.
  upgrade_args=(
    --set image.tag="$RELEASE_IMAGE_TAG"
    --set persistence.media.enabled=true
    --set persistence.media.accessMode=ReadWriteOnce
    --set 'envFrom[0].secretRef.name=trueppm-env'
    "${CELERY_PROBE_OVERRIDES[@]}"
  )
  # The NetworkPolicy transition guard (#4000) must refuse the upgrade that
  # first introduces the api/web ingress policies while the selector is an
  # unconfirmed default. It only runs when the previous release did NOT already
  # render trueppm-api-ingress, so the refusal is asserted only in that case.
  # Once the previous release is itself a post-#4000 chart, the lookup finds the
  # policy and this branch is skipped. The refusal happens at render time, so
  # nothing is applied to the release.
  if ! kubectl get networkpolicy "${RELEASE}-api-ingress" >/dev/null 2>&1; then
    log "expect: upgrade introducing the app-tier ingress policies on the default selector is REFUSED (#4000)"
    if guard_out="$(helm upgrade "$RELEASE" "$CHART" "${upgrade_args[@]}" 2>&1)"; then
      fail "helm upgrade introduced the app-tier ingress NetworkPolicies on an unconfirmed default selector without refusing (#4000)"
    fi
    grep -q 'networkPolicy.ingressControllerConfirmed=true' <<<"$guard_out" \
      || fail "helm upgrade failed, but not with the NetworkPolicy transition guard (#4000): $guard_out"
    upgrade_args+=(--set networkPolicy.ingressControllerConfirmed=true)
  fi
  log "helm upgrade ${RELEASE} -> HEAD chart (image tag ${RELEASE_IMAGE_TAG})"
  helm upgrade "$RELEASE" "$CHART" "${upgrade_args[@]}" --wait --timeout "$INSTALL_TIMEOUT"
  log "upgrade rollout complete"
  # The guard fires once. With the policy now present, the lookup finds it and
  # a later upgrade on the same default selector, without the confirmation,
  # must render. A server-side dry run performs the real lookup and applies
  # nothing.
  helm upgrade "$RELEASE" "$CHART" --dry-run=server \
    --set image.tag="$RELEASE_IMAGE_TAG" \
    --set persistence.media.enabled=true \
    --set persistence.media.accessMode=ReadWriteOnce \
    --set 'envFrom[0].secretRef.name=trueppm-env' \
    "${CELERY_PROBE_OVERRIDES[@]}" >/dev/null \
    || fail "a second upgrade still tripped the NetworkPolicy transition guard after the policy exists; it must fire only once (#4000)"
else
  # ---- 4. install + wait for full rollout ----------------------------------
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
fi
kubectl get pods -o wide

# ---- 5. helm test: api booted end to end (readyz reachable) ----------------
log "helm test ${RELEASE}"
helm test "$RELEASE" --timeout 3m

# ---- 6. admin password retrievable from the shared emptyDir ----------------
# Upgrade leg already ran this (4a-cont., above) against the pre-upgrade pod —
# the only pod create_admin ever wrote it to. See check_admin_password's
# header comment for why a post-upgrade pod can never pass this check.
if [ "$DRILL_LEG" != "upgrade" ]; then
  check_admin_password
fi

# ---- 7. negative probe: boot guard fails closed without SECRET_KEY ----------
# settings.prod reads SECRET_KEY (import-time, no default) BEFORE it ever touches
# DATABASE_URL/REDIS_URL, so the pod fails on the missing key without a database
# in reach — no connection strings needed here. It must exit non-zero rather than
# start with an insecure default.
log "negative probe: api image without SECRET_KEY must refuse to start"
# ALLOWED_HOSTS='*' is deliberate here, and only here: this throwaway pod must
# fail on SECRET_KEY alone, so host validation is taken out of the picture. It
# never serves a request (#3183).
#
# TRUEPPM_ALLOW_WILDCARD_HOSTS keeps that true. Since #3515 the wildcard has its
# own boot guard, and it sits ABOVE the SECRET_KEY read in settings/prod.py — so
# without the acknowledgment this probe refuses on the wildcard instead and the
# grep below, which is the whole assertion, stops seeing that refusal. Widening
# that grep to accept any refusal is the wrong fix: it would let the probe pass
# on a guard it was not written to test.
#
# SECRET_KEY is left unset, so settings.prod's own `env("SECRET_KEY")` read
# (before the guard's weak-key check even runs) raises django-environ's
# ImproperlyConfigured with a fixed, distinguishing message — "Set the
# SECRET_KEY environment variable" — never emitted by any other guard (#3521).
# A bare "SECRET_KEY" substring match would also pass on, e.g., the JWT signing
# key guard's message ("JWT signing inherits SECRET_KEY when ..."), which
# mentions SECRET_KEY without being the guard under test — so a future reorder
# that moved a different guard above this one could still read as green.
kubectl run secret-guard-probe \
  --image="$API_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --env=DJANGO_SETTINGS_MODULE=trueppm_api.settings.prod \
  --env=ALLOWED_HOSTS='*' \
  --env=TRUEPPM_ALLOW_WILDCARD_HOSTS=true \
  --env=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --env=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true \
  --command -- python manage.py migrate --noinput
# The pod runs to completion (Never restart); wait for a terminal phase.
kubectl wait --for=jsonpath='{.status.phase}'=Failed pod/secret-guard-probe --timeout=90s \
  || fail "secret-guard probe did not FAIL — the boot guard may not be fail-closed"
probe_log="$(kubectl logs secret-guard-probe 2>&1 || true)"
grep -qi "Set the SECRET_KEY environment variable" <<<"$probe_log" \
  || fail "probe failed but not on the missing-SECRET_KEY refusal; log tail: $(echo "$probe_log" | tail -3)"
log "negative probe GREEN — deploy without SECRET_KEY refuses to start"

# ---- 8. Django admin is NOT reachable through the web tier (#2569) ----------
# The static half of this lives in helm-structure-check.sh; this is the runtime
# proof. Driven with urllib because it needs no extra dependency.
#
# The probe must originate from a pod the #3850 web-ingress NetworkPolicy
# actually admits — as of KIND_VERSION 0.24.0 (pinned above), kindnetd DOES
# enforce basic NetworkPolicy (confirmed empirically; kindnetd gained this in
# kind >=0.20, contrary to the older assumption recorded in
# templates/networkpolicy.yaml and scripts/helm-netpol-drill.sh, both corrected
# alongside this). The api pod is NOT in that admit list — the chart's own
# topology only has web calling OUT to api, never the reverse — so a request
# from api now gets dropped before nginx ever sees it, which reads as a
# connection timeout rather than the nginx-level 403 this probe exists to
# prove. Run it instead from a throwaway pod placed in a namespace matching
# networkPolicy.ingressControllerSelector's default (an `ingress-nginx`
# namespace, matched via the label every namespace has carried since
# Kubernetes 1.21) — the chart default this drill installs under, and
# unmodified here. That pod is treated exactly like real ingress-controller
# traffic: admitted by the NetworkPolicy, then still subject to nginx's own
# `web.adminAccess.allowCIDRs` check, which is what #2569 actually guards.
log "probing /admin/ through the web tier — must be denied"
# Resolve the Service by LABEL, never by string-building the release name:
# `trueppm.fullname` collapses when the release name already contains the chart
# name, so "<release>-trueppm-web" is wrong for the default release `trueppm`
# (the Service is just `trueppm-web`) and right for others. The label selector is
# correct for every release name.
web_svc="$(kubectl get svc -l app.kubernetes.io/component=web -o jsonpath='{.items[0].metadata.name}')"
[ -n "$web_svc" ] || fail "no web Service found (component=web)"
web_ns="$(kubectl get svc -l app.kubernetes.io/component=web -o jsonpath='{.items[0].metadata.namespace}')"
kubectl create namespace ingress-nginx
# URLError (DNS/connection) is caught separately from HTTPError so a
# connectivity failure reports as a distinct sentinel rather than an unhandled
# traceback that `set -e` would turn into an opaque red with no message.
admin_code="$(kubectl run admin-probe -n ingress-nginx \
  --image="$API_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --attach --rm --quiet \
  --command -- python -c "
import urllib.request, urllib.error
url = 'http://${web_svc}.${web_ns}.svc.cluster.local/admin/'
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

# ---- 9. celery worker: concurrency pinned, Ready, and it STAYS up (#2571) ---
# `helm install --wait` above already gates on the worker becoming Ready — and
# unlike before #3346, that Ready now comes from the heartbeat-file readiness
# probe rather than a probe this drill has to disable, so it is real evidence.
# What `--wait` cannot see is an OOMKill loop that starts once the prefork
# children are all spawned, so also assert the flag is really on the running
# container and that the pod has not restarted.
worker_pod="$(kubectl get pod -l app.kubernetes.io/component=celery-worker -o jsonpath='{.items[0].metadata.name}')"
[ -n "$worker_pod" ] || fail "no celery-worker pod found"
worker_cmd="$(kubectl get pod "$worker_pod" -o jsonpath='{.spec.containers[0].command}')"
grep -qE -- '--concurrency=[0-9]+' <<<"$worker_cmd" \
  || fail "running celery-worker has no --concurrency; command was: $worker_cmd"
restarts="$(kubectl get pod "$worker_pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
[ "${restarts:-0}" -eq 0 ] \
  || fail "celery-worker restarted ${restarts}x since rollout — likely the OOMKill loop from an unpinned prefork pool (#2571)"
worker_ready_condition="$(kubectl get pod "$worker_pod" -o jsonpath='{.status.containerStatuses[0].ready}')"
[ "$worker_ready_condition" = "true" ] \
  || fail "celery-worker pod is not Ready (${worker_ready_condition:-<empty>}) despite helm install --wait succeeding — inconsistent chart/cluster state"
log "celery worker pinned, Ready, and stable (0 restarts): $worker_cmd"

# Startup broker race, measured on EVERY run (#3722). Every recorded ping
# failure below began with the worker booting into refused broker connections
# before valkey was up, but the worker log used to be printed only on failure,
# so no green run could say whether the race had happened at all. The worker
# now waits for the broker before it starts (trueppm_api.core.worker_broker_wait),
# which should leave consumer refusals at 0 every run. If a ping failure recurs
# with 0 refusals, the startup-race explanation is wrong.
worker_log="$(kubectl logs "$worker_pod" -c celery-worker 2>&1 || true)"
broker_waits="$(printf '%s\n' "$worker_log" | grep -c 'worker_broker_wait: broker not reachable yet' || true)"
consumer_refusals="$(printf '%s\n' "$worker_log" | grep -c 'consumer: Cannot connect to' || true)"
log "worker startup: ${broker_waits} pre-start broker wait(s), ${consumer_refusals} consumer connect refusal(s) (#3722)"

# An INDEPENDENT, retry-able functional proof that the worker actually SERVES,
# not merely that Kubernetes reports it Ready (#3236, #3346). Before #3346 this
# was diagnostic-only because the chart's own readiness probe had to be
# disabled to get a green install at all (see CELERY_PROBE_OVERRIDES) — a
# ping failure here could not be distinguished from that known #3218/#3236
# defect. Now that readiness is a load-independent heartbeat-file check with
# nothing left to explain a false failure, this is FATAL: a worker this drill
# has already proven Ready with 0 restarts that still cannot answer a
# control-plane ping, driven by `kubectl exec` completely outside the probe
# path, is exactly the "Ready but not serving" failure mode #2279's acceptance
# criterion calls out, and it must fail loudly rather than read as green.
log "checking whether the celery worker answers a control-plane ping (fatal — #3236, #3346)"
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
  echo "  ---- celery-worker log (broker connect / reconnect is the thing to look at) ----" >&2
  kubectl logs "$worker_pod" -c celery-worker --tail=40 2>&1 | sed 's/^/    /' >&2 || true

  # #3236's local repro (Docker + a from-scratch kind cluster, 2026-09-10/11)
  # refuted the pidbox-reconnect hypothesis in every configuration tried, so a
  # recurrence here needs evidence the local repro could not produce rather than
  # another blind reproduction attempt. Three targeted captures, each aimed at one
  # question the celery CLI's own timeout message cannot answer on its own.
  echo "  ---- ping from a SEPARATE pod, outside the worker's own cgroup (#3236) ----" >&2
  # The failing ping above runs `kubectl exec` INTO the worker container, so it pays
  # the same Django+Celery import cost, in the worker's OWN cpu cgroup, that the
  # MainProcess needs free to answer it — a confound #3236's repro could only push
  # to ~0.1 CPU before the ping degraded from "slow" to "absent" some other way. The
  # api pod shares the image, the celery app, and REDIS_URL, but a different cgroup:
  # a ping that succeeds from here while the in-container one above failed points at
  # the prober's own contention, not a dead control plane.
  kubectl exec "$api_pod" -c api -- \
    celery -A trueppm_api.celery inspect ping \
    --destination "celery@${worker_pod}" --timeout "$WORKER_PING_TIMEOUT" 2>&1 \
    | sed "$INDENT_SED" >&2 || true

  echo "  ---- broker pidbox binding registration (#3236) ----" >&2
  # An earlier version of this capture globbed `PUBSUB CHANNELS celery*` and
  # `KEYS celery*` — verified against the pinned celery 5.6.3 / kombu 5.6.2 /
  # redis-py 7.4.1 versions this chart ships that BOTH are always empty, on a
  # fully healthy worker as much as a wedged one: kombu's redis transport
  # never surfaces pidbox traffic over native Pub/Sub here (PUBSUB CHANNELS
  # stayed empty even polled through a live successful ping), and the real
  # binding key is `_kombu.binding.celery.pidbox` — underscore-prefixed, so
  # `celery*` can never match it. That made the capture dead weight: three
  # lines that print nothing regardless of which failure mode this is.
  #
  # `_kombu.binding.celery.pidbox` is a Redis SET, one member per bound
  # control queue, named `<nodename>.celery.pidbox` — durable for the life of
  # the binding (unaffected by the reply queue's ~10s expiry, which is why
  # the old `KEYS *reply*` line was also normally empty by the time a drill
  # reaches this point). Its member for THIS worker uses the same
  # `celery@<pod>` nodename the ping above already destinations against.
  # Absence is unambiguous: the worker's control queue was never declared —
  # the "pidbox consumer is gone" half of the distinction this issue wants.
  # Presence does not prove the consumer is still being served (the binding
  # is not cleaned up on an unclean death), so it narrows rather than
  # resolves the other half — combine with the cgroup capture below.
  kubectl exec "$api_pod" -c api -- env "TRUEPPM_DRILL_WORKER_NODE=celery@${worker_pod}" python -c '
import os
import redis

# kombu stores each SET member as "routing_key<SEP>pattern<SEP>queue" (SEP is
# the transports own field separator, kombu.transport.redis.Channel.sep) —
# not the bare queue name. Splitting it out and comparing only the last field
# is what makes this an exact match instead of a coincidental False.
SEP = "\x06\x16"
r = redis.from_url(os.environ["REDIS_URL"])
target = os.environ["TRUEPPM_DRILL_WORKER_NODE"] + ".celery.pidbox"
queues = sorted(m.decode().split(SEP)[-1] for m in r.smembers("_kombu.binding.celery.pidbox"))
print("this worker bound:", target in queues)
print("all bound pidbox queues:", queues)
' 2>&1 | sed "$INDENT_SED" >&2 || true

  echo "  ---- worker container cgroup CPU throttling (#3236) ----" >&2
  # Turns "the runner was busy" from a story into a number. #3236's repro showed
  # starvation degrades the ping to slow, never absent, down to 0.1 CPU — so a real
  # recurrence with near-zero nr_throttled here rules starvation back out rather
  # than reopening it as the default explanation.
  kubectl exec "$worker_pod" -c celery-worker -- sh -c '
    for f in /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu/cpu.stat; do
      if [ -r "$f" ]; then echo "$f:"; cat "$f"; exit 0; fi
    done
    echo "no readable cgroup cpu.stat at either the v2 or v1 path"
  ' 2>&1 | sed "$INDENT_SED" >&2 || true

  echo "  ---- worker thread stacks via celery's SIGUSR1 handler (#3722) ----" >&2
  # Every capture above says THAT the worker stopped; none says WHERE. Celery
  # installs a SIGUSR1 "cry" handler in the worker MainProcess that writes every
  # thread's stack to stderr (celery.apps.worker.install_cry_handler). The chart
  # runs `celery` as PID 1, since the api image has no init wrapper, and exec runs
  # as the same user, so no py-spy and no ptrace capability are needed. An empty
  # capture is itself an answer: the main thread never got back to the
  # interpreter to run a Python signal handler, so it is blocked inside a C call.
  kubectl exec "$worker_pod" -c celery-worker -- sh -c 'kill -USR1 1' 2>&1 | sed "$INDENT_SED" >&2 || true
  sleep 3
  kubectl logs "$worker_pod" -c celery-worker --since=10s 2>&1 | sed "$INDENT_SED" >&2 || true

  fail "celery-worker is Ready with ${restarts:-0} restarts but never answered 'inspect ping' after ${WORKER_PING_ATTEMPTS} attempts of ${WORKER_PING_TIMEOUT}s — Ready does not mean serving (#3236). Startup: ${broker_waits} broker wait(s), ${consumer_refusals} consumer refusal(s) — 0 refusals falsifies #3722's startup-race explanation. Last ping output: ${ping_out:-<none>}"
fi

if [ "$DRILL_LEG" = "upgrade" ]; then
  log "HELM UPGRADE DRILL GREEN — ${PREV_CHART_VERSION} -> HEAD upgraded cleanly; admin retrievable, admin denied at edge, worker pinned+Ready+serving, guards fail closed"
else
  log "HELM INSTALL DRILL GREEN — chart boots, admin retrievable, admin denied at edge, worker pinned+Ready+serving, guards fail closed"
fi
