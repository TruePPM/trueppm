---
title: Troubleshooting
description: Symptom-keyed diagnosis for a self-hosted TruePPM install — blank pages, 502s, dead WebSockets, stalled Celery, pending migrations, image-pull failures, false "unhealthy" containers, and unstyled admin pages.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
Two things this page relies on are new in **TruePPM 0.4**, the first beta, and are
**not** in `v0.3.0-alpha.3`, the latest release:

- **`GET /api/v1/readyz`**, used by most of the checks below. On 0.3 there is no
  dependency-aware endpoint — use `/api/v1/health/` for process liveness and read
  the container logs for the rest.
- **The Helm chart's `web`, `probes`, `podDisruptionBudget`, and `backup` values.**
  On 0.3 the chart has none of them, so the Kubernetes commands that name a
  `-web` Deployment or a readiness probe apply from 0.4 onward.

Everything else — the Compose commands, the three admin health endpoints
(`health/beat/`, `health/dead-letter/`, `health/system/`), the Celery and
migration diagnosis, and the `ALLOWED_HOSTS` and `/static/` cases — applies to
0.3 as well.
:::

Find your symptom, work the causes in the order listed — they are ordered by how
often they are the answer, not by how interesting they are — and confirm the fix
with the check at the end of each section.

Two commands are worth running before anything else, because roughly half of all
incidents are answered by them.

**Docker Compose**

```bash
docker compose ps
# STATUS column: every service should read "Up" and the ones with healthchecks
# (db, valkey, api) should read "(healthy)". "(unhealthy)" or "Restarting" names
# your culprit; "Exit 1" means read that service's logs first.
```

**Helm / Kubernetes**

```bash
kubectl get pods -n <namespace> -l app.kubernetes.io/instance=<release> -o wide
# READY 1/1 and STATUS Running on every pod. Note the NODE column — it is the
# answer to "why did two replicas die together?"
```

Throughout this page, `<release>` is your Helm release name and `<ns>` your
namespace. The application Deployments are `<release>-trueppm-api`, `-web`,
`-celery-worker`, and `-celery-beat`; if your release name already contains
"trueppm" the chart drops the duplicate, so a release called `trueppm` yields
plain `trueppm-api`. The bundled datastores are named by their own subcharts and
do **not** carry the `trueppm` segment: `<release>-postgresql-0` and
`<release>-valkey-primary-0`. Confirm with `kubectl get deploy,sts -n <ns>`.

---

## The browser shows a blank page

**What you see.** The page loads, the tab title is right, and the viewport is
white. No error text. The browser console usually shows a failed request for a
`.js` bundle, or a `Failed to fetch` against `/api/v1/…`.

**Likely causes, in order.**

1. **The web tier is not serving the bundle.** On Compose the `web` container is
   still building (first run compiles the SPA — see below); on Helm the `-web`
   Deployment has zero ready pods.
2. **The API is unreachable from the browser**, so the SPA boots and then fails
   its first data fetch. This is the same underlying condition as a 502, one layer
   up.
3. **A CSP or MIME-type mismatch** in front of the SPA — usually an ingress, WAF,
   or CDN adding its own `Content-Security-Policy` on top of the one the web tier
   already sets, so the bundle is blocked. The console names the directive.

**Commands.**

```bash
# Compose (dev) — is the web service up, and did the Vite build finish?
docker compose ps web
docker compose logs --tail=50 web

# Compose (prod) — the SPA is built once by `web-build` and served by `nginx`
docker compose -f docker-compose.prod.yml logs --tail=50 web-build nginx

# Helm — is anything behind the web Service?
kubectl get deploy,endpoints -n <ns> -l app.kubernetes.io/instance=<release>
kubectl logs -n <ns> deploy/<release>-trueppm-web -c web --tail=50
```

Then check what the browser is actually being served:

```bash
curl -sI https://trueppm.example.com/ | head -5
# Expect: HTTP/2 200 and content-type: text/html
```

**Confirm the fix.** Reload with the console open. `GET /` returns `200
text/html`, every `/assets/*.js` returns `200 application/javascript`, and the
first `/api/v1/` call returns `200` or `401` — not `502` or `0`.

:::tip[First `docker compose up` on a clean clone]
The development Compose stack **builds** the API and web images from source and
runs `npm install` in the web container. First start is a multi-minute build, not
15 seconds, and the web container serves nothing until Vite finishes. Watch it
with `docker compose logs -f web` and wait for the `ready in …` line before
deciding anything is broken.
:::

---

## nginx returns 502 Bad Gateway

**What you see.** `502 Bad Gateway` from nginx (Compose-prod) or from the ingress
controller (Helm), on `/api/…` and often on `/` too.

**Likely causes, in order.**

1. **The API process is not listening.** It crashed on a boot guard —
   `settings.prod` refuses to start without `SECRET_KEY`, `ALLOWED_HOSTS`,
   `INTEGRATION_ENCRYPTION_KEY`, and a storage choice — and the container is in a
   restart loop.
2. **The API pods are all `NotReady`,** so the Service has no endpoints and the
   ingress has nowhere to route. This is almost always a datastore outage: see
   [the 503 case](#every-request-returns-503-and-no-api-pod-is-ready).
3. **The API is up but slow past the proxy timeout** — a Monte Carlo run or a
   whole-project schedule load on a large project. Check the [tested
   envelope](/administration/sizing/#tested-envelope).

**Commands.**

```bash
# Compose — did the API die on a boot guard?
docker compose logs --tail=100 api | grep -Ei "improperlyconfigured|refus|traceback"
docker compose ps api

# Helm — restart count and the reason for the last exit
kubectl get pods -n <ns> -l app.kubernetes.io/component=api
kubectl describe pod -n <ns> <api-pod> | sed -n '/Last State/,/Ready/p'
kubectl logs -n <ns> <api-pod> -c api --previous --tail=100

# Is anything behind the Service at all?
kubectl get endpoints -n <ns> <release>-trueppm-api
```

An `ENDPOINTS` column reading `<none>` is the whole diagnosis: nothing is ready,
and the 502 is the proxy telling you so.

**Confirm the fix.** `kubectl get endpoints` lists at least one pod IP, and:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://trueppm.example.com/api/v1/health/
# → 200
```

---

## Every request returns 503 and no API pod is ready

**What you see.** The SPA loads, every API call returns `503`, and
`kubectl get pods` shows `READY 0/1` on every API pod while the containers are
`Running` and not restarting.

**Likely causes, in order.**

1. **Valkey is unreachable.** `/api/v1/readyz` performs a live `set`-then-`get`
   round-trip against the cache, so a broker outage marks **every** API pod
   `NotReady` and empties the Service. This is by far the most common cause and it
   surprises people, because the database is fine. See [Durability &
   Redundancy](/administration/durability/#health-and-readiness-endpoints).
2. **PostgreSQL is unreachable**, which fails the same probe on the `database`
   check.
3. **Migrations do not match the image** — see [the migrations
   case](#a-pod-never-becomes-ready-or-migrations-are-pending) below.

**Commands.** Ask the probe which of the three it is. The endpoint tells you
directly, and the runtime image has no `curl`, so port-forward and ask from your
workstation — remembering the `Host` header (see [the false-unhealthy
case](#a-container-reports-unhealthy-while-the-site-works-fine)):

```bash
kubectl port-forward -n <ns> svc/<release>-trueppm-api 8000:8000
```

```bash
curl -s -H 'Host: trueppm.example.com' http://127.0.0.1:8000/api/v1/readyz
# {"status":"fail","checks":{"database":"ok","cache":"fail","migrations":"ok"},
#  "migration_state":"in_sync"}
```

The failing key in `checks` is your component. On Compose the equivalent is:

```bash
docker compose exec api python -c \
  "import urllib.request as u, urllib.error as e; \
   print(u.urlopen('http://127.0.0.1:8000/api/v1/readyz').read().decode())" \
  2>&1 | tail -3
```

Then confirm the datastore itself:

```bash
docker compose exec valkey valkey-cli ping          # → PONG
docker compose exec db pg_isready -U trueppm        # → accepting connections

# Where Valkey requires a password (docker-compose.prod.yml and the Helm chart's
# default auth.enabled: true), an unauthenticated ping returns NOAUTH, not PONG:
docker compose -f docker-compose.prod.yml exec valkey \
  sh -c 'valkey-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'
kubectl exec -n <ns> <release>-valkey-primary-0 -- \
  sh -c 'valkey-cli -a "$VALKEY_PASSWORD" ping'
kubectl exec -n <ns> <release>-postgresql-0 -- pg_isready -U trueppm
```

**Confirm the fix.** `/api/v1/readyz` returns `200` with every key in `checks`
reading `ok`, and `kubectl get pods` returns to `READY 1/1`.

---

## WebSockets do not connect (no live updates)

**What you see.** The app works, but nothing updates until you refresh, and the
status bar reports the connection as lost. The browser console shows the socket
closing shortly after opening.

**Likely causes, in order.**

1. **The proxy is not upgrading the connection.** The WebSocket route is
   `/ws/v1/projects/<uuid>/`. On Compose-prod, `nginx/app.conf.template` proxies
   `/ws/` with `proxy_http_version 1.1`, the `Upgrade` / `Connection` headers, and
   an 86400 s read timeout. On Helm the default `ingress.hosts[].paths` sends
   `/ws` to the **API** Service — if you rewrote that list and dropped the `/ws`
   entry, or put it after `/`, the socket lands on the SPA instead.
2. **An intermediary is closing idle connections.** Cloud load balancers,
   corporate proxies, and some WAFs cap idle WebSocket lifetime well below the
   application's. Symptom: it connects, works, and dies on a fixed interval.
3. **The close code says it is not a network problem at all.** `4001` is "no valid
   credential", `4003` is "authorization revoked or membership removed", `4404` is
   "no consumer at that path". A `4003` will retry forever and never succeed —
   the user's project access was removed, and re-granting it is the fix.

**Commands.** Read the close code first; it decides everything else.

```javascript
// Browser console, on the affected page
new WebSocket("wss://trueppm.example.com/ws/v1/projects/<project-uuid>/")
  .addEventListener("close", (e) => console.log(e.code, e.reason));
```

```bash
# Did the request even reach Django?
kubectl logs -n <ns> deploy/<release>-trueppm-api -c api --tail=200 | grep -i "ws/v1"
docker compose logs --tail=200 api | grep -i "ws/v1"

# Helm: confirm /ws routes to the API Service and precedes /
kubectl get ingress -n <ns> <release>-trueppm -o yaml | grep -A 4 "path:"
```

**Confirm the fix.** The socket reaches `readyState 1` and stays there, and a
change made in a second browser appears in the first without a refresh.

---

## Celery is not processing anything

**What you see.** Schedules do not recalculate, imports sit at "queued",
notification email never arrives. Reads all work.

**Likely causes, in order.**

1. **The worker is down or crash-looping.** Nothing consumes the queue.
2. **Beat is down.** The worker is healthy and idle, because nothing is
   *dispatching* — the fourteen 30-second outbox drains and every nightly job are
   Beat-scheduled. This looks identical from the outside, which is why Beat has
   its own detector.
3. **The broker is unreachable.** In that case the API is also 503 — work [the
   503 case](#every-request-returns-503-and-no-api-pod-is-ready) instead.
4. **The work failed permanently and was dead-lettered.** It is not queued, it is
   parked.

**Commands.** Distinguish (1) from (2) first — this is the single most useful
check on this page:

```bash
# Beat heartbeat. 200 = beat is alive, 503 = stale (default threshold 120 s).
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $ADMIN_JWT" \
  https://trueppm.example.com/api/v1/health/beat/
```

```bash
# Is a worker connected to the broker at all?
docker compose exec celery celery -A trueppm_api.celery inspect ping
kubectl exec -n <ns> deploy/<release>-trueppm-celery-worker -c celery-worker -- \
  celery -A trueppm_api.celery inspect ping
# → {'celery@<host>': {'ok': 'pong'}}

# What is actually queued or running?
docker compose exec celery celery -A trueppm_api.celery inspect active
docker compose logs --tail=100 celery celery-beat
kubectl logs -n <ns> deploy/<release>-trueppm-celery-beat -c celery-beat --tail=100
```

If the heartbeat is fresh and workers answer `pong`, check whether the work was
dead-lettered rather than lost:

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  https://trueppm.example.com/api/v1/health/dead-letter/
# Prometheus text: trueppm_task_dead_letter_parked{task_name="..."} <n>
```

Anything above zero is triaged from **Settings → Workspace → System health** — see
[Dead-letter Alerting](/administration/dead-letter-alerting/).

**Confirm the fix.** `inspect ping` answers, `/api/v1/health/beat/` returns `200`,
and a fresh edit to a task's duration produces a recalculated schedule within a
few seconds.

:::note[Nothing is lost while this is broken]
Outbox-backed work is recorded in PostgreSQL, not in the queue. Every task carries
`acks_late=True` and `reject_on_worker_lost=True`, and the drains re-dispatch
orphaned rows. Restoring the worker or Beat drains the backlog. See [Why losing the
broker does not lose the
work](/administration/durability/#why-losing-the-broker-does-not-lose-the-work).
:::

---

## A pod never becomes ready, or migrations are pending

**What you see.** `READY 0/1` indefinitely, or `Init:0/2`, or an init container
in `CrashLoopBackOff`. On Compose, the API logs loop on `DB not ready yet` or exit
during `migrate`.

**Likely causes, in order.**

1. **The database is not reachable yet.** The Compose API command retries
   `migrate` every 2 s until the database answers, which is normal for the first
   30–60 s and abnormal after that.
2. **The image's migrations do not match the schema.** `/readyz` reports
   `migration_state` as one of `in_sync`, `behind`, `ahead`, or `unknown`, and a
   pod is only ready on `in_sync`. `behind` means this image ships migrations the
   database has not applied — normal *during* a rollout, a stuck migrate init
   container if it persists. `ahead` means the database is newer than this image,
   which is what a rollback without a schema restore looks like.
3. **Concurrent `migrate` at two or more replicas.** Every API pod runs the
   `migrate` init container, and Django takes no cross-process lock. Losing pods
   can exit non-zero and restart until the winner finishes — expect a few init
   restarts on the first rollout at `replicaCount >= 2`, and see [Singletons and
   one-per-pod work](/administration/durability/#singletons-and-one-per-pod-work)
   before an upgrade carrying a long migration.
4. **A boot guard.** `settings.prod` refuses to import without `SECRET_KEY`,
   `ALLOWED_HOSTS`, `INTEGRATION_ENCRYPTION_KEY`, and a storage choice — and the
   guard fires in the **init containers too**, so the pod dies before the `api`
   container ever starts.

**Commands.**

```bash
# Which init container, and why
kubectl describe pod -n <ns> <api-pod> | sed -n '/Init Containers/,/^Containers/p'
kubectl logs -n <ns> <api-pod> -c migrate
kubectl logs -n <ns> <api-pod> -c bootstrap

# What does the database think is applied?
kubectl exec -n <ns> deploy/<release>-trueppm-api -c api -- \
  python manage.py showmigrations --plan | grep -c '^\[X\]'
docker compose exec api python manage.py showmigrations | grep -v '\[X\]'
```

**Confirm the fix.** `showmigrations` shows no unapplied entries, and
`/api/v1/readyz` returns `200` with `"migration_state":"in_sync"`.

---

## Image pull failure

**What you see.** `ErrImagePull` or `ImagePullBackOff` in `kubectl get pods`, or
`manifest unknown` / `denied` from `docker compose pull`.

**Likely causes, in order.**

1. **The tag does not exist.** The chart pins itself to `v<appVersion>` when
   `image.tag` is empty, and the release pipeline only ever pushes the
   **v-prefixed** tag — a bare `0.4.0` will never pull. The Compose production file
   references `ghcr.io/trueppm/{api,web}`, which is the forward-looking public path;
   through 0.3 the images live on the GitLab Container Registry, so a GHCR pull
   404s until the first tag lands there.
2. **No pull credentials** for a private registry. The chart sets no
   `imagePullSecrets`, so a private registry needs one attached to the namespace's
   default ServiceAccount, or supplied through your own patch.
3. **No outbound network.** The nodes cannot reach the registry at all — an
   air-gapped or egress-filtered cluster. Mirror the images into an internal
   registry and set `image.repository` / `image.webRepository` to point at it.

**Commands.**

```bash
kubectl describe pod -n <ns> <pod> | sed -n '/Events/,$p'
# The Warning Failed event carries the exact registry error.

# Which tag is the chart actually asking for?
helm get values -n <ns> <release> --all | grep -A 4 '^image:'

# Can you pull it by hand from a machine on the same network?
docker pull registry.gitlab.com/trueppm/trueppm/api:v0.3.0-alpha.3
```

**Confirm the fix.** `kubectl get pods` leaves `ImagePullBackOff` and the pod
reaches `Running`.

---

## A container reports `unhealthy` while the site works fine

**What you see.** `docker compose ps` shows `api (unhealthy)`, or Kubernetes
restarts the API pod on its liveness probe — yet the application serves correctly
in the browser.

**Likely cause: `ALLOWED_HOSTS`.** The health check reaches the API on
`localhost` / the pod IP, so Django sees `Host: localhost` (or `Host: 10.x.x.x`).
`settings.prod` sets `ALLOWED_HOSTS` from the environment with no implicit
entries, so if your list contains only `trueppm.example.com`, Django rejects the
probe's request with `400 Bad Request (DisallowedHost)` — while every real request,
which arrives with the right `Host`, is served normally.

**Commands.**

```bash
# The tell: 400s in the log whose only client is the health check
docker compose logs --tail=100 api | grep -i "disallowedhost\|invalid HTTP_HOST"
kubectl logs -n <ns> <api-pod> -c api --tail=100 | grep -i "invalid HTTP_HOST"

# Reproduce it deliberately — same URL, two Host headers
kubectl port-forward -n <ns> svc/<release>-trueppm-api 8000:8000
curl -s -o /dev/null -w 'no host header: %{http_code}\n' http://127.0.0.1:8000/api/v1/health/
curl -s -o /dev/null -w 'real host:      %{http_code}\n' \
  -H 'Host: trueppm.example.com' http://127.0.0.1:8000/api/v1/health/
# 400 then 200 confirms it.
```

**The fix**, per platform:

- **Compose** — add `localhost,127.0.0.1` to `ALLOWED_HOSTS` in `.env`, alongside
  your real hostname. The healthchecks in both Compose files request
  `http://localhost:8000/api/v1/health/`, so those two entries are what they need.
- **Kubernetes** — the kubelet addresses the probe to the **pod IP**, which
  changes on every reschedule, so listing it is not an option. Give the probe an
  explicit `Host` header matching a name already in `ALLOWED_HOSTS`, via
  `httpGet.httpHeaders` on the probe. Adding the whole pod CIDR as a wildcard is
  not equivalent — `ALLOWED_HOSTS` does not accept CIDRs, only exact names and
  leading-dot suffixes.

`ALLOWED_HOSTS` is supplied through the Secret referenced by `envFrom`; see
[Configuration](/administration/configuration/).

**Confirm the fix.** `docker compose ps` reads `(healthy)`, the `DisallowedHost`
lines stop, and the pod's `RESTARTS` count stops climbing.

---

## `/static/` returns 404, or Django admin is unstyled

**What you see.** `/admin/` renders as unstyled HTML — readable, no CSS — and the
browser console shows `404` for `/static/admin/css/base.css`. The rest of the app
is unaffected, because the SPA's own assets are served from the web tier's own
filesystem, not from `/static/`.

**Likely causes, in order.**

1. **`collectstatic` has not populated `STATIC_ROOT`, or the serving container
   cannot see what it collected.** WhiteNoise serves `/static/` out of
   `STATIC_ROOT`; if that directory is empty, every file 404s. The dev Compose API
   command runs `collectstatic --noinput` on start. `docker-compose.prod.yml`
   collects in the one-shot `api-init` service and shares the output with the `api`
   service through the `static_files` named volume — **both** services must set
   `STATIC_ROOT: /app/staticfiles`, or `api-init` reports a clean collect into a
   directory `api` never reads. On Kubernetes the target is the `staticfiles`
   `emptyDir`, which is empty on every fresh pod until something fills it.
2. **The proxy is not forwarding `/static/` to the API.** Both nginx configs
   (`nginx/app.conf.template` for Compose, the web tier's ConfigMap for Helm)
   proxy `location /static/` to the API. A custom ingress that routes only `/api`
   and `/ws` to the API Service sends `/static/` to the SPA instead, where it hits
   the `try_files … /index.html` fallback and returns HTML with a `200`.

The second cause has a distinctive signature: the request succeeds but the
response is `text/html`, and the browser refuses to apply it as a stylesheet.

**Commands.**

```bash
# Is anything there to serve?
docker compose exec api ls /app/staticfiles/admin/css | head
kubectl exec -n <ns> deploy/<release>-trueppm-api -c api -- ls /app/staticfiles | head

# What is actually being returned?
curl -sI https://trueppm.example.com/static/admin/css/base.css | head -3
# Want: 200 + content-type: text/css
# 404              → cause 1 (nothing collected)
# 200 + text/html  → cause 2 (routed to the SPA fallback)
```

If the directory is empty, populate it:

```bash
docker compose exec api python manage.py collectstatic --noinput
kubectl exec -n <ns> deploy/<release>-trueppm-api -c api -- \
  python manage.py collectstatic --noinput
```

Note that on Kubernetes this fixes **one pod until it restarts** — the target is an
`emptyDir`. A durable fix populates the volume as part of pod startup or bakes the
collected files into the image.

**Confirm the fix.** `curl -sI` on a static path returns `200` with
`content-type: text/css`, and `/admin/` renders styled.

---

## The Helm admin password is gone

**What you see.** `kubectl exec … -- cat /run/trueppm/admin_password` returns
`No such file or directory`.

This is expected, not a fault: the file lives on a per-pod `emptyDir` written by
the `bootstrap` init container, and `create_admin` is a deliberate no-op once a
superuser exists. After any pod restart or `helm upgrade` the password is gone
permanently, and it cannot be regenerated.

Reset it instead of hunting for it — the full procedure, including the
multi-replica caveat, is in [Admin password
setup](/administration/admin-password/).

---

## Related pages

- [Verify your install](/getting-started/installation/#verify-your-install) — the
  per-service checks to run before you conclude anything is wrong.
- [Durability & Redundancy](/administration/durability/) — the failure-mode matrix
  behind these symptoms.
- [System Health](/administration/system-health/) — the same diagnosis from the
  UI, without a shell.
- [Beat Liveness](/administration/beat-liveness/) — the singleton scheduler and its
  heartbeat.
- [Deployment](/administration/deployment/) — the topologies these commands assume.
