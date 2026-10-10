# ADR-1249: The web image carries the previous release's hashed assets

## Status
Proposed

## Context

#4341 found the cause of the beta.7 blank screen: **web version skew during a rolling
update.** `index.html` from one release references content-hashed chunks
(`/assets/<name>-<hash>.js`), and a pod running the other release does not have those
chunks. `values-prod.yaml` runs `replicaCount: 2`, and the web Deployment sets no
`strategy:`, so it gets Kubernetes' default RollingUpdate. Both versions are `Ready` and
serving for the whole rollout.

Already merged mitigations. They make the failure loud and self-healing, but they do not
remove it:
- !2962 — `location /assets/ { try_files $uri =404; }` in every SPA server block, so a
  missing chunk returns a real 404 instead of `200 text/html`. A `vite:preloadError`
  handler (`packages/web/src/lib/chunkReload.ts`) reloads the page at most once per
  window.
- !2965 — Vite emits `asset-manifest.json`, and `scripts/check-served-assets.sh` checks
  every file it names, including lazy chunks, against what the image serves.

The skew has **two directions**, and they behave differently:

| Direction | Who hits it | How long it lasts |
|---|---|---|
| **Backward** — a client holds release N's `index.html` and requests an N chunk from an N+1 pod | Every tab opened before the upgrade, the next time it lazy-loads a route it has not visited yet | **Indefinitely after the rollout ends**, until that tab reloads. This is the long tail. |
| **Forward** — a client got N+1's `index.html` from a new pod and requests an N+1 chunk from an N pod | Clients that load the app *during* the rollout | **Only during the rollout window** (seconds to minutes). It ends when the last N pod terminates. |

The backward direction matters more. It outlives the rollout. It also hits single-replica
installs, not just HA ones: a Recreate rollout, or a single-replica rolling update,
replaces the pod and every tab that was open before it is exposed. The forward direction
needs two versions serving at once, so only multi-replica installs hit it.

P3M layer: not applicable. This is a deployment and runtime concern of the OSS web tier.

**GA requirement (2026-10-10, set by the project owner).** Once TruePPM reaches GA
(1.0), every supported upgrade path — one minor version at a time (1.2→1.3, 1.3→1.4,
…) — must complete without blank-screening a client still holding the previous
minor's web assets. Scope is **sequential only**: an arbitrary skip (1.2→1.9 in one
step) is not a supported upgrade path and is not covered. This is now a hard
acceptance bar for this ADR, not a nice-to-have — see the resolution rule in Decision
step 3 and the CLAUDE.md policy this ADR is paired with.

## Decision

**Every published web image also serves the hashed assets of the release immediately
before it.**

1. The web `Dockerfile` gets a `PREV_WEB_IMAGE` build arg. The default is empty, which
   means no prior assets. Local and dev builds stay hermetic and need no network.
2. When the arg is set, the serve stage copies **only the files named in the prior
   image's own `asset-manifest.json`** into `/usr/share/nginx/html/assets/`, and then the
   current build's `dist/` goes on top. Copying by the prior image's manifest, instead of
   its whole `assets/` directory, keeps the set to exactly one prior release. Copying the
   directory would carry N-2, N-3 and so on forward forever, because each prior image
   already contains its own predecessor's files.
   - Content-hashed names cannot collide with different content. A file present in both
     builds is byte-identical, so overwrite order does not matter for `assets/`.
   - Only `assets/` is inherited. `index.html`, `asset-manifest.json`, the service-worker
     or PWA files if any are added later, and every other root file always come from the
     current build.
3. The publish pipeline (`web:publish`) resolves `PREV_WEB_IMAGE` to the **digest** of
   the most recently published web image tag, full stop — not scoped to the current
   `major.minor` line. Concretely: the latest tag within the current line if one
   exists (`0.4.0-beta.8` → `0.4.0-beta.7`'s digest), **else the latest published tag
   of the immediately previous line** (the first `1.3.0` → the last tag published
   under `1.2.x`, typically `1.2.0` itself at GA, since a shipped line stops
   publishing new tags). That fallback is what makes a sequential **minor-to-minor**
   upgrade — not just a beta/rc bump within one line — covered by this mechanism, per
   the GA requirement above. It passes a digest, not a tag, so the build is
   reproducible and a re-pushed tag cannot change it.
4. `scripts/check-served-assets.sh` gains a prior-release pass. Given the prior image's
   manifest, every file it names must be served `2xx` with the right MIME type by the
   **new** image. That makes the guarantee a gate, not a property someone believes the
   Dockerfile has.
5. The **forward direction is accepted as residual**, bounded by the rollout window. It
   is handled client-side by extending `chunkReload.ts`: retry the failed dynamic
   `import()` up to twice, with short backoff, before falling back to the existing
   one-time reload. A round-robined retry lands on an N+1 pod with probability ≥ ½ per
   attempt, and is certain once the last N pod is gone.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Bake N-1 assets into the image (chosen)** | No new infrastructure. Works the same under Helm, compose, and any orchestrator. Fixes the long-tail backward direction permanently, not just during the rollout. Gateable in the existing publish check. Satisfies the sequential-minor GA requirement via the previous-line fallback in step 3. ~5.7 MB more per image (one extra `assets/` set). | Does not fix the forward direction. Its window is bounded and handled by client retry. Covers only **one** prior *published tag*: a self-hoster jumping beta.5→beta.7 (skipping an intermediate pre-release within the same line) gets beta.6's assets, not beta.5's, so tabs open from before that particular jump fall back to the !2962 reload. That is accepted pre-GA. The GA requirement is about sequential **minor** upgrades, which this does cover — see the previous-line fallback. The publish build now depends on a previously published artifact (pinned by digest). |
| B. Shared RWX PVC that accumulates assets; an init container copies each pod's `assets/` in before the pod is Ready | Fixes **both** directions: new chunks are on the shared volume before any new pod can hand out a new `index.html`. Retains any number of releases. | Needs a ReadWriteMany storage class, which many clusters (and the default classes on EKS, GKE, k3s local-path) do not have. With RWO, multi-replica pods on different nodes fail to schedule. That is exactly the HA case this is for. Adds a pruning policy, a stateful volume to an otherwise stateless tier, and a chart-wide failure mode. Rejected as the default. It could be an opt-in value later if a real operator asks. |
| C. External object store / CDN for assets (Vite `base` → bucket URL, append-only upload at publish) | Fixes both directions and serves assets off-pod. The standard answer at large scale. | Vite `base` is compile-time, so a per-install bucket URL needs runtime rewriting of `index.html` and chunk import specifiers. Every self-hoster has to run a bucket. Breaks air-gapped installs. A large operational step for a self-hosted OSS tier, which fails the "fewer moving parts" test. Rejected. |
| D. nginx peer fallback: on an `/assets/` miss, proxy to a headless Service and `proxy_next_upstream` on 404 | Could fix the forward direction with no storage. | Upstream resolution of a headless Service in nginx needs a `resolver`, and a variable `proxy_pass` loses multi-server `next_upstream`. It needs a loop guard between peers. It only works from the release that ships it onward. Too clever to trust in the serving path. Rejected. |
| E. Blue/green Service selector cutover | Removes the forward direction: only one version serves after the switch. | Needs two Deployments and a selector flip that Helm does not do natively. The flip itself is not atomic across kube-proxy instances. It still needs A for the backward direction. Disproportionate for the residual it removes. Not now. |
| F. `strategy: Recreate` | No mixed versions at all. | Downtime on every upgrade, and the backward direction is untouched. Rejected. |

## Consequences

- **Easier:** upgrades no longer blank-screen tabs opened before the upgrade, on any
  install shape, as long as the upgrade is from the immediately previous release. The
  !2962 reload becomes the fallback for version jumps, not the main path.
- **Harder:** the web publish job now resolves and pulls the prior image. A missing prior
  image (the first release on a new line, or a deleted package version) must be an
  explicit, logged "no prior assets" build, not a failure. Otherwise the first `0.5`
  image cannot be built. The rule: resolve within the same `major.minor` line first,
  then fall back to the latest published tag of the previous line, else none.
- **Risks:**
  - *Supply chain:* the serve stage copies files from a prior published image. It is our
    own ghcr image pinned by digest, and the copy is limited to manifest-named files
    under `assets/`. Nothing executable runs from it at build time.
  - *Stale-chunk semantics:* an N tab running N's JS against an N+1 API is the API
    compatibility question, and it exists today. This ADR stops it surfacing as a missing
    chunk, and does not make it worse.
  - *Image growth* is bounded at one extra release's `assets/`, by construction of the
    manifest-scoped copy. The prior-release gate would fail loudly if that bound broke.
- **Observed, not decided here:** `docker-compose.prod.yml`'s `web-build` init runs
  `cp -r` into the persistent `frontend_dist` volume and never clears it, so compose
  installs already accumulate **every** release's assets, unbounded. That is accidental
  backward-compatibility plus unbounded growth. Once A ships, the volume could be cleared
  before the copy. That is a separate change.

## Implementation Notes
- P3M layer: none (deployment/runtime).
- Affected packages: web (`Dockerfile`, `src/lib/chunkReload.ts`), CI (`web:publish`
  prior-digest resolution), `scripts/check-served-assets.sh` (prior-release pass + self-test
  cases), docs (`administration/` upgrade page: what is and is not covered, including
  the one-release limit).
- Migration required: no.
- API changes: no.
- OSS or Enterprise: OSS. Single-cluster upgrade robustness is inside the basic-HA
  carve-out.
- Test plan: self-test cases for the prior-release pass (prior-manifest file missing →
  fail; no prior manifest supplied → skipped with a logged reason, not passed); vitest
  for the import retry (retry succeeds → no reload; both retries fail → existing reload
  path; offline → no retry); the Helm demo-upgrade drill (#4340) asserts, after upgrade,
  that every file in the **pre-upgrade** release's manifest is still served. The current
  drill (!2964) exercises a same-line jump (`0.4.0-beta.6`→`0.4.0-beta.7`), which proves
  the same-line resolution path but not the previous-line fallback. **Before GA**, add a
  drill leg (or a unit test against the resolution script) that exercises the
  previous-line fallback directly — the GA requirement depends on that path and it is
  currently untested. Tracked as a follow-up, not implemented in this ADR.

### Durable Execution
1. Broker-down behaviour: N/A. Build-time and static-serving change, no async dispatch.
2. Drain task: N/A. No async work.
3. Orphan window: N/A.
4. Service layer: N/A. No API code.
5. API response on best-effort dispatch: N/A. No endpoint.
6. Outbox cleanup: N/A.
7. Idempotency: the build is deterministic given the prior image **digest**. Re-running
   the publish with the same inputs produces the same `assets/` set.
8. Dead-letter / failure handling: a prior-image resolution failure produces a logged
   "no prior assets" build (first release on a line), not a publish failure. The
   prior-release gate fails the publish only when a prior manifest *was* supplied and a
   file it names is not served.

### On Acceptance
- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1249`
- [ ] Any issue carrying pre-ADR scope rewritten (title and body), led by a dated
      correction note. Record the count, including zero.
