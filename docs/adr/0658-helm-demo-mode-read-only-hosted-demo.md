# ADR-0658: Helm demo mode — read-only hosted demo via the production chart

## Status

Accepted — status corrected 2026-07-29 after ADR audit (#2539, verified:
`packages/helm/templates/demo-seed-job.yaml`, `values-demo.yaml`, `helm:template` CI job
rendering it).

## Context

`docker-compose.demo.yml` (#1487) is currently the only path to a public read-only
TruePPM demo. The Helm chart — the deployment path we document as production — has
**no demo mode at all**: no seed Job, no share-link Job, no `noindex` handling, and in
fact no `kind: Job` template of any kind. The 0.4 launch gate (#2271) requires
"try.trueppm.com hosted demo deployed", which today can only be satisfied by running
Compose on a box, contradicting our own deployment guidance.

Three forces shape the decision:

1. **The demo should exercise the real topology.** A demo deployed by a bespoke Compose
   file proves the Compose file works. A demo deployed by the chart proves the chart
   works — and the chart is what operators will use. This argues for minimizing how far
   demo mode diverges from a normal release.

2. **The read-only posture is load-bearing, and it is enforced at the edge — not by the
   absence of accounts.** The tempting phrasing ("the demo has no user accounts") is
   false: the api Deployment's `bootstrap` initContainer runs `create_admin` on every
   deploy, and `seed_demo_project` then grants that superuser `Role.ADMIN` on the demo
   projects. The compose demo has exactly the same superuser. What actually makes both
   safe is `nginx/demo.conf.template` (#1487, hardened #1763): a route **allowlist**
   under which `/admin/`, `/ws/`, and every `/api/` route except the two share
   projections and the liveness probe return 404. The authenticated API is not
   protected on the public demo — it is *absent* from it.

   This distinction is not pedantry. The first implementation of this ADR reused the
   chart's production web config, which blanket-proxies `/api/`, `/ws/` and `/admin/`,
   and would have published the full authenticated API plus a Django admin login for a
   known-username superuser to the internet — while the ADR text asserted the opposite.
   Security review (#2440) caught it. Any change that widens the allowlist invalidates
   this argument rather than bending it.

   The only mutation reachable anonymously is `share_services.record_access()`, an
   `F("access_count") + 1` metering bump. Writable per-visitor sandboxes are explicitly
   out of scope and tracked as post-beta epic #1672 — per the two-repo rule, the
   multi-tenancy that would make them safe is an Enterprise concern, unavailable in OSS.

3. **The current demo shows a Gantt and nothing else.**
   `create_demo_share_link.py` hard-codes `content_kind=ShareContentKind.SCHEDULE`
   (line 129), yet `ShareContentKind` already carries `BOARD`, `/share/board/<token>`
   already routes, and `ShareLink.Meta` (models.py:3628-3633) has **no** uniqueness
   constraint on `project` + `content_kind`. Sharing the board as well costs no
   additional attack surface — both kinds are anonymous, GET-only, and pass through the
   same hardened `_serve_public_share` envelope — and no migration.

## Decision

### D1 — `demo.enabled` gates a post-install/post-upgrade hook Job

A new `templates/demo-seed-job.yaml`, wrapped in `{{- if .Values.demo.enabled }}` per the
chart's established conditional convention (`web.enabled`, `ingress.enabled`,
`backup.enabled`, …), annotated:

```yaml
helm.sh/hook: post-install,post-upgrade
helm.sh/hook-weight: "0"
helm.sh/hook-delete-policy: before-hook-creation
```

It runs `seed_demo_project` (without `--with-personas` — no persona logins, preserving
the no-accounts premise) followed by `create_demo_share_link`.

### D2 — The seed Job carries its own `migrate` initContainer

Helm does **not** wait for Deployments to become Ready before running `post-install`
hooks unless `--wait` is passed. The seed Job therefore cannot assume the api
Deployment's `migrate` initContainer (`templates/api/deployment.yaml:43-47`) has
completed — it would race it and fail on missing tables. Rather than depend on an
operator remembering a flag, the Job runs its own `python manage.py migrate --noinput`
initContainer. `migrate` is idempotent, so the duplicate is free.

### D3 — `hook-delete-policy: before-hook-creation` only, never `hook-succeeded`

`create_demo_share_link` prints the public share URLs to stdout. Deleting the Job on
success destroys the only in-cluster record of them. Keeping the completed Job leaves
`kubectl logs` as a working recovery path. The Job is replaced (not accumulated) on the
next upgrade by `before-hook-creation`.

### D4 — Celery stays enabled in demo mode

Demo mode does **not** disable `celery-worker` / `celery-beat`. ADR-0081 established
that Beat is a silent SPOF and that "single-pod deployments — the common OSS shape —
have no redundancy", making Beat/worker load-bearing for drains, purges, and health
across every deployment shape. Carving a demo-only exception would require new
`celeryWorker.enabled` / `celeryBeat.enabled` values keys that also touch the production
path, and would leave any unanticipated enqueue silently queued forever.

The Compose demo omits Celery because Compose is a throwaway stack; the chart's demo is
a real release and should look like one. The cost is two small pods, sized down via the
existing `resources.worker` / `resources.beat` keys — no new template surface.

### D5 — Two pinned tokens; `TRUEPPM_DEMO_SHARE_TOKEN` keeps schedule semantics

`ShareLink.token_hash` is `unique=True` **globally** (models.py:3580), so one raw token
cannot back both a schedule and a board link. `create_demo_share_link` gains a second
input, `TRUEPPM_DEMO_SHARE_TOKEN_BOARD` / `--token-board`; the existing
`TRUEPPM_DEMO_SHARE_TOKEN` continues to mean *the schedule token*, so every existing
`docker-compose.demo.yml` invocation keeps working unchanged.

**Pinning is mandatory under Helm, not optional.** `seed_demo_project` is destructively
idempotent — it deletes prior demo projects and re-seeds — and `ShareLink.project` is
`on_delete=CASCADE`, so every `helm upgrade` drops the share links. With pinned tokens
they are recreated at identical URLs and the public link survives; without them the
public URL silently changes on every upgrade. The chart therefore fails fast with a
clear message when `demo.enabled` is true and either token is unset.

Tokens live in `values-demo.yaml`, not a Secret: a share token is a public URL component,
and the server persists only `sha256_hex(token)`.

### D6 — `create_demo_share_link` mints both kinds

Three hard-coded values become per-kind: the `content_kind` (lines 108/129/154), the
single `DEMO_LABEL` constant (line 43 — used as the idempotency match key, so two kinds
would otherwise collide on lookup), and the `/share/schedule/` URL path (line 133). The
command prints both URLs. Default behavior with only the legacy token set remains
schedule-only.

### D7a — Demo mode renders a different nginx server block: an allowlist

`templates/web/configmap.yaml` branches on `demo.enabled` and emits an entirely
separate server block mirroring `nginx/demo.conf.template`, with the upstream swapped
for the release-scoped Service DNS name. Only `^~ /api/v1/share/` and
`= /api/v1/health/` are proxied; `/api/`, `/ws/` and `/admin/` return 404.

A separate block, rather than the production one plus extra headers, because the
difference that matters is *which routes exist* — and because a patch-style diff makes
it far too easy to reintroduce a blanket proxy during a later edit.

One deliberate divergence from the compose template: `/admin/` returns 404 rather than
`allow 127.0.0.1; deny all;`. Behind an ingress the client IP is the ingress pod, not
the operator, so a loopback allowlist is either useless or accidentally permissive
depending on proxy configuration. The in-cluster equivalent of compose's SSH tunnel is
`kubectl port-forward svc/<release>-trueppm-api 8000:8000`.

**CI gate.** `scripts/check-demo-nginx-allowlist.sh` gates the compose template only,
and the `helm:template` job previously rendered default values exclusively — so demo
mode would have shipped entirely unvalidated. That job now also renders
`values-demo.yaml`, runs kubeconform over it, asserts that `/admin/`, `/ws/` and
`/api/` each return 404 while the share projections stay proxied, and asserts the
inverse: that no demo artifact leaks into a default render. Consolidating these
assertions into the shared allowlist script is worthwhile later; the inline form is
deliberate for now because it also covers the leak direction, which the script does
not model.

### D7 — `noindex` is owned by the web ConfigMap, not ingress annotations

`templates/ingress.yaml:28-31` passes `ingress.annotations` through verbatim with no
snippet mechanism, and the chart is deliberately controller-agnostic (nginx *or*
traefik via `ingress.className`). Expressing `X-Robots-Tag` as an
`nginx.ingress.kubernetes.io/configuration-snippet` would hard-code an nginx-ingress
dependency into the demo path. `templates/web/configmap.yaml` already renders the nginx
`default.conf`; it gains the `X-Robots-Tag: noindex, nofollow` header and a
`location /robots.txt` returning `Disallow: /`, both gated on `demo.enabled`.

### D8 — `values-demo.yaml` is a fragment, and must set the ADR-0245 kill switch

`values-dev.yaml` overrides only `image.pullPolicy`, establishing the convention that
environment files are fragments layered on `values.yaml` rather than standalone
documents. `values-demo.yaml` follows suit (`helm install -f values-demo.yaml`).

It **must** set `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED`. Per ADR-0245 (and reaffirmed by
ADR-0265, which explicitly rejected a second switch as an operational footgun), that one
flag gates *both* share kinds. If it is unset the demo deploys cleanly, serves a working
app, and 404s every share URL — a silent, hard-to-diagnose failure.

### D9 — `cloudflared` stays out of the chart

Cloudflare Tunnel is cluster ingress topology, not application topology. Bundling it
would make the app chart opinionated about how traffic arrives and couple every operator
to one CDN vendor. Precedent: ADR-0186 deferred in-cluster deployment for the MCP server
on the same boundary reasoning.

### D10 — Chart documentation is public; the instance runbook is not

The deployment *mechanics* are ordinary OSS documentation and carry no disclosure risk:
what `demo.enabled` does, that `values-demo.yaml` exists, that the share links are the
demo's only entry point, and that TLS terminates upstream. Without them the feature is
undiscoverable and operators misconfigure it — D8's kill-switch trap is exactly the kind
of failure public documentation prevents. This lives in `packages/helm/README.md`.

The **instance runbook stays out of this repository**. Not because k3s or Cloudflare
Tunnel are secrets — they are neither, and recommending a tunnel is a security
improvement (no inbound ports, origin IP concealed) — but because a runbook written as
"how *we* run the public demo" necessarily discloses hostname, tunnel and account
identifiers, node layout, backup locations, and, most importantly, **co-tenancy between
a public internet-facing service and build infrastructure**. That last item is the real
disclosure: it maps a blast radius, and no amount of read-only hardening on the
application mitigates it.

The split is therefore by *subject*, not by topic: documentation about **the chart** is
public; documentation about **a deployment** is private. A generic, instance-free "TruePPM
on single-node k3s" guide would be legitimate public content and may be written later —
it is simply out of scope here, and must not be produced by sanitizing the private
runbook, which reliably leaves residue.

### D11 — `values-demo.yaml` bakes no secrets, unlike the Compose demo

`docker-compose.demo.yml` bakes `SECRET_KEY` / `INTEGRATION_ENCRYPTION_KEY` and
documents them as safe under the no-accounts premise. Demo mode under Helm
deliberately does **not** copy that, and instead uses the chart's existing
`envFrom` / operator-created-Secret path.

The premise is sound for Compose but the blast radius differs: a `values.yaml` is
copied and adapted far more often than a throwaway demo Compose file, and a known
`SECRET_KEY` reaching a real deployment is a much worse outcome than one extra
`kubectl create secret` during demo setup. The chart already has a first-class secret
mechanism; using it removes the footgun entirely at negligible cost.

The pinned share tokens are different and *do* live in values: they are public URL
components by construction (the server persists only `sha256_hex(token)`), not
credentials. D5 ships no default for them — the chart fails fast — so no live token
ever enters the repository either.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Hook Job + values fragment (chosen)** | Uses the real chart; minimal divergence from a production release; no new prod-path values keys | Introduces the chart's first `Job` template and first install-time hook |
| B. Keep Compose for the hosted demo | Zero chart work; already shipped and hardened | Contradicts our own "Helm is production" guidance; leaves the chart untested for the demo posture; #2271 stays blocked on a non-chart path |
| C. Seeding as another initContainer on the api Deployment | Reuses the existing bootstrap pattern; no hooks | Re-seeds on *every pod restart*, not every release — a crash-loop would repeatedly wipe demo state; couples demo data to pod lifecycle |
| D. Separate `trueppm-demo` chart | Total isolation of demo concerns | Duplicates the entire chart; guarantees drift; the demo would no longer prove the production chart works |
| E. Disable Celery in demo mode | ~2 fewer pods | Conflicts with ADR-0081; needs new `enabled` keys touching the prod path; unanticipated enqueues queue forever |
| F. Single share token for both kinds | One input to manage | Impossible — `token_hash` is globally unique |

## Consequences

**Easier**

- #2271's "try.trueppm.com deployed" line is satisfiable via the documented production path.
- The demo becomes a continuous integration test of the real chart: if the chart breaks, the demo visibly breaks.
- The demo shows both the schedule *and* the board, covering the scheduling-first-with-agile-overlay pitch rather than half of it.
- `helm upgrade` self-heals demo state — destructive re-seed plus pinned tokens means drift is impossible and URLs are stable.

**Harder**

- The chart gains its first install-time hook, a new concept for contributors to learn.
- `create_demo_share_link` grows a second token input; the docs must be explicit that pinning is mandatory under Helm.
- Two more values (`demo.enabled`, the token pair) that a misconfiguration can silently break — mitigated by the fail-fast check in D5 and the kill-switch note in D8.

**Risks**

- **The no-write-path premise is load-bearing.** Demo mode's security argument rests
  entirely on zero accounts and no authenticated write path. Any future change that
  adds one — persona logins, an anonymous comment box, a writable sandbox — invalidates
  this ADR's reasoning and must revisit it rather than inherit it. D11 removes the
  baked-secret exposure, but not this dependency.
- **Destructive re-seed.** Anyone who mistakenly sets `demo.enabled: true` against a real
  instance will have `seed_demo_project` delete projects named "Platform Migration" /
  "Pilot Deployment". The values key is documented as demo-only and defaults to `false`.
- **Public exposure of a self-hosted box.** Publishing a demo makes the host reachable
  from the internet. The chart does not terminate TLS — that is upstream — and the chart
  README must say so. Operators co-locating the demo with other workloads (CI runners,
  private services) inherit a shared blast radius that no application-level hardening
  addresses; per D10 that consideration belongs in a private runbook, not this repo.

## Implementation Notes

- **P3M layer**: Programs and Projects (the demo exhibits a single program's projects; no cross-program aggregation).
- **Affected packages**: `helm` (templates, values, README), `api` (one management command). No `docs/` change — per D10 the instance runbook is private.
- **Migration required**: **No.** `ShareLink.Meta` already permits multiple links per project across kinds; `content_kind` already includes `BOARD` (migration `0112_sharelink_expires_at_alter_sharelink_content_kind.py`).
- **API changes**: No endpoint, serializer, or permission changes. One management command gains arguments; its default behavior is unchanged.
- **OSS or Enterprise**: **OSS.** Self-hosted deployment is squarely OSS; `grep -r trueppm_enterprise packages/` returns only comments and docs prose, zero imports.

### Durable Execution

1. **Broker-down behaviour**: N/A for the new code path. The seed Job runs two synchronous
   management commands inside a Kubernetes Job; it dispatches no Celery task and writes no
   outbox row. `seed_demo_project` seeds a `MonteCarloRun` row directly rather than
   enqueuing the async engine, precisely so the forecast renders without a worker.
2. **Drain task**: None required. No new category of async work is introduced. Existing
   drains continue to run because D4 keeps Beat and the worker enabled.
3. **Orphan window**: N/A — no outbox rows are written by this feature.
4. **Service layer**: N/A. The commands call `share_services.mint_share_link()` (already the
   service-layer entry point for share links) and the existing seeder; no new dispatch path
   is created, so no new `services.py` function is needed.
5. **API response on best-effort dispatch**: N/A — no API endpoint is added or changed.
6. **Outbox cleanup**: N/A — no outbox rows. Existing nightly purges are unaffected and
   continue to run under D4.
7. **Idempotency**: The Job is safe to re-run. `seed_demo_project` is explicitly idempotent
   by destructive replacement (deletes prior demo projects by name inside
   `@transaction.atomic`, then re-seeds). `create_demo_share_link` in pinned mode keys on
   `token_hash` — the idempotency key — and reuses an existing row rather than minting a
   duplicate. The Kubernetes Job's own `backoffLimit` bounds retries; a retried Job re-runs
   both commands, which converges to the same state.
8. **Dead-letter / failure handling**: Job `backoffLimit: 2`. On exhaustion the hook fails,
   which fails the Helm release — deliberately loud, because a demo that deployed without
   data is broken and must not report success. The completed/failed Job is retained
   (D3) so `kubectl logs` gives the operator the actual traceback. No dead-letter row is
   involved; this is install-time work, not runtime queue work.

## Related

- #2440 — implementing issue
- #2271 — 0.4 launch-gate checklist (unblocked by this)
- #1487 — the Compose read-only demo this ports from
- #1763 — the Compose nginx allowlist hardening that D7a mirrors
- #2476 — `seed_demo_project`'s unscoped destructive delete (pre-existing; this ADR automates the command, raising its stakes)
- #1672 — ephemeral writable trial instances (post-beta; deliberately not this)
- ADR-0245 — public read-only board share links; owns the `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` kill switch
- ADR-0265 — tokenized public schedule share links; rejected a second kill switch
- ADR-0081 — Beat liveness; the constraint behind D4
- ADR-0186 — precedent for keeping deployment topology out of the app chart
- ADR-0114 — seed schema v2, synthetic-data labeling so demo history is not mistaken for a real audit trail
