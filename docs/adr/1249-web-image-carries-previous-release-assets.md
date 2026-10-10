# ADR-1249: The web image carries the previous release's hashed assets

## Status
Accepted (2026-10-10)

Accepted by the project owner ("fix at the ADR level") with two corrections,
recorded in the Amendments section at the end. Decision steps 2 and 3 and the
Implementation Notes test plan are read through those amendments.

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
    own ghcr image pinned by digest, and the copy is limited to the files the prior
    image's `asset-files.json` lists under `assets/` (see Amendments). Nothing executable runs from it at build time. Its cosign
    signature is deliberately not verified before the copy: it is our own ghcr
    image, pulled by an immutable digest the resolver read from that same
    registry, and only static files under `assets/` are taken from it, so a
    signature check would add a tool to the build job without changing what can
    reach the image.
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
  currently untested. (Resolved at acceptance for the resolution logic: see
  Amendments.)

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
- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1249` (2026-10-10: 1175
      open issues scanned, 0 written before acceptance).
- [x] Any issue carrying pre-ADR scope rewritten (title and body), led by a dated
      correction note. Count: 0.

## Amendments (2026-10-10, at acceptance)

1. **Withdrawn releases are skipped (step 3).** 0.4.0-beta.7 blank-screened
   every visitor and installs were rolled back to 0.4.0-beta.6. Read literally,
   step 3 would have beta.8 carry beta.7's assets, which no open tab holds. The
   resolver (`scripts/resolve-prev-web-image.sh`) drops every version in
   `SKIP_PREV_WEB_VERSIONS` (default `0.4.0-beta.7`) before picking, the same
   list and default as `SKIP_PREV_CHART_VERSIONS` in the Helm drill (#4346), so
   the demo-upgrade drill's pre-upgrade release and the image's inherited
   assets are the same release. The rule is otherwise unchanged: the highest
   published SemVer tag below HEAD, which is the same-line tag when one exists
   and the previous line's last tag otherwise. Two modes: `--below <tag>` for
   the publish jobs (an image never inherits from itself, even on a re-run), and
   `--at-or-below <package.json version>` for per-commit builds, whose version
   is the last cut release.
2. **Releases before `asset-manifest.json` (step 2).** The manifest arrived
   with !2965, after beta.7, so the first image built under this ADR has no
   prior manifest to copy by. When the prior image has no file list (as
   implemented, `asset-files.json`; see the clarification below on why not the
   manifest), its whole `assets/` directory is copied. That is
   still one release: an image built before this ADR only ever held its own
   build. The prior-release gate (step 4) takes the same fallback, checking the
   prior image's `assets/` listing; with nothing to check it logs SKIPPED with
   the reason and never reports a pass, and callers that know a prior release
   exists set `SERVED_ASSETS_PRIOR_REQUIRED=1` to make that a failure.

**Further clarifications from implementation.**

- *Resolution failure vs. nothing to resolve.* Durable Execution item 8 says a
  resolution failure produces a "no prior assets" build. Implemented, that
  applies only when nothing is published below HEAD. An unreadable registry
  fails the job: building without prior assets because a network call failed
  would ship the blank screen this ADR removes, and nothing downstream would
  notice.
- *Path safety.* Every name taken from the prior image (manifest entry or
  directory listing) must be a normalized relative path under `assets/` with no
  `.`/`..` or empty segments, and a regular file, not a symlink. Anything else
  fails the build (`packages/web/scripts/collect-prior-assets.mjs`). The prior
  image is bind-mounted read-only in a throwaway stage; nothing from it runs.
- *MR coverage.* The publish jobs run only on a tag, from the tag's own CI
  file. `ci:build-deploy-images` runs the same resolver, build arg, and
  prior-asset smoke on every MR that builds the web image, so the path is
  proven before a release cut depends on it.
- *Forward-direction retry (step 5).* The retry wraps every route `lazy()`
  import and does not run while `navigator.onLine === false`. A browser that
  caches a failed module fetch for the page's lifetime fails each retry at
  once, which only brings the existing reload forward; the retry is never
  worse than not retrying, but the "probability ≥ ½ per attempt" in step 5
  holds only where the browser refetches.
- *The reference list is `asset-files.json`, not the Vite manifest (amends
  steps 2 and 4).* Vite's `asset-manifest.json` omits the CPM worker chunk that
  `new Worker(new URL(...))` emits, so copying by it would drop the worker one
  upgrade after the first ADR-1249 image, and a gate checking by it would not
  notice. A build plugin (`trueppm:asset-files` in `packages/web/vite.config.ts`)
  writes `asset-files.json`, every file the build wrote under `assets/`, read
  back from disk. The copy and the prior-release gate both use it. An image
  without it was built before ADR-1249 and holds only its own build, so the
  whole-`assets/` fallback in amendment 2 keys on that file's absence, not the
  manifest's. Found by the completeness check at acceptance.
- *Previous-line fallback test.* The test-plan note that the previous-line
  fallback is untested is resolved: `scripts/tests/resolve-prev-web-image.test.sh`
  exercises it directly (first 0.5 image → last 0.4.x; 1.3.0 → 1.2.x), so no
  separate follow-up issue is needed for the resolution logic. Proving it
  against a real minor-to-minor upgrade drill is still a GA checklist item.
