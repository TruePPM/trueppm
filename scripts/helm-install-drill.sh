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
# DRILL_LEG (#3941) selects which of three legs runs:
#   install (default) — `helm install` the HEAD chart straight from a clean
#     cluster, as above. This is the leg the `helm:install` CI job runs on
#     every MR and main push.
#   demo (#4018) — `helm install` the HEAD chart with `values-demo.yaml`
#     layered on top (the public, read-only, share-link-only overlay,
#     ADR-0658), waits for the demo-seed post-install hook, then asserts the
#     allowlist matrix from a probe pod placed where the chart's own
#     NetworkPolicy admits it (the `ingress-nginx` namespace, same as the
#     admin-denied-at-edge probe in section 8): `/`, both `/share/...` SPA
#     routes and both `/api/v1/share/...` projections answer 200; every other
#     `/api/` route, `/admin/*` and `/ws/` answer 404; a write verb to a share
#     projection answers 403 `demo_read_only`; path-traversal and
#     double-slash variants still 404; and a case-different path falls to the
#     SPA (`text/html`) rather than being proxied. It also re-proves the
#     per-visitor throttle property from #4017: two distinct
#     `X-Forwarded-For` values must land in two distinct `share_access`
#     buckets, not one shared one. Nothing here is visible to `helm template`
#     — the allowlist and the throttle are both runtime-only surfaces (#4018).
#     The `helm:demo` CI job runs this leg on MRs and main pushes that touch
#     the chart or this script, like `helm:install`/`helm:upgrade`.
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
#     `helm:upgrade` CI job runs this leg on MRs and main pushes that touch
#     the chart or this script, and nightly (see .gitlab-ci.yml's
#     `helm:upgrade` job comment for why MRs pay for it, #4000).
#   walkthrough (#4027) — drills administration/deployment.md's "Production
#     install walkthrough" step for step, the path `helm:install`/`helm:upgrade`/
#     `helm:demo` never touch: a NAMED namespace (`trueppm`, not `default`),
#     `values-prod.yaml` as the base overlay (bundled postgresql/valkey
#     disabled), and managed datastores reached the documented way —
#     `env.DATABASE_URL`/`env.REDIS_URL` as `secretKeyRef` maps pointing at
#     operator-owned Secrets, never a chart-built connection string. "Managed"
#     here means a second, unrelated Postgres + Valkey stood up by THIS drill
#     in their own namespace, outside the chart's own release — never the
#     bundled postgresql/valkey subcharts, which values-prod.yaml turns off.
#     The managed Postgres runs with TLS on and a self-signed certificate
#     specifically so `sslmode=require` in the operator-supplied DATABASE_URL
#     is a REAL negotiated TLS handshake, not just a substring settings.prod's
#     boot guard happens to see — a plaintext "managed" database would prove
#     nothing about that guard. The commands this leg runs (namespace, both
#     `kubectl create secret` invocations, the `my-values.yaml` shape, and the
#     admin-password retrieval) are asserted to match deployment.md's own
#     fenced code blocks by scripts/check-helm-walkthrough-drift.py, so the
#     drill and the doc cannot silently diverge again the way #4025's two bugs
#     (Secret created before its namespace existed; DATABASE_URL supplied in a
#     shape the chart's render rejects) did. The `helm:walkthrough` CI job
#     runs this leg on MRs and main pushes that touch the chart, this script,
#     or deployment.md, and on the nightly schedule.
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

# ---- WALKTHROUGH-LEG-ONLY namespace + managed-datastore names (#4027) ------
# deployment.md's walkthrough uses the literal namespace "trueppm" throughout
# (its own kubectl commands hardcode --namespace trueppm), so that is the
# default here too — overridable only so a test can point it elsewhere without
# colliding with a real "trueppm" namespace. The managed-datastore namespace is
# this drill's OWN invention (the doc has no namespace for "your managed
# database" — it is, by definition, somewhere outside this cluster); any name
# works as long as it differs from WALKTHROUGH_NAMESPACE, which the render/
# runtime never see or care about.
WALKTHROUGH_NAMESPACE="${WALKTHROUGH_NAMESPACE:-trueppm}"
WALKTHROUGH_MANAGED_NAMESPACE="${WALKTHROUGH_MANAGED_NAMESPACE:-trueppm-managed}"

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

# ---- DEMO-LEG-ONLY values overlay (#4018) -----------------------------------
# `helm template` needs no live cluster, so this is resolved up front, before
# section 1 even creates one. values-demo.yaml ships with demo.baseUrl and
# both demo.shareToken.* deliberately empty (see that file's own SECRETS
# comment) — the chart's demo-seed-job.yaml `fail`s the WHOLE render without
# them, not just that one template, so every `helm template`/`helm install`
# call below that layers values-demo.yaml on must carry all three.
#
# demo.baseUrl is the operator's public origin, used verbatim in the `/`
# route's redirect (templates/web/configmap.yaml, #3911). A drill has no real
# public origin, so this points it at the web Service's OWN in-cluster DNS
# name instead of a placeholder host: a placeholder would make the redirect
# resolve nowhere, and "GET / -> 200" (section 10) can only be asserted by
# actually following that redirect back through the same allowlisted nginx.
# Namespace is the chart's implicit "default" — nothing in this script ever
# passes -n/--namespace to helm or kubectl.
if [ "$DRILL_LEG" = "demo" ]; then
  demo_web_svc="$(helm template "$RELEASE" "$CHART" --set image.tag="$RELEASE_IMAGE_TAG" \
    --show-only templates/web/service.yaml \
    | awk '/^  name:/{print $2; exit}')"
  [ -n "$demo_web_svc" ] || fail "could not resolve the web Service name from the render (#4018)"
  DEMO_BASE_URL="http://${demo_web_svc}.default.svc.cluster.local"
  DEMO_SCHEDULE_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
  DEMO_BOARD_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '=+/')"
  DEMO_ARGS=(
    -f "${CHART}/values-demo.yaml"
    --set "demo.baseUrl=${DEMO_BASE_URL}"
    --set "demo.shareToken.schedule=${DEMO_SCHEDULE_TOKEN}"
    --set "demo.shareToken.board=${DEMO_BOARD_TOKEN}"
    # demo.enabled + no rendered Ingress + the default
    # networkPolicy.ingressControllerSelector (an "ingress-nginx" namespace)
    # trips trueppm.webExposureNetworkPolicyGuard (#4003) on a FRESH install,
    # not just an upgrade — the guard exists because that default peer is
    # normally the WRONG one for a tunnel-fronted demo. Here it is the right
    # one: section 10's probe pod deliberately runs IN that namespace (same
    # trick section 8 already uses for the admin-denied-at-edge probe), so
    # confirming the default is what makes the peer under test match the
    # probe's real placement.
    --set networkPolicy.ingressControllerConfirmed=true
  )
fi

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
# "Previous" is defined as: the highest published version AT OR BELOW HEAD's
# own packages/helm/Chart.yaml `version`. release.sh bumps Chart.yaml at tag
# time, and it stays there until the next cut, so on every main commit after
# the 0.4.0-beta.3 tag HEAD still says 0.4.0-beta.3. The operators this job
# speaks for are running the PUBLISHED 0.4.0-beta.3 chart and will upgrade to
# whatever main becomes. Upgrading from that exact artifact to HEAD is their
# next path. An earlier "strictly below" rule resolved that to 0.4.0-beta.2,
# so the drill kept testing a path nobody on the latest release takes (#4000).
# HEAD equal to a published version is not a no-op: the published chart is the
# artifact from the tag, and HEAD is main's chart since then.
# If HEAD has been bumped ahead of anything published (a release branch mid-
# cut), this is the highest version actually in the registry.
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

  # Pick the highest published version <= HEAD under SemVer precedence, in
  # POSIX awk rather than `sort -V`: GNU sort -V ranks 0.4.0 BELOW 0.4.0-beta.1
  # (the registry does carry a bare 0.4.0, #3914), and the busybox sort in the
  # docker:27 job image has no V key modifier at all.
  PREV_CHART_VERSION="$(printf '%s\n' "$versions" | awk -v head="$head_version" '
    function isnum(s) { return s ~ /^[0-9]+$/ }
    # SemVer 2.0.0 §11 precedence: -1 if a<b, 0 if equal, 1 if a>b.
    function cmp(a, b,    ac, bc, ap, bp, i, n, x, y, na, nb, xa, ya) {
      ac = a; ap = ""; if ((i = index(a, "-")) > 0) { ac = substr(a, 1, i - 1); ap = substr(a, i + 1) }
      bc = b; bp = ""; if ((i = index(b, "-")) > 0) { bc = substr(b, 1, i - 1); bp = substr(b, i + 1) }
      split(ac, x, "."); split(bc, y, ".")
      for (i = 1; i <= 3; i++) { if (x[i] + 0 != y[i] + 0) return (x[i] + 0 < y[i] + 0) ? -1 : 1 }
      if (ap == bp) return 0
      if (ap == "") return 1
      if (bp == "") return -1
      na = split(ap, xa, "."); nb = split(bp, ya, ".")
      n = (na < nb) ? na : nb
      for (i = 1; i <= n; i++) {
        if (xa[i] == ya[i]) continue
        if (isnum(xa[i]) && isnum(ya[i])) return (xa[i] + 0 < ya[i] + 0) ? -1 : 1
        if (isnum(xa[i])) return -1
        if (isnum(ya[i])) return 1
        return (xa[i] < ya[i]) ? -1 : 1
      }
      return (na < nb) ? -1 : (na > nb) ? 1 : 0
    }
    NF && cmp($0, head) <= 0 && (best == "" || cmp($0, best) > 0) { best = $0 }
    END { print best }
  ')"

  if [ -z "$PREV_CHART_VERSION" ]; then
    log "no published chart version at or below HEAD (${head_version}) found in ${CHART_GHCR_HOST}/${CHART_OCI_REPO} — nothing to upgrade FROM yet; skipping the upgrade leg"
    exit 0
  fi
  log "upgrade leg: previous released chart = ${PREV_CHART_VERSION}, HEAD chart = ${head_version}"
}

# ---- walkthrough-leg-only: named namespace + managed datastores (#4027) ----
# Everything this function creates is the RUNTIME half of
# administration/deployment.md's "Production install walkthrough" — the
# commands below are asserted against that page's own fenced code blocks by
# scripts/check-helm-walkthrough-drift.py, so editing one without the other
# fails a cheap lint rather than silently drifting the way #4025's two bugs
# did (Secret created before its namespace existed; DATABASE_URL supplied in
# a shape the chart's render rejects).
setup_walkthrough_datastores() {
  log "walkthrough leg (#4027): creating the documented namespace and Secret, in the order deployment.md shows"
  kubectl create namespace "$WALKTHROUGH_NAMESPACE"
  # Every bare kubectl/helm call from here on targets the CURRENT kube
  # context's default namespace, so pointing it at the walkthrough namespace
  # ONCE here is what lets every later shared assertion (helm test, admin
  # password, negative probe, admin-denied-at-edge, worker/beat health) run
  # against "trueppm" with no further -n/--namespace plumbing — the same way
  # they already run against "default" for the other three legs.
  kubectl config set-context --current --namespace="$WALKTHROUGH_NAMESPACE"

  # The Deployment name deployment.md's own admin-password command hardcodes
  # (`deployment/trueppm-api`) — derived from the render rather than assumed,
  # since `trueppm.fullname` only collapses to the bare release name when the
  # release name already contains the chart name (see the api_svc comment in
  # section 3 above).
  WALKTHROUGH_API_NAME="$(helm template "$RELEASE" "$CHART" --set image.tag="$RELEASE_IMAGE_TAG" \
    --show-only templates/api/deployment.yaml \
    | awk '/^  name:/{print $2; exit}')"
  [ -n "$WALKTHROUGH_API_NAME" ] || fail "could not resolve the api Deployment name from the render (#4027)"

  # ---- the documented application Secret ("Create the application Secret"),
  # reproduced byte-for-byte. openssl and python3 are installed by this job's
  # before_script specifically so this command needs no substitute.
  log "creating trueppm-env Secret (documented form)"
  kubectl create secret generic trueppm-env --namespace "$WALKTHROUGH_NAMESPACE" \
    --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
    --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1 \
    --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c \
      'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')" \
    --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

  # ---- a "managed" PostgreSQL + Valkey, stood up by THIS drill OUTSIDE the
  # chart's own release, in their own namespace — simulating the managed
  # services values-prod.yaml's comments tell an operator to point at. The
  # bundled subcharts stay OFF throughout (values-prod.yaml's
  # postgresql.enabled/valkey.enabled: false) — that is the whole point of
  # this leg, and the other three legs already cover the bundled path.
  log "creating ${WALKTHROUGH_MANAGED_NAMESPACE} namespace for the managed-datastore stand-in"
  kubectl create namespace "$WALKTHROUGH_MANAGED_NAMESPACE"

  local pg_password valkey_password pg_repo pg_tag valkey_repo valkey_tag
  pg_password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  valkey_password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)"

  # Reuse the SAME pinned images the chart's own bundled subcharts vendor
  # (packages/helm/charts/{postgresql,valkey}/values.yaml) rather than a
  # second, independently-drifting image pin — a dependency bump there
  # updates this drill's "managed" stand-in for free.
  pg_repo="$(awk '/^image:/{f=1} f && /^  repository:/{print $2; exit}' "${CHART}/charts/postgresql/values.yaml" | tr -d '"')"
  pg_tag="$(awk '/^image:/{f=1} f && /^  tag:/{print $2; exit}' "${CHART}/charts/postgresql/values.yaml" | tr -d '"')"
  valkey_repo="$(awk '/^image:/{f=1} f && /^  repository:/{print $2; exit}' "${CHART}/charts/valkey/values.yaml" | tr -d '"')"
  valkey_tag="$(awk '/^image:/{f=1} f && /^  tag:/{print $2; exit}' "${CHART}/charts/valkey/values.yaml" | tr -d '"')"
  [ -n "$pg_repo" ] && [ -n "$pg_tag" ] || fail "could not resolve the postgresql subchart's image from ${CHART}/charts/postgresql/values.yaml"
  [ -n "$valkey_repo" ] && [ -n "$valkey_tag" ] || fail "could not resolve the valkey subchart's image from ${CHART}/charts/valkey/values.yaml"
  local managed_postgres_image="${pg_repo}:${pg_tag}"
  local managed_valkey_image="${valkey_repo}:${valkey_tag}"

  # ---- self-signed TLS material for the managed Postgres, minted HOST-SIDE
  # (openssl is in this job's image) rather than inside the cluster, so the
  # in-cluster side needs no openssl binary at all — only `cp`/`chown`/`chmod`
  # (see the init container below), which every image ships.
  local tls_dir=/tmp/managed-postgres-tls
  mkdir -p "$tls_dir"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout "${tls_dir}/tls.key" -out "${tls_dir}/tls.crt" \
    -subj "/CN=managed-postgres.${WALKTHROUGH_MANAGED_NAMESPACE}.svc.cluster.local" \
    2>/dev/null \
    || fail "could not mint the managed-postgres self-signed TLS certificate"
  kubectl create secret tls managed-postgres-tls --namespace "$WALKTHROUGH_MANAGED_NAMESPACE" \
    --cert="${tls_dir}/tls.crt" --key="${tls_dir}/tls.key"

  log "standing up the managed PostgreSQL (TLS on) + Valkey in ${WALKTHROUGH_MANAGED_NAMESPACE} (outside the chart)"
  cat <<EOF | kubectl apply --namespace "$WALKTHROUGH_MANAGED_NAMESPACE" -f -
apiVersion: v1
kind: Secret
metadata:
  name: managed-postgres-auth
type: Opaque
stringData:
  POSTGRES_USER: trueppm
  POSTGRES_DB: trueppm
  POSTGRES_PASSWORD: "${pg_password}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: managed-postgres
  labels:
    app: managed-postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: managed-postgres
  template:
    metadata:
      labels:
        app: managed-postgres
    spec:
      # A permission-fixup init container, not a chart pattern to imitate: it
      # copies the read-only Secret-mounted cert/key into a writable emptyDir
      # owned by the SAME image's own "postgres" user (queried with \`id\`
      # rather than hardcoded, since the exact UID is an implementation
      # detail of the upstream image) at mode 600 — the permission
      # PostgreSQL's own ssl_key_file check requires. A Secret volume's
      # defaultMode only sets permission bits, not ownership, and it is the
      # main container's postgres SERVER process (not its root entrypoint)
      # that actually opens the file, so ownership has to be fixed too.
      initContainers:
        - name: fix-tls-perms
          image: "${managed_postgres_image}"
          command:
            - sh
            - -c
            - |
              set -eu
              cp /tls-source/tls.crt /tls-source/tls.key /tls/
              chown "\$(id -u postgres)":"\$(id -g postgres)" /tls/tls.crt /tls/tls.key
              chmod 644 /tls/tls.crt
              chmod 600 /tls/tls.key
          volumeMounts:
            - name: tls-source
              mountPath: /tls-source
              readOnly: true
            - name: tls
              mountPath: /tls
      containers:
        - name: postgres
          image: "${managed_postgres_image}"
          args:
            - -c
            - ssl=on
            - -c
            - ssl_cert_file=/tls/tls.crt
            - -c
            - ssl_key_file=/tls/tls.key
          envFrom:
            - secretRef:
                name: managed-postgres-auth
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: tls
              mountPath: /tls
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "trueppm"]
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 30
      volumes:
        - name: tls-source
          secret:
            secretName: managed-postgres-tls
        - name: tls
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: managed-postgres
spec:
  selector:
    app: managed-postgres
  ports:
    - port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: managed-valkey
  labels:
    app: managed-valkey
spec:
  replicas: 1
  selector:
    matchLabels:
      app: managed-valkey
  template:
    metadata:
      labels:
        app: managed-valkey
    spec:
      containers:
        - name: valkey
          image: "${managed_valkey_image}"
          command: ["valkey-server", "--requirepass", "${valkey_password}"]
          ports:
            - containerPort: 6379
          # A bare TCP check rather than an authenticated PING: this probe
          # only has to answer "is the process up yet", and quoting a
          # generated password safely inside a probe's exec argv is not worth
          # the fragility — the real proof that auth actually works is the
          # chart's own /readyz deep check succeeding after install.
          readinessProbe:
            tcpSocket:
              port: 6379
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 20
---
apiVersion: v1
kind: Service
metadata:
  name: managed-valkey
spec:
  selector:
    app: managed-valkey
  ports:
    - port: 6379
      targetPort: 6379
EOF

  kubectl rollout status deployment/managed-postgres --namespace "$WALKTHROUGH_MANAGED_NAMESPACE" --timeout=180s \
    || fail "managed PostgreSQL (outside the chart) never became Ready — see its pod's describe/logs above"
  kubectl rollout status deployment/managed-valkey --namespace "$WALKTHROUGH_MANAGED_NAMESPACE" --timeout=120s \
    || fail "managed Valkey (outside the chart) never became Ready — see its pod's describe/logs above"

  # ---- the documented datastore Secrets ("values-prod.yaml already disables
  # the bundled datastores..."), pointing at the managed stand-in above via
  # its in-cluster Service DNS. sslmode=require here is a REAL negotiated TLS
  # handshake against a server that actually speaks TLS (see the init
  # container above) — not just a substring settings.prod's boot guard
  # happens to see, which a plaintext "managed" database would leave untested.
  log "creating trueppm-db / trueppm-cache Secrets (documented form)"
  kubectl create secret generic trueppm-db --namespace "$WALKTHROUGH_NAMESPACE" \
    --from-literal=url="postgres://trueppm:${pg_password}@managed-postgres.${WALKTHROUGH_MANAGED_NAMESPACE}.svc.cluster.local:5432/trueppm?sslmode=require"
  kubectl create secret generic trueppm-cache --namespace "$WALKTHROUGH_NAMESPACE" \
    --from-literal=url="redis://:${valkey_password}@managed-valkey.${WALKTHROUGH_MANAGED_NAMESPACE}.svc.cluster.local:6379"

  # ---- the documented my-values.yaml, reproduced verbatim from
  # deployment.md's own fenced block. scripts/check-helm-walkthrough-drift.py
  # asserts this stays byte-for-byte aligned with that block; the ingress
  # host override this kind-in-dind environment needs is passed separately as
  # a --set on the `helm install` call below, precisely so this file can stay
  # identical to what an operator would actually write.
  WALKTHROUGH_VALUES_FILE=/tmp/walkthrough-my-values.yaml
  cat >"$WALKTHROUGH_VALUES_FILE" <<'EOF'
# my-values.yaml (layered on top of values-prod.yaml at install time)
# Point the chart at the Secret created above. This reaches the API, the Celery
# worker, AND the migrate/bootstrap init containers — all of which import the
# same settings module and so hit the same startup checks.
envFrom:
  - secretRef:
      name: trueppm-env

# The managed datastores. These MUST be set under env: in the secretKeyRef
# form shown here (or as plain URL strings). The chart checks for them at render
# time and does not read the envFrom Secret above.
env:
  DATABASE_URL:
    secretKeyRef:
      name: trueppm-db
      key: url
  REDIS_URL:
    secretKeyRef:
      name: trueppm-cache
      key: url

# Required when the Secret sets TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true.
# Omit it if you configured S3 storage instead.
persistence:
  media:
    enabled: true
EOF
}

# ---- the documented admin-password command, run verbatim (#4027) -----------
# deployment.md's "Post-install" step names an exact command
# (`kubectl exec -n trueppm deployment/trueppm-api -- cat
# /run/trueppm/admin_password`) rather than a dynamic pod lookup. This proves
# THAT command works, which check_admin_password()'s label-based lookup (used
# by the other legs) does not.
check_admin_password_documented() {
  local admin_pw pw_file
  pw_file="${ADMIN_PASSWORD_FILE:-/run/trueppm/admin_password}"
  log "reading admin password with the documented command: kubectl exec -n ${WALKTHROUGH_NAMESPACE} deployment/${WALKTHROUGH_API_NAME} -- cat ${pw_file}"
  admin_pw="$(kubectl exec -n "$WALKTHROUGH_NAMESPACE" "deployment/${WALKTHROUGH_API_NAME}" -- \
    cat "$pw_file" 2>/dev/null || true)"
  [ -n "$admin_pw" ] \
    || fail "the documented admin-password command returned nothing — 'kubectl exec deployment/${WALKTHROUGH_API_NAME} -- cat ${pw_file}' no longer matches deployment.md, or create_admin did not write it"
  log "admin password present (${#admin_pw} chars) via the documented command"
}

# ---- beat: pinned singleton, Running, and it STAYS up ----------------------
# `--wait` already gates on beat's Deployment reporting its replica ready, but
# beat renders NO readiness probe (by design — see templates/celery-beat/
# deployment.yaml's own comment), so a container with no readiness gate counts
# as "ready" the instant it starts Running: `--wait` alone would not catch a
# beat stuck restart-looping on its liveness probe after that first tick.
# Runs for every leg (not just walkthrough) since it is cheap and was
# previously untested by any leg.
check_beat_health() {
  local beat_pod beat_restarts beat_phase
  beat_pod="$(kubectl get pod -l app.kubernetes.io/component=celery-beat -o jsonpath='{.items[0].metadata.name}')"
  [ -n "$beat_pod" ] || fail "no celery-beat pod found"
  beat_phase="$(kubectl get pod "$beat_pod" -o jsonpath='{.status.phase}')"
  [ "$beat_phase" = "Running" ] || fail "celery-beat pod is not Running (phase=${beat_phase:-<empty>})"
  beat_restarts="$(kubectl get pod "$beat_pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
  [ "${beat_restarts:-0}" -eq 0 ] \
    || fail "celery-beat restarted ${beat_restarts}x since rollout — the pinned singleton scheduler should not be restart-looping"
  log "celery beat pinned singleton Running with 0 restarts: $beat_pod"
}

# ---- diagnostics on any failure -------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (deploy did not reach a healthy state) ========" >&2
  kubectl get pods -A -o wide 2>&1 | sed "$INDENT_SED" >&2 || true
  # TEMPORARY (#4027 walkthrough-leg triage): PVC/PV binding state and node
  # capacity, neither previously captured — a pod stuck Pending gives no
  # other signal to tell "PVC unbindable on this StorageClass" apart from
  # "node has insufficient CPU/memory to schedule everything at once".
  echo "---- PersistentVolumeClaims (all namespaces) ----" >&2
  kubectl get pvc -A -o wide 2>&1 | sed "$INDENT_SED" >&2 || true
  echo "---- PersistentVolumes ----" >&2
  kubectl get pv -o wide 2>&1 | sed "$INDENT_SED" >&2 || true
  echo "---- StorageClasses ----" >&2
  kubectl get storageclass 2>&1 | sed "$INDENT_SED" >&2 || true
  echo "---- node describe (capacity/allocatable/conditions) ----" >&2
  kubectl describe nodes 2>&1 | sed "$INDENT_SED" >&2 || true
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
  # Walkthrough leg only (#4027): the managed-datastore stand-in lives in its
  # OWN namespace, which the loop above never sees (it only walks the current
  # context's namespace). A TLS misconfiguration on the managed Postgres is
  # exactly the kind of failure that needs its logs, not just "Ready: false".
  if [ "$DRILL_LEG" = "walkthrough" ]; then
    echo "---- managed-datastore namespace (${WALKTHROUGH_MANAGED_NAMESPACE}): pods ----" >&2
    kubectl get pods -n "$WALKTHROUGH_MANAGED_NAMESPACE" -o wide 2>&1 | sed "$INDENT_SED" >&2 || true
    for p in $(kubectl get pods -n "$WALKTHROUGH_MANAGED_NAMESPACE" -o name 2>/dev/null); do
      echo "---- describe ${WALKTHROUGH_MANAGED_NAMESPACE}/$p ----" >&2
      kubectl describe -n "$WALKTHROUGH_MANAGED_NAMESPACE" "$p" 2>&1 | sed "$INDENT_SED" >&2 || true
      echo "---- logs ${WALKTHROUGH_MANAGED_NAMESPACE}/$p (all containers, incl. init) ----" >&2
      kubectl logs -n "$WALKTHROUGH_MANAGED_NAMESPACE" "$p" --all-containers --prefix --tail=80 2>&1 | sed "$INDENT_SED" >&2 || true
    done
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
# Walkthrough leg (#4027) skips all of this: it creates its OWN namespace and
# Secret in setup_walkthrough_datastores(), reproducing deployment.md's
# commands verbatim rather than this generic derived-ALLOWED_HOSTS shape,
# which the doc's walkthrough never shows an operator running.
if [ "$DRILL_LEG" = "walkthrough" ]; then
  setup_walkthrough_datastores
else
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
# The demo leg's render has no Ingress (ingress.enabled=false, #4018's
# NetworkPolicy-guard comment above explains why), so the demo-probe reaches
# the deployment through the web Service's own in-cluster DNS name rather than
# an ingress host. templates/web/configmap.yaml's demo server block forwards
# that unchanged (`proxy_set_header Host $host;`) to Django on every
# /api/v1/share/... call, so without it here every one of those calls fails
# get_host()'s check with 400 DisallowedHost before section 10's allowlist
# matrix ever sees a real response — the two "public projection" checks and
# both throttle-property checks depend on it.
if [ "$DRILL_LEG" = "demo" ]; then
  allowed_hosts="${allowed_hosts},${demo_web_svc}.default.svc.cluster.local"
fi
log "ALLOWED_HOSTS=${allowed_hosts}"

log "creating trueppm-env secret"
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY="$secret_key" \
  --from-literal=ALLOWED_HOSTS="$allowed_hosts" \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$integration_key" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true
fi

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
elif [ "$DRILL_LEG" = "walkthrough" ]; then
  # ---- 4w. install exactly as deployment.md's "Install:" step shows (#4027) -
  # `-f "$CHART/values-prod.yaml" -f "$WALKTHROUGH_VALUES_FILE"` is the same
  # two-file layering the doc's own `helm install ... -f values-prod.yaml -f
  # my-values.yaml` command uses; scripts/check-helm-walkthrough-drift.py
  # asserts the flag shape stays aligned with that fenced block. Everything
  # past that point is CI-environment plumbing a real operator would not need
  # (image tag, celery probe timing, and the ingress host — see below), added
  # as --set overrides rather than folded into $WALKTHROUGH_VALUES_FILE so
  # that file can stay byte-identical to the documented my-values.yaml.
  #
  # ingress.hosts[0].host: values-prod.yaml turns the Ingress on but ships its
  # host EMPTY (a documented REQUIRED placeholder — see that file's own
  # comment); deployment.md's own text says to set it in my-values.yaml
  # ("values-prod.yaml also enables the Ingress and leaves its host ... empty
  # ... Set them in my-values.yaml too"). Left unset, `trueppm.probeHostHeader`
  # resolves to that empty string, and `{{- with ... }}` treats an empty
  # string as falsy (Go templates), so NO Host header renders on the api
  # probes at all — kubelet then sends `Host: <podIP>:8000`, which is in no
  # ALLOWED_HOSTS list, and every pod sits NotReady forever (#3183's exact
  # mechanism). trueppm.example.com is already the first ALLOWED_HOSTS entry
  # created above, matching this. No real Ingress controller runs on this kind
  # cluster — kubelet reaches the probe by pod IP regardless of DNS, so this
  # value never needs to resolve.
  #
  # CELERY_PROBE_OVERRIDES are the same runner-contention accommodation the
  # other three legs already need (#3218/#3346/#3692) — see that array's own
  # header comment. The chart's OWN probe defaults are unchanged; this is a
  # drill-only relaxation for shared CI runners, stated here and in
  # deployment.md's "Verifying a deploy" section rather than left implicit.
  log "helm install ${RELEASE} --namespace ${WALKTHROUGH_NAMESPACE} -f values-prod.yaml -f my-values.yaml (documented walkthrough, #4027)"
  helm install "$RELEASE" "$CHART" --namespace "$WALKTHROUGH_NAMESPACE" \
    -f "${CHART}/values-prod.yaml" -f "$WALKTHROUGH_VALUES_FILE" \
    --set image.tag="$RELEASE_IMAGE_TAG" \
    --set 'ingress.hosts[0].host=trueppm.example.com' \
    "${CELERY_PROBE_OVERRIDES[@]}" \
    --wait --timeout "$INSTALL_TIMEOUT"
  log "walkthrough rollout complete"
elif [ "$DRILL_LEG" = "demo" ]; then
  # ---- 4c. install the HEAD chart with values-demo.yaml layered on (#4018) -
  # No persistence.media here, unlike the other two branches: values-demo.yaml
  # deliberately does NOT enable it (its own SECRETS comment) — the demo-seed
  # Job's template does not mount that claim, so enabling the PVC would fix the
  # api pod's writability and leave the seed hook failing on a read-only root
  # filesystem. TRUEPPM_MEDIA_ROOT=/tmp (also in values-demo.yaml) is what
  # makes every pod's boot guard pass instead, using the emptyDir every pod
  # already mounts. DEMO_ARGS (baseUrl, both share tokens, the NetworkPolicy
  # confirmation) was assembled above, before section 1, since it needs no
  # live cluster.
  log "helm install ${RELEASE} with values-demo.yaml (image tag ${RELEASE_IMAGE_TAG})"
  helm install "$RELEASE" "$CHART" \
    "${DEMO_ARGS[@]}" \
    --set image.tag="$RELEASE_IMAGE_TAG" \
    "${CELERY_PROBE_OVERRIDES[@]}" \
    --wait --timeout "$INSTALL_TIMEOUT"
  log "demo rollout complete"
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
if [ "$DRILL_LEG" = "walkthrough" ]; then
  # The documented command (deployment.md "Post-install"), not the generic
  # label-based lookup — see check_admin_password_documented's own comment.
  check_admin_password_documented
elif [ "$DRILL_LEG" != "upgrade" ]; then
  check_admin_password
fi

# ---- 6b. beat: pinned singleton, Running, and it STAYS up (#4027) ----------
check_beat_health

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
# The demo leg's web tier is a completely different nginx server block
# (templates/web/configmap.yaml's `else if .Values.demo.enabled` branch, #2440):
# it has no web.adminAccess allow/deny logic at all — every /admin/ location is a
# flat `return 404;` — so a demo install correctly answers 404 here, not 403.
# Section 10 below asserts that same 404 again as part of the wider allowlist
# matrix; this earlier check still runs unconditionally for every leg because it
# is proving something narrower and unrelated to the allowlist (#2569 held even
# before demo mode existed).
if [ "$DRILL_LEG" = "demo" ]; then
  expected_admin_code="404"
else
  expected_admin_code="403"
fi
[ "$admin_code" = "$expected_admin_code" ] \
  || fail "/admin/ through the web tier (svc/${web_svc}) returned '${admin_code}', expected ${expected_admin_code} — a default install is publishing Django admin (#2569)"
log "admin denied at the web tier (HTTP ${expected_admin_code}) — deny-by-default holds at runtime"

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

# ---- 10. demo allowlist matrix + per-visitor throttle property (#4018) -----
# Everything above this point is generic chart health, shared with the other
# two legs. This is the runtime surface that ONLY exists under demo.enabled —
# an allowlist rendered correctly by helm:template still says nothing about
# what nginx actually returns for a given path, and #4017 (a single shared
# throttle bucket for the whole internet) is proof: it rendered clean, passed
# kubeconform, and passed every static grep.
if [ "$DRILL_LEG" = "demo" ]; then
  log "waiting for the demo-seed post-install hook to complete"
  demo_seed_job="$(kubectl get job -l app.kubernetes.io/component=demo-seed -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$demo_seed_job" ] || fail "no demo-seed Job found (component=demo-seed) — did the chart actually render demo.enabled? (#4018)"
  # Belt-and-braces: Helm always blocks on a hook's own completion before
  # `helm install` above can return, regardless of --wait, so this should
  # never actually wait. Asserted explicitly so a future Helm/hook-ordering
  # change that broke that assumption fails HERE with a clear message
  # instead of a confusing 404 a few lines down.
  kubectl wait --for=condition=complete "job/${demo_seed_job}" --timeout=180s \
    || fail "demo-seed hook (job/${demo_seed_job}) did not reach Complete — see its pod logs above"
  seed_log_tail="$(kubectl logs "job/${demo_seed_job}" -c demo-seed 2>&1 | tail -3 || true)"
  log "demo-seed hook complete — log tail: ${seed_log_tail}"

  log "starting an in-cluster probe pod for the demo allowlist matrix (ingress-nginx namespace, admitted by the web-ingress NetworkPolicy — same placement as the admin-probe above)"
  kubectl run demo-probe -n ingress-nginx \
    --image="$API_IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
    --command -- sleep 3600
  kubectl wait --for=condition=Ready pod/demo-probe -n ingress-nginx --timeout=60s \
    || fail "demo-probe pod never became Ready"

  log "asserting the demo allowlist matrix and the #4017 per-visitor throttle property"
  if ! kubectl exec -i demo-probe -n ingress-nginx -- env \
      WEB_HOST="${demo_web_svc}.default.svc.cluster.local" \
      SCHEDULE_TOKEN="$DEMO_SCHEDULE_TOKEN" \
      BOARD_TOKEN="$DEMO_BOARD_TOKEN" \
      python -u - <<'PYEOF'
import os
import sys
import urllib.error
import urllib.request

host = os.environ["WEB_HOST"]
schedule_token = os.environ["SCHEDULE_TOKEN"]
board_token = os.environ["BOARD_TOKEN"]

failures = []


def req(method, path, xff=None):
    url = "http://%s%s" % (host, path)
    r = urllib.request.Request(url, method=method)
    if xff:
        r.add_header("X-Forwarded-For", xff)
    try:
        resp = urllib.request.urlopen(r, timeout=15)
        return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()
    except Exception as e:
        return None, "UNREACHABLE:%s" % e, b""


def check(label, method, path, expect_status, expect_ct_contains=None, xff=None):
    status, ct, body = req(method, path, xff=xff)
    ok = status == expect_status and (
        expect_ct_contains is None or expect_ct_contains in (ct or "")
    )
    print("%s: %s -> %s %s" % ("OK" if ok else "FAIL", label, status, ct))
    if not ok:
        want = "status=%s" % expect_status
        if expect_ct_contains:
            want += " content-type~%r" % expect_ct_contains
        failures.append(
            "%s: got status=%s content-type=%r, expected %s" % (label, status, ct, want)
        )
    return ok


# --- allowlist matrix -------------------------------------------------------
check("GET / (redirects to the schedule share link)", "GET", "/", 200, "text/html")
check(
    "GET /share/schedule/<token> (SPA route)",
    "GET",
    "/share/schedule/%s" % schedule_token,
    200,
    "text/html",
)
check(
    "GET /share/board/<token> (SPA route)",
    "GET",
    "/share/board/%s" % board_token,
    200,
    "text/html",
)
projection_ok = check(
    "GET /api/v1/share/schedule/<token>/ (public projection)",
    "GET",
    "/api/v1/share/schedule/%s/" % schedule_token,
    200,
    "application/json",
)
check(
    "GET /api/v1/share/board/<token>/ (public projection)",
    "GET",
    "/api/v1/share/board/%s/" % board_token,
    200,
    "application/json",
)

for path in (
    "/admin/",
    "/admin/login/",
    "/api/v1/projects/",
    "/api/v1/auth/token/",
    "/api/v1/users/me/",
    "/ws/",
    "/api/schema/",
):
    check("GET %s (must be absent from the demo)" % path, "GET", path, 404)

for method in ("POST", "PUT", "DELETE"):
    status, ct, body = req(method, "/api/v1/share/schedule/%s/" % schedule_token)
    ok = status == 403 and b"demo_read_only" in body
    print(
        "%s: %s /api/v1/share/schedule/<token>/ -> %s %r"
        % ("OK" if ok else "FAIL", method, status, body[:200])
    )
    if not ok:
        failures.append(
            "%s write to a share projection: got status=%s body=%r, expected 403 demo_read_only"
            % (method, status, body[:200])
        )

# nginx resolves both literal ".." and percent-encoded "%2e%2e" (and merges
# "//") before location matching, so every one of these lands under /api/
# (or, for the last one, /admin/) and must still 404 rather than reach a
# route the plain path would never have matched.
for path in (
    "/api/v1/share/../admin/",
    "/api/v1/share/%2e%2e/admin/",
    "//admin/",
    "/api/v1/share/../../../admin/",
):
    check("traversal GET %s" % path, "GET", path, 404)

# nginx location matching is case-sensitive; none of these match /api/ or
# /admin/, so they fall through to the SPA — never proxied to Django.
for path in ("/API/v1/projects/", "/Admin/", "/ADMIN/"):
    check(
        "case-variant GET %s (falls to the SPA, never proxied)" % path,
        "GET",
        path,
        200,
        "text/html",
    )

# --- per-visitor throttle property (#4017) ----------------------------------
# share_access defaults to 60/min. Burn visitor A's whole bucket, then prove
# visitor B — a DIFFERENT X-Forwarded-For value — gets an untouched one.
# NUM_PROXIES=2 (values-demo.yaml) is what makes DRF key on the FIRST
# X-Forwarded-For entry (the client's own claim) rather than the web tier's
# own appended peer address — the exact regression #4017 found: at
# NUM_PROXIES=1 every visitor collapses into one shared bucket.
#
# Gated on the plain projection GET above having actually reached the
# throttle (status 200): a precondition failure upstream (a host-validation
# 400, a 5xx, anything that never reaches DRF's throttle check) makes every
# request in the loop below fail identically, and an identical failure reads
# exactly like "the bucket is shared" even though the bucket was never
# consulted. Without this gate, that precondition failure prints as
# "#4017 regression" — the label a reader trusts least to be wrong.
if not projection_ok:
    failures.append(
        "throttle: skipped — the plain GET /api/v1/share/schedule/<token>/ check "
        "above did not return 200, so no request in this section ever reached "
        "share_access's throttle in the first place (see that check's own failure "
        "for the real cause; this is a precondition failure, not a #4017 regression)"
    )
else:
    XFF_A = "203.0.113.10"
    XFF_B = "203.0.113.20"
    saw_429 = False
    last_status = None
    for _ in range(61):
        last_status, _, _ = req(
            "GET", "/api/v1/share/schedule/%s/" % schedule_token, xff=XFF_A
        )
        if last_status == 429:
            saw_429 = True
            break
    if saw_429:
        print("OK: visitor A (%s) throttled to 429 within 61 requests" % XFF_A)
    else:
        failures.append(
            "throttle: visitor A (%s) never saw a 429 within 61 requests (last status %s) "
            "— share_access is not enforcing a per-visitor limit" % (XFF_A, last_status)
        )

    status_b, _, body_b = req(
        "GET", "/api/v1/share/schedule/%s/" % schedule_token, xff=XFF_B
    )
    if status_b == 200:
        print(
            "OK: visitor B (%s) got 200 while visitor A is throttled — distinct "
            "X-Forwarded-For values get distinct buckets (#4017)" % XFF_B
        )
    else:
        failures.append(
            "throttle: visitor B (%s) got %s while visitor A (%s) was throttled, expected "
            "200 — distinct X-Forwarded-For values are NOT getting distinct buckets "
            "(#4017 regression)" % (XFF_B, status_b, XFF_A)
        )

if failures:
    print("=== FAILURES (%d) ===" % len(failures))
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL DEMO ALLOWLIST + THROTTLE ASSERTIONS PASSED")
PYEOF
  then
    fail "the demo allowlist matrix and/or the #4017 throttle property did not hold — see the probe output above"
  fi
  log "demo allowlist matrix + per-visitor throttle property GREEN (#4018, #4017)"
fi

if [ "$DRILL_LEG" = "upgrade" ]; then
  log "HELM UPGRADE DRILL GREEN — ${PREV_CHART_VERSION} -> HEAD upgraded cleanly; admin retrievable (pre-upgrade pod, #3964), NetworkPolicy transition guard refused then passed (#4000), admin denied at edge, worker pinned+Ready+serving, guards fail closed"
elif [ "$DRILL_LEG" = "walkthrough" ]; then
  log "HELM WALKTHROUGH DRILL GREEN (#4027) — named namespace, values-prod.yaml, managed PostgreSQL (TLS, sslmode=require) + Valkey reached via env.*.secretKeyRef all boot per deployment.md; admin retrievable via the documented kubectl exec command, admin denied at edge, worker+beat pinned/Ready/serving, guards fail closed"
elif [ "$DRILL_LEG" = "demo" ]; then
  log "HELM DEMO DRILL GREEN — values-demo.yaml boots, seed hook completed, allowlist matrix holds (200 on /, /share/*, /api/v1/share/*; 404 elsewhere incl. admin/projects/auth/users/ws/schema; 403 demo_read_only on writes; traversal/double-slash variants 404; case variants fall to the SPA), per-visitor throttle buckets distinct (#4017), admin retrievable, worker pinned+Ready+serving, guards fail closed"
else
  log "HELM INSTALL DRILL GREEN — chart boots, admin retrievable, admin denied at edge, worker pinned+Ready+serving, guards fail closed"
fi
