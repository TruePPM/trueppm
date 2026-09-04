# Security release cadence

When TruePPM cuts a release for a security fix, what it means when it does not, and the
triage that produced the rule. Written for the person reading it during an incident.

`SECURITY.md` is the public contract; this file is the maintainer-side reasoning behind
it. If the two ever disagree, `SECURITY.md` is what we promised and this file is wrong.

Recorded 2026-09-01 (#3318).

## The release trigger

**An out-of-band release is warranted when the fix changes the artifact a user on the
latest tag is running.**

That is the whole rule. Severity is the wrong axis and reaching for it is what makes this
decision get re-derived at 2am:

- A CRITICAL in a **build-toolchain** package — `browserslist`, `postcss`, `js-yaml`,
  `sharp`, `brace-expansion` under the eslint tree — runs on the machine that compiles
  the bundle and never inside it. A self-hoster on the latest tag was never exposed. The
  red `security:osv` job blocked **development**, not users. Land it, rebase, move on.
- A MODERATE in **shipped runtime code** — the API, the web bundle, the Helm chart, the
  scheduler, the MCP server, or a dependency any of them actually loads — is in the
  artifact the operator is running right now. That is what a release is for.

The test to apply, in order:

1. Does the fix touch `packages/api`, `packages/web`, `packages/scheduler`,
   `packages/wasm-scheduler`, `packages/mcp`, `packages/mobile`, `packages/helm`, or a
   shipped deployment manifest? → **artifact-affecting**.
2. Is it a dependency bump? Then ask what loads it. `devDependencies`, lockfile-only
   transitives under eslint/babel/metro/Astro, and anything reached solely by the docs
   site are **toolchain**. A dependency the running app imports is **artifact-affecting**
   — `dompurify` reached through `jspdf` for PDF export is the worked example (#2789):
   the same package name was toolchain in the docs site and runtime in the web app, in
   one fragment.
3. Is it a CI gate, a drill script, a test, or a perf harness? → **toolchain**. A gate
   that proves a fix cannot regress is not itself a fix.

Write the answer into the changelog fragment at the time of the fix, not later. The 99
fragments triaged below were classifiable **only** because their authors recorded the
reachability analysis when the memory was fresh; a fragment that says "bumped X to Y" and
nothing else costs a fresh investigation.

## What this repo does NOT do, and why

There is **no backport path**. `scripts/release.sh` bumps from the current `main`
(`major|minor|patch|alpha|beta|rc|release|<explicit>`, all computed off the current
version); there is no from-tag mode, and #3318 deliberately did not add one.

Adding one would not have helped. As of 2026-09-01 `main` is **3,507 commits** past
`v0.3.0-alpha.3` (2026-06-29), and **80 of the 99 pending security fragments are
artifact-affecting**. Cherry-picking eighty fixes — permission gates, serializer field
removals, Helm template changes, a Django minor bump — onto a 64-day-old alpha tag is not
a backport; it is a re-implementation with none of the CI history that made each one
safe. A `0.3.1` claiming to carry them would be a worse artifact than the alpha it
replaced.

So the pre-1.0 policy is: **security fixes ship in the next release of the line under
development.** The way to shorten a self-hoster's exposure window is to cut releases more
often, not to invent a backport lane. `SECURITY.md`'s Supported Versions table promises
backports for the two most recent minors **once `1.0.0` is released** — that is when a
from-tag mode in `release.sh` becomes necessary, and that is the right time to build it.

## Triage of the pending fragments (2026-09-01)

99 `changelog.d/*.security.md` fragments were pending on `main`. Classified by the rule
above:

| | Count |
|---|---|
| Artifact-affecting — in the running product | **80** |
| Build/dev toolchain, CI, tests, docs site — not in the artifact | **19** |

### Overdue call-out

`SECURITY.md` previously promised a patch release within 30 days for Critical/High. Of
the 80 artifact-affecting fixes, **50 were merged more than 30 days ago and are still
unreleased**; the oldest landed 2026-07-02, 61 days before this record. None is past 90
days.

Two honesty notes on that number:

- It counts days since the **fix merged**, which is the only date the repo holds. The
  policy's clock started at **report**, which is earlier — so 50 is a floor, not the
  figure.
- These fragments carry no severity field, so "50 overdue" is not "50 overdue
  Critical/High". Severity lives in the originating issue and the OSV advisory, not here.
  A severity-per-fragment field would make this checkable; nothing requires one today.

The decision recorded for these 50: **accept, and clear them by cutting the 0.4 beta.**
Not by backport, for the reasons above. This is a deliberate acceptance, not an oversight
— which is the entire point of writing it down.

### Not artifact-affecting (19)

Each of these was verified against what the fragment itself records about reachability.

| Fragment | Why it does not reach the shipped artifact |
|---|---|
| `2259` | `js-yaml` and transitive `brace-expansion` in the web/docs-site lockfiles. Every consumer is build-time: eslint config loading, Redocly, Astro (confirmed by #2786's own analysis). |
| `2285` | `brace-expansion` in mobile. The fragment states the affected copies are dev-only (eslint toolchain) and never shipped in the app bundle — a lockfile-only patch. |
| `2361` | `postcss`, an explicit `devDependency` of `packages/web`. |
| `2363` | `brace-expansion`, dev-only in `packages/web`. The brace patterns reaching `expand()` come from our own tooling config, not user input. |
| `2457` | The perf capacity harness (`packages/api/perf/capacity/`) — a load-test driver, not a shipped surface. |
| `2477` | `brace-expansion` + `postcss` in mobile. The fragment states both are build-time only and the app bundle ships neither. |
| `2755` | `brace-expansion` and `postcss` — dev dependencies of web, website, and mobile. |
| `2772-write-surface-invariants` | A CI gate pinning the API's write surface against an inventory. It can catch a future regression; it adds no behavior to today's artifact. |
| `2773-demo-readonly-posture` | A gate asserting the hosted demo's read-only posture. The posture itself shipped earlier (#1763). |
| `2786` | `js-yaml`. The fragment states all four consumers are build-time only: eslint, Redocly OpenAPI parsing, Astro content, and nyc/istanbul config. |
| `2787` | `nanoid` and `image-size`. Both reach us build-time only, through metro's asset pipeline reading our own committed assets. |
| `2831-sonar-s5332-prod-compose-drill` | Cleartext-protocol findings in `scripts/prod-compose-drill.sh`, a CI drill script. |
| `2853` | A positive-control test proving the Jira XML import's defusedxml hardening rejects XXE and billion-laughs. The hardening it asserts already shipped. |
| `2988` | Protocol pinning on the Kubernetes NetworkPolicy CI drill's Calico manifest fetch. |
| `3282` | An expiring OSV suppression, not a code change. `decode-uri-component` is reached only through the deep-link URL parser, and the mobile app configures no `linking` prop and no URL scheme. |
| `3317` | `browserslist` in the web and mobile lockfiles — build toolchain, never in the bundle. This is the fragment (!2275) that prompted #3318. |
| `940` | Release-pipeline hardening (Trivy scan, SBOM, Cosign signing). Changes how artifacts are published, not what they contain. |
| `944` | Publication of the disclosure policy itself — `SECURITY.md`, the PyPI README, the docs site. |
| `website-sharp-0.35` | `sharp` in the documentation site's build. The docs site is explicitly out of scope in `SECURITY.md`. |

### Artifact-affecting (80)

Ordered by the date the fragment landed on `main`. **>30d** marks a fix merged more than
30 days before this record and still unreleased.

| Fragment | Merged | Age | Fix |
|---|---|---|---|
| `1203` | 2026-07-02 | **>30d** | Bounded the raw dependency-edge count submitted to the scheduler with a MAX_DEPENDENCIES cap (100,000), enforced ident… |
| `1547` | 2026-07-02 | **>30d** | Fixed an access-control gap that let any authenticated user read another project's live presence data |
| `1548` | 2026-07-02 | **>30d** | Fixed the bulk task-update endpoint (POST /api/v1/projects/{id}/tasks/bulk/) allowing a project Member to edit tasks a… |
| `1549` | 2026-07-02 | **>30d** | Fixed Viewer-role members being able to downgrade a BLOCK guardrail policy to WARN or toggle team acknowledgment via P… |
| `1550` | 2026-07-02 | **>30d** | Production now refuses to boot when DATABASE_URL lacks an sslmode parameter, closing a gap where the database connecti… |
| `1551` | 2026-07-02 | **>30d** | Added rate limiting to the integration-credential connect/rotate/revoke endpoints and the Git webhook-secret config an… |
| `1552` | 2026-07-02 | **>30d** | Added rate limiting to the synchronous Monte Carlo simulation endpoint (POST /api/v1/projects/{id}/monte-carlo/) to pr… |
| `1553` | 2026-07-02 | **>30d** | Fixed individual ceiling-proposal vote choices being readable by non-team project members |
| `573` | 2026-07-03 | **>30d** | Fixed two task-attachment security-review follow-ups (!306 MED-1/MED-2, ADR-0075) |
| `574` | 2026-07-03 | **>30d** | Hardened notification email and task-attachment uploads per the !306 security review follow-up |
| `684` | 2026-07-03 | **>30d** | Task assignee membership |
| `1711` | 2026-07-09 | **>30d** | Closed a cross-project relocation flaw (BOLA) on three writable relation FKs |
| `1712` | 2026-07-09 | **>30d** | Closed a confused-deputy gap on the read-only MCP surface where a project- or program-scoped API token — confined to i… |
| `1713` | 2026-07-09 | **>30d** | Hardened API tokens minted for the read-only MCP server so a leaked token cannot write and cannot live forever |
| `1714` | 2026-07-09 | **>30d** | Helm |
| `1715` | 2026-07-09 | **>30d** | Helm |
| `1717` | 2026-07-09 | **>30d** | Added a per-account login throttle that bounds password guessing against a single account across all source IPs, closi… |
| `1719` | 2026-07-09 | **>30d** | Hardened the sync upload rate limiter against authenticated denial-of-service |
| `1721` | 2026-07-09 | **>30d** | Import row-count cap (worker/broker DoS) |
| `1722` | 2026-07-09 | **>30d** | Bounded MPXJ subprocess for .mpp import |
| `1723` | 2026-07-09 | **>30d** | Closed two WebSocket credential-in-URL leaks |
| `1724` | 2026-07-09 | **>30d** | Restricted the workspace invite-list and group read endpoints to Admins |
| `1725` | 2026-07-09 | **>30d** | Risk owner and retro action-item assignee must be project members |
| `1728` | 2026-07-09 | **>30d** | Workspace Admins can no longer grant or invite at a role equal to their own |
| `1785` | 2026-07-09 | **>30d** | WBS reorder (POST /projects/{id}/tasks/reorder/) now requires per-task edit authority on every sibling in the level, m… |
| `1763` | 2026-07-10 | **>30d** | Hardened the public read-only demo (docker-compose.demo.yml) so its reverse proxy exposes an explicit allowlist instea… |
| `1808` | 2026-07-10 | **>30d** | MCP read-surface rate limiting |
| `django-5.2.16` | 2026-07-10 | **>30d** | Bumped Django from 5.2.15 to 5.2.16 (5.2 LTS security release) to resolve three medium-severity advisories flagged by … |
| `1502` | 2026-07-12 | **>30d** | Running a Monte Carlo forecast no longer records a persisted, author-attributed history row unless the caller holds th… |
| `1858` | 2026-07-12 | **>30d** | Closed a client-side DoS in the WASM scheduler's drag-preview session |
| `1895` | 2026-07-13 | **>30d** | Sensitive query params in HTTP trace spans |
| `1898` | 2026-07-13 | **>30d** | SSO config disclosure |
| `1957` | 2026-07-14 | **>30d** | Seed export is now restricted to project/program Admins |
| `2016` | 2026-07-16 | **>30d** | Email-settings read gate tightened |
| `2082` | 2026-07-17 | **>30d** | SSRF guards no longer echo the resolved internal address |
| `2083` | 2026-07-17 | **>30d** | Webhook URL registration no longer echoes the DNS-resolved internal address when an SSRF egress guard rejects a URL |
| `2085` | 2026-07-17 | **>30d** | Hardened deployment and build tooling |
| `2247` | 2026-07-20 | **>30d** | Separate JWT signing key + global sign-out lever |
| `2248` | 2026-07-20 | **>30d** | Auth-surface hardening |
| `2257` | 2026-07-20 | **>30d** | Bumped the web client's axios dependency from 1.16.0 to 1.18.1 to clear three OSV advisories, all fixed upstream in 1.… |
| `1756` | 2026-07-22 | **>30d** | Per-user concurrency cap on offline-sync uploads |
| `2357` | 2026-07-24 | **>30d** | Updated react-router to 7.18.1 to remediate a HIGH-severity advisory (GHSA-chx6-hx7r-mcp5, CVSS 8.7) allowing unauthen… |
| `2359` | 2026-07-24 | **>30d** | Pinned dompurify to 3.4.12 (via an npm overrides floor on the transitive jspdf dependency) to clear GHSA-c2j3-45gr-mqc… |
| `2362` | 2026-07-24 | **>30d** | Bumped react-router to 8.3.0 to remediate GHSA-qwww-vcr4-c8h2 (HIGH, CSRF in unstable RSC code paths) |
| `2569` | 2026-07-30 | **>30d** | Helm |
| `2570` | 2026-07-30 | **>30d** | A task's assignee can no longer approve their own three-point estimate |
| `2585` | 2026-07-31 | **>30d** | Task placement fields are no longer writable over the API |
| `2596` | 2026-07-31 | **>30d** | The PM Only estimation mode is now enforced on the server |
| `2650` | 2026-08-01 | **>30d** | Backup upload |
| `2680` | 2026-08-01 | **>30d** | Closed-sprint task status freeze, enforced server-side |
| `2761-csv-import-indent-depth` | 2026-08-04 | 28d | CSV import indent-depth DoS |
| `2762-csv-formula-injection` | 2026-08-04 | 28d | CSV formula-injection (CSV/DDE) hardening on export |
| `2763-mcp-untrusted-content-framing` | 2026-08-04 | 28d | Hardened the read-only MCP server against indirect prompt injection from user-authored task/risk/sprint text |
| `2764-mcp-token-max-expiry` | 2026-08-04 | 28d | An mcp:read personal or project API token now has a maximum expiry of 365 days from mint time, in addition to the exis… |
| `2789` | 2026-08-08 | 24d | Upgrade dompurify to 3.4.13 in the web and documentation-site lockfiles and mermaid to 11.16.1 in the documentation-si… |
| `2830-admin-password-written-to-logs` | 2026-08-11 | 21d | The initial administrator password generated during setup was written to the container's log output instead of to the … |
| `2832` | 2026-08-16 | 16d | Off-boarding a workspace member now revokes their Personal Access Tokens and refresh tokens |
| `2849` | 2026-08-16 | 16d | Brought all five shipped nginx configurations to one hardening baseline |
| `2850` | 2026-08-16 | 16d | Deactivating an account now immediately closes its live WebSocket connections on every project |
| `2859` | 2026-08-16 | 16d | The Apache 2.0 boundary gate now scans dependency manifests (pyproject.toml, package.json, Cargo.toml, requirements*.t… |
| `2875` | 2026-08-17 | 15d | Single sign-on |
| `2878` | 2026-08-17 | 15d | A leaked API token can no longer mint or revoke API tokens |
| `2881` | 2026-08-17 | 15d | Inbound Git webhook — closed an automation-disclosure oracle, added a per-IP limit, and bounded the body |
| `2885` | 2026-08-17 | 15d | The outbound webhook signing secret is now encrypted at rest, closing the last plaintext secret in the product; a data… |
| `2892` | 2026-08-17 | 15d | CSV formula-injection guard applied to the workspace member and roles exports (the #2762 class at two further sites) |
| `sqlparse-dos` | 2026-08-17 | 15d | Upgraded sqlparse to 0.6.0, clearing four advisories against the 0.5.5 pin that Django depends on |
| `2980` | 2026-08-20 | 12d | Updated Django to 5.2.17, which carries the fix for PYSEC-2026-3717 |
| `2895-me-active-sprints-velocity-gate` | 2026-08-21 | 11d | GET /api/v1/me/active-sprints/ now applies the ADR-0104 velocity privacy gate and re-checks project membership |
| `2982` | 2026-08-21 | 11d | Velocity privacy at the reforecast preview |
| `2929` | 2026-08-22 | 10d | SSO callback crash on a non-ASCII state |
| `2995-sprint-action-reads-respect-agent-opt-out` | 2026-08-22 | 10d | Sprint detail endpoints now honor a project's agent-read opt-out |
| `2999-session-revocation` | 2026-08-22 | 10d | Fixed server-side session revocation, which did not work against the session that mattered |
| `2911-invite-record-durability` | 2026-08-23 | 9d | Workspace invites now leave a durable record, and an accepted invite no longer loses its sender |
| `3001-mcp-action-opt-out` | 2026-08-23 | 9d | Closed three agent-read opt-out bypasses (ADR-0678) |
| `3014-mcp-program-export-policy` | 2026-08-23 | 9d | A member project's agent-read opt-out now withholds a program-level bulk export from an agent token by default, and th… |
| `3017-refusal-audit-durability` | 2026-08-23 | 9d | The agent-action audit log now records refused calls, not only successful ones |
| `3127` | 2026-08-28 | 4d | A project's draft lifecycle can no longer be changed by a plain PATCH |
| `2745` | 2026-08-29 | 3d | Closed a fail-open in the project permission layer |
| `3176` | 2026-08-29 | 3d | Production now refuses to start when the database or Valkey password is a known placeholder (change-me and similar) or… |
| `3187-secret-key-placeholder` | 2026-08-29 | 3d | .env.example no longer ships a SECRET_KEY that passes validation |

## Keeping this record honest

This is a **point-in-time triage**, not a live gate. Nothing recomputes it, and every
release empties `changelog.d/` — so after the next release the counts above describe
history, not state. Two things follow:

- Re-run the classification at each release cut, as part of assembling the changelog.
  The rule at the top is what to apply; the tables are only the last answer.
- The counts are reproducible: `ls changelog.d/*.security.md` for the denominator, and
  each fragment's own reachability sentence for the split. If a future fragment omits
  that sentence, ask for it in review — its absence is what turns a five-minute triage
  into a re-investigation.

The secondary finding in #3318 stands and is not fixed here: fragments assemble only at
release time, so `CHANGELOG.md`'s Unreleased → Security section reads `_Nothing yet._`
while 99 documented fixes sit on `main`. Anyone outside the repo can read none of them.
That is a consequence of the fragment workflow, and shortening the release interval is
what shrinks it.
