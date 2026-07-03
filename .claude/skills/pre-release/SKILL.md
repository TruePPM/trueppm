---
name: pre-release
description: Run a pre-release audit of the full TruePPM codebase before cutting a release tag.
argument-hint: "<full|security|performance|frontend|accessibility|docs|contracts|deps|enterprise|tests|scheduler>"
---

# Pre-Release Audit

You are running a pre-release audit of the full TruePPM codebase. Unlike day-to-day agents (which are scoped to what changed in a branch), every agent here audits the **entire codebase** through a "public contract" lens — asking "what becomes a commitment we can't take back at the next release?" rather than "is this change correct?".

TruePPM has three independently-versioned-but-locked-in-step packages: `packages/scheduler` (pip-installable, Apache 2.0, public PyPI surface once published), `packages/api` (Django REST + Channels), and `packages/web` (React frontend). Plus the Helm chart in `packages/helm`. The audit must consider **all four** as part of the public contract.

## Step 0 — Determine current working release

Before anything else, determine the **current working release** (the version we are about to cut next). This is used to label issues, frame agent prompts, and decide severity. Do not hardcode `0.1` or `1.0` — always resolve dynamically.

Resolution order:
1. Read `packages/scheduler/pyproject.toml` — the `version` field is the canonical version source (release.sh treats it as authoritative). This records the **last shipped** release (e.g. `0.1.0`). If it is a pre-release suffix (e.g. `0.2.0-beta.1`), the working release is the stable form (`0.2.0`).
2. The **current working release** is the next open GitLab milestone strictly greater than the shipped stable version. Query:
   ```bash
   glab api "projects/trueppm%2Ftrueppm/milestones?state=active" 2>/dev/null \
     | python3 -c "import json,sys; ms=json.load(sys.stdin); print('\n'.join(m['title'] for m in sorted(ms, key=lambda m: [int(x) for x in m['title'].split('.') if x.isdigit()] or [0])))"
   ```
   Pick the smallest milestone title greater than the shipped version. That is `$WORKING_RELEASE` (e.g. `0.1`, `1.0`, `1.0.1`).
3. Confirm with the user in one line: "Auditing against the **$WORKING_RELEASE** release (last shipped: $SHIPPED). Proceed?" — only if the audit type is `full`. For targeted audits, skip the confirmation and proceed silently.

Export `$WORKING_RELEASE` for use in every subsequent step. Every agent prompt, every GitLab issue, and the final gate check reference this variable — never a hardcoded version string.

### Pre-1.0 vs post-1.0 framing

TruePPM is not yet at 1.0. Severity of contract findings depends on whether `$WORKING_RELEASE` is below or at/above 1.0:

- **Pre-1.0 (`0.x`)** — public API, WS event schema, settings, and DB migration shape can still change between minor versions. A contract finding is 🟡 unless it represents an irrecoverable data-loss or security risk. Flag breaking-but-fixable issues for the **next minor**, not as blockers.
- **At-or-post-1.0 (`>= 1.0.0`)** — the `1.x` line freezes the API, WS event schema, settings names, scheduler pip API, and DB migration pattern. Breaking contract findings against `$WORKING_RELEASE` are 🔴 unless deferrable to the next major.

State which mode is in effect at the top of the consolidated report.

---

## Step 0.1 — Determine audit type

Read `$ARGUMENTS`. Valid types: `full`, `security`, `performance`, `frontend`, `accessibility`, `docs`, `contracts`, `deps`, `enterprise`, `tests`, `scheduler`.

If `$ARGUMENTS` is empty or not one of the above, present this menu and ask the user to choose:

```
Which pre-release audit would you like to run?

  full           All agents in 3 parallel waves with gate checks
  security       security-review + rbac-check
  performance    perf-check + performance
  frontend       ux-review + broadcast-check
  accessibility  accessibility (WCAG 2.1 AA)
  docs           docs-writer + api-design (full surface review)
  contracts      architect (full codebase) + migration-check
  deps           dependency
  enterprise     enterprise-check
  tests          test-strategy (coverage gaps across all packages)
  scheduler      scheduler-engine (full pip-package audit)
```

Wait for the user's choice before proceeding.

---

## Step 0.5 — Pre-flight: check for prior audit findings

Before launching any agents, check whether a recent pre-release audit has already been run and its findings already filed as GitLab issues for the current working release.

```bash
glab issue list --repo trueppm/trueppm --state opened --label "$WORKING_RELEASE" --search "audit" 2>/dev/null | head -20
glab issue list --repo trueppm/trueppm --state opened --label "$WORKING_RELEASE" 2>/dev/null | head -30
```

Also check for recently closed audit issues (resolved since last run):
```bash
glab issue list --repo trueppm/trueppm --state closed --label "$WORKING_RELEASE" --updated-after "$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)" 2>/dev/null | head -20
```

**If open `$WORKING_RELEASE` issues exist from a prior audit:**
1. List them for the user grouped by severity (🔴 blocking vs 🟡 should-fix).
2. Say: "A prior audit has N open finding(s) against $WORKING_RELEASE still unresolved (see above). Re-running will re-discover the same issues. Options:
   - **resolve** — work through the open issues first, then re-run the audit
   - **continue** — re-run anyway (e.g. significant code has changed since the last run)
   - **targeted** — run only a specific sub-audit (e.g. `/pre-release security`) on the area you just fixed"
3. Wait for the user's choice before proceeding.
   - If "resolve" → stop here. Do not launch any agents.
   - If "targeted" → jump to Step 0.1 to let the user pick a specific audit type.
   - If "continue" → proceed to Step 1.

**If no open `$WORKING_RELEASE` issues exist** → proceed to Step 1 immediately with no prompt.

---

## Step 0.6 — Model selection per subagent

Pre-release audits stake **irreversible public commitments**. The cost of a missed finding is a patch release at best, a security advisory at worst. That asymmetry is the input to model choice — not how easy the agent's checklist looks. Spend Opus where missing a finding is expensive and the reasoning is non-local; use Sonnet where the audit is pattern-matching with a clear checklist.

When launching each agent (via the `Agent` tool with `subagent_type: <name>` and `model: opus|sonnet`), use the recommendations below. **Override defaults with judgement** — if an audit has previously surfaced false negatives in a particular area, escalate to Opus for that wave.

### Default policy

| Tier | Model | When |
|------|-------|------|
| Deep | **Opus** | Cross-file reasoning; vulnerability chains; contract design; algorithm correctness; OSS/Enterprise boundary subtleties |
| Pattern | **Sonnet** | Rule-driven audits with a clear "look for X, flag Y" checklist; enumeration; doc/coverage gap reporting |

### Per-agent assignment

| Agent | Model | Why |
|-------|-------|-----|
| `security-review` | **Opus** | OWASP Top 10 across the full codebase requires reasoning across views → serializers → models → migrations; IDOR and serializer-exposure findings often span 3–5 files. Missing one is a CVE. |
| `rbac-check` | **Sonnet** | Pattern audit: every endpoint × every HTTP method × the 5-role matrix. Mechanical and exhaustive — Sonnet's strength. |
| `perf-check` | **Sonnet** | Structural N+1 detection: relations traversed in serializers vs `select_related`/`prefetch_related` on the calling view. Pattern-based and well-defined. |
| `performance` | **Opus** | Cross-cutting performance: schedule canvas renderer, WebSocket throughput, mobile sync, query-count scaling with project size. Requires reasoning about data shape and access patterns, not just per-endpoint checks. |
| `scheduler-engine` | **Opus** | CPM forward/backward correctness, Monte Carlo sampling assumptions, float math — all algorithm-correctness work. Plus public pip-package surface stability is a multi-year commitment once 1.0 ships. |
| `architect` (contracts) | **Opus** | "What becomes a public commitment?" is the highest-reasoning question in the audit. Requires holding the API + WS + scheduler + Helm + settings surface in mind simultaneously and judging which inconsistencies are cheap-to-fix vs major-bump. |
| `migration-check` | **Sonnet** | Pattern audit: scan migration files for destructive ops, NOT NULL without default, missing reverse migrations. Mechanical. |
| `ux-review` | **Sonnet** | Design system compliance is a checklist against the `brand` skill tokens. Sonnet is well-calibrated for this. |
| `broadcast-check` | **Sonnet** | Pattern audit: every write path × `broadcast_board_event()` + `transaction.on_commit()`. Mechanical pairing check. |
| `accessibility` | **Sonnet** | WCAG 2.1 AA is a well-defined rule set (contrast ratios, ARIA, keyboard, focus). Sonnet handles this reliably. |
| `docs-writer` (audit) | **Sonnet** | Enumerate features in `docs/` vs features in code; flag gaps. Enumeration, not reasoning. |
| `api-design` (audit) | **Sonnet** | Enumerate endpoints/schemas/events in code vs `docs/api/`; flag gaps. Enumeration. |
| `dependency` | **Sonnet** | License + CVE scan against pip and npm manifests. Tabular and well-defined. |
| `enterprise-check` | **Opus** | OSS/Enterprise boundary leaks are subtle (signal hooks, settings includes, view registry). Missing one breaks the Apache 2.0 contract. Reasoning across two repos via extension points. |
| `regression-check` | **Sonnet** | Stale mocks, broken test suites, permission regressions — pattern-based. |
| `test-strategy` (coverage) | **Sonnet** | Enumerate public functions/endpoints/hooks vs tests that cover them. Enumeration. |

### Wave-level summary (for `full` audits)

- **Wave 1** (5 agents): Opus for `security-review`, `performance`, `scheduler-engine` · Sonnet for `rbac-check`, `perf-check`
- **Wave 2** (5 agents): Opus for `architect` · Sonnet for `ux-review`, `broadcast-check`, `accessibility`, `migration-check`
- **Wave 3** (6 agents): Opus for `enterprise-check` · Sonnet for `docs-writer`, `api-design`, `dependency`, `regression-check`, `test-strategy`

That distribution puts roughly a third of agents on Opus, concentrated on the audits where missing a finding is irreversible (security, contracts, algorithm correctness, license boundary). The other two-thirds run on Sonnet, where the audit is a clear-checklist pattern match and Sonnet is both cheaper and well-calibrated.

**Pre-wave passes** (Steps 0.7 and 0.8) run on Sonnet — kaizen is a pattern audit over harness signals, and voc-audit is persona simulation where the value comes from breadth (8 core personas — plus the specialist evaluators where a surface touches the API or deployment domain — × N surfaces in parallel) rather than depth in any single sub-agent.

### When to escalate

- A targeted re-audit after a 🔴 fix → keep the same model that found the original issue (so the re-check is at least as deep).
- Pre-1.0 → Sonnet is fine for `architect` if the milestone has no shipped consumers yet and the contract is still mutable. **Default to Opus anyway** — pre-1.0 contract decisions still anchor 1.0.
- Post-1.0 stable cuts → never downgrade `security-review`, `architect`, `scheduler-engine`, or `enterprise-check` from Opus.

### Assignments are empirically validated — tune scope, not tier

The 2026-06-09 `/pre-release full` run validated this assignment table against real findings. Sonnet pattern agents found **4 of the 6 blockers** — three RBAC IDORs (`rbac-check`) and a login schema contract bug (`api-design` audit mode). Opus deep agents found the cross-file vulnerability chain (`security-review`) and performed the severity-critical consolidation. Both tiers earned their keep. Cost tuning must therefore come from **scope** — the per-agent boundary sentences in Step 1 and the orchestration patterns in Step 0.65 — and **never** from downgrading a model tier or trimming an agent's exhaustiveness. Quality and security are paramount; a missed finding is a patch release at best and a CVE at worst.

### Measured cost baseline + runaway guard

From the 2026-06-09 run, expect each **wave agent** to run roughly **45–170k tokens, 20–240 tool calls, 2–16 min**; the **consolidator** (Steps 2–3, delegated per Step 0.65) ~350k tokens; the **full fleet total** ~2.6M tokens. Treat these as the calibration band, not a budget to spend down.

**Runaway guard:** an agent that exceeds ~250k tokens, or roughly 2× any of these baselines, is signalling a runaway — scope drift, a search loop, or repeated re-reads — not deeper rigor. Investigate it before trusting its findings; do not silently absorb the overrun into the run total.

---

## Step 0.65 — Orchestration cost patterns

These five patterns keep a 20+ agent run cheap and stable without weakening any check. They tune *how* the fleet runs, not *what* it audits.

1. **Detached worktree.** Run the audit against a detached read-only worktree at the true tip: `git fetch origin main && git worktree add <tmpdir> origin/main --detach`. Agents see `origin/main` rather than a stale or dirty local checkout, branch switches in the main checkout can't disturb them mid-run, and the user's working tree stays untouched. Remove the worktree (`git worktree remove <tmpdir>`) when the audit completes.

2. **Shared issue dump.** Before launching any wave, dump **all** open issues exactly once — `glab api` paginated, formatted as `#iid<TAB>milestone<TAB>title<TAB>[labels]` — to a run file, and pass that file's path to every agent for its tracking annotations. One API sweep replaces every agent independently running ~20 `glab issue list --search` calls (the 2026-06-09 run: a single dump replaced an estimated 300+ searches).

3. **Reports to files, compact returns.** Every agent writes its full report to a shared run directory (`<run-dir>/reports/<agent>.md`) and returns to the orchestrator **only** a compact summary: counts, one line per 🔴, and the top 🟡 titles. This keeps the orchestrator's context flat across a 20+ agent run; the consolidation step reads the full reports from disk.

4. **Background-parallel waves.** Launch each wave's agents as parallel background tasks in a single batch; the wave gate evaluates once they all complete. Kaizen and voc-audit (Steps 0.7 and 0.8) are wave-independent — launch them alongside Wave 1 rather than serially before it.

5. **Delegated consolidation.** Steps 2–3 (consolidate + cross-reference) run as **one delegated Opus agent**, not inline in the orchestrator. It reads all reports from the run directory, dedups findings that multiple agents raised, recalibrates severity against the pre-1.0/post-1.0 bar (agents over-rate 🔴 — the 2026-06-09 run filed 6 blockers out of 15 agent-rated 🔴s), cross-references **both open and closed** issues, and emits one draft file per finding (frontmatter: title / labels / milestone / severity / action / refs; body: Problem / Root cause / Fix instructions / Test plan) ready for mechanical filing. The orchestrator spot-checks the drafts and executes the filing.

---

## Step 0.7 — Harness pre-flight (kaizen) — full audits only

Before running the codebase audit, invoke `/kaizen --silent` once. Kaizen audits the **development harness itself** (agent gates, CI duration, MR cycle-time, override frequency) and produces a small ranked list of speed wins against the next minor milestone.

Why this lives here: release time is a natural reflection point on how the cycle felt. Kaizen findings target the **next** minor — never the current `$WORKING_RELEASE` — so this step does not extend the current release gate. It is a one-pass capture, not an iterative loop.

Skip this step entirely if:
- Audit type is not `full` (targeted audits don't need a harness review)
- A kaizen report has been filed in the last 14 days (check via `glab issue list --repo trueppm/trueppm --label "chore,tooling,dx" --search "kaizen" --created-after "$(date -v-14d +%Y-%m-%d 2>/dev/null || date -d '14 days ago' +%Y-%m-%d)"`)

Include the kaizen report as a separate section at the top of the final consolidated audit report under the heading **"Harness review (kaizen, targets next minor)"**. Do not let kaizen findings influence the $WORKING_RELEASE gate check in Step 4 — harness improvements ship in their own cycle.

---

## Step 0.8 — Voice-of-Customer audit on shipped surfaces — full audits only

Before launching the codebase audit waves, invoke `/voc-audit --from-pre-release` once per user-visible surface shipped since the last release tag. voc-audit reviews **what actually shipped** through the persona lens and cross-references against the GitLab tracker. Where the wave-based audits ask "is this code correct?", voc-audit asks "does this surface actually serve the personas day-to-day?".

This step targets `$WORKING_RELEASE`: friction findings that would make a shipped surface feel unfinished to a real user are the exact class of issue that turns a release into a "we shipped it but no one uses it" outcome.

### Step 0.8a — Enumerate shipped surfaces since the last tag

The "shipped surfaces" set is the list of user-visible MRs merged into `main` since the most recent release tag. Resolve it dynamically:

```bash
# Most recent release tag (semver, prefixed with v or not)
LAST_TAG=$(git tag --list --sort=-v:refname 'v*' 'release/*' '[0-9]*' 2>/dev/null | head -1)

# Merged MRs on main since that tag, with their changelog fragment type
git log "${LAST_TAG}..main" --merges --pretty=format:'%H %s' 2>/dev/null
```

For each merge, identify whether it shipped a user-visible surface:

- Has a `changelog.d/*.added.md` or `changelog.d/*.changed.md` fragment → user-visible candidate
- Touches `packages/web/src/features/` or `packages/web/src/pages/` → user-visible candidate
- Touches `packages/api/**/views.py` with a new endpoint AND a corresponding web change → user-visible candidate
- Pure CI / dependency / docs / refactor → not in scope, skip

Cap the surface list at the **5 highest-impact surfaces** by changed-line count (`git diff --stat ${LAST_TAG}..HEAD -- packages/web/src/features/`). If more than 5 user-visible surfaces shipped, the lower-impact ones are listed in the report as "deferred to a per-surface voc-audit pass" and not run here — voc-audit drift is real and 5+ parallel persona panels lose signal.

### Step 0.8b — Run voc-audit in parallel, one per surface

In a single message, invoke `/voc-audit` once per surface, passing `--from-pre-release` and the MR reference (or surface description). voc-audit will internally parallelize the persona panel per surface; this step parallelizes across surfaces.

Each voc-audit run returns the structured matrix from its Step 5 (no interactive filing prompts, since `--from-pre-release` suppresses them).

### Step 0.8c — Fold findings into the pre-release report

Collect all voc-audit matrices and add a section to the consolidated report under the heading **"Voice-of-Customer audit (per shipped surface)"**, with one sub-section per surface.

voc-audit findings are **not 🔴 blocking** unless a persona hard-NO is triggered against `$WORKING_RELEASE`. Most voc-audit findings will land as:

- 🟡 should-fix against `$WORKING_RELEASE` if the surface is the headline of the release
- "next minor" candidates if the surface is supporting infrastructure
- "already tracked" annotations if the finding maps cleanly to an open issue

Hard-NO triggers (e.g. Sarah's "no real native mobile app" surfaced against the mobile shell) **are 🔴 blocking** even at pre-1.0 — they represent product-market-fit risk, not implementation risk, which the wave audits do not catch.

### When to skip Step 0.8

- Audit type is not `full`
- No release tag exists yet (first release) → skip and note "no prior tag; voc-audit will run at the next pre-release"
- The last release was within the past 14 days and no user-visible MRs have merged since
- A voc-audit pass was filed against `$WORKING_RELEASE` in the past 14 days (check via `glab issue list --repo trueppm/trueppm --label "voc-audit" --milestone "$WORKING_RELEASE" --created-after "$(date -v-14d +%Y-%m-%d 2>/dev/null || date -d '14 days ago' +%Y-%m-%d)"`)

---

## Step 1 — Run the audit

For each agent below, the prompt must be written for **full codebase audit mode** — not "what changed in this branch". Frame every prompt as: "Audit the full TruePPM codebase as if preparing the **$WORKING_RELEASE** public release. Identify any issues that would become public commitments we can't easily reverse once $WORKING_RELEASE ships."

Public contracts to consider in every audit:
- REST API surface (`packages/api`, exported in `docs/api/openapi.json`)
- WebSocket event schema (`broadcast_board_event` payloads, channel names)
- Scheduler pip-package public API (every export from `trueppm_scheduler.*`) — once 1.0 ships, this is locked for the major line
- Helm chart values (`packages/helm/values.yaml` keys, env var names)
- Settings / env vars consumed by `packages/api/trueppm_api/settings.py`
- Database migrations (any destructive op or NOT NULL without default is a deploy blocker)
- TypeScript types generated from the OpenAPI schema (`packages/web/src/api/types.ts`)
- OSS/enterprise extension points (settings includes, URL patterns, signal hooks)

### `security`
Run in parallel:
1. **security-review** *(Opus)* — Full codebase OWASP Top 10 audit. Check all views, serializers, authentication paths, file upload handlers, invite flows, and user-controlled input across the entire backend. Flag any IDOR, serializer field exposure, or WebSocket broadcast safety issues. Include the scheduler pip package — any pickle/unsafe-deserialize paths there are a public concern once it lands on PyPI.
2. **rbac-check** *(Sonnet)* — Audit every API endpoint across the full codebase. Verify authentication gates, board / project / portfolio membership checks, and minimum-role enforcement per HTTP action against the 5-role RBAC model. A missing permission check is a security vulnerability.

### `performance`
Run in parallel:
1. **perf-check** *(Sonnet)* — Full codebase N+1 audit. Review every viewset and serializer for missing `select_related`/`prefetch_related`, unguarded `SerializerMethodField` database hits, missing indexes on filter fields, and missing transaction boundaries.
2. **performance** *(Opus)* — Deeper performance audit across endpoints, serializers, the schedule canvas renderer (`packages/web/src/features/schedule/engine/`), WebSocket throughput, and mobile sync efficiency. Identify any relation that will cause query count to scale with project size, board size, or task count. Skip per-endpoint serializer/queryset N+1s — `perf-check` owns those; spend the depth on the canvas renderer, WebSocket fanout, sync protocol, and scheduler-engine hot paths.

### `frontend`
Run in parallel:
1. **ux-review** *(Sonnet)* — Full frontend codebase review against the TruePPM design system referenced in `frontend/CLAUDE.md` and in the `brand` skill. Check all components, layouts, modals, pages, and the schedule canvas for design system compliance, mobile-first behaviour, and offline-state handling. Owns design-system/token compliance and interaction-state consistency; defer WCAG SC findings (ARIA semantics, contrast ratios) to `accessibility`.
2. **broadcast-check** *(Sonnet)* — Full audit of all write operations (create, update, delete, move, schedule recalculation) on board-scoped and project-scoped resources. Verify `broadcast_board_event()` is correctly wired, deferred with `transaction.on_commit()`, and that the frontend socket handler exists for every event type.

### `accessibility`
1. **accessibility** *(Sonnet)* — Full WCAG 2.1 AA audit across web and mobile interfaces. Cover keyboard navigation, screen reader compatibility, focus management, color contrast (against the design system tokens), touch target sizes on mobile, and ARIA attributes on the schedule canvas / Gantt interactions. Accessibility regressions in a tagged release are a public commitment — fixing them post-tag means a patch release. Owns WCAG success-criterion findings (ARIA/tab semantics, contrast, focus, motion); `ux-review` defers those to it.

### `docs`
Run in parallel:
1. **docs-writer** *(Sonnet)* — Full documentation audit. Check `docs/features/`, `docs/getting-started/`, `docs/architecture/`, and `docs/administration/` for completeness. Every user-visible feature must have a doc page with correct version callouts and enterprise callouts where applicable. Verify the Docusaurus site (`packages/website/`) builds cleanly and that no internal links are broken. Verify `docs/api/openapi.json` is in sync with the current API surface. Owns website feature/getting-started/administration docs; defer API-reference/schema accuracy to `api-design`.
   - **Version-tense alignment (#807)** — diff every `.md` / `.mdx` under `packages/website/src/content/docs/` against `overview/roadmap.md` (the single source of truth) and against the `SHIPPED` constant in `packages/website/src/content/_release-status.mdx`. Every version mentioned in past/present tense ("shipped in 0.X", "added in 0.X", "In 0.X the Y is …") must be under the roadmap's **## Shipped** section. Any version still under **Underway** or **Planned** must be referenced in future tense ("ships in 0.X", "lands in 0.X", "planned for 0.X"). Run `bash scripts/check-version-status.sh` to catch violations automatically; the `docs:version-accuracy` CI job runs the same gate. When a release tags, bump `_release-status.mdx` and move the version to the roadmap's **## Shipped** section so the prose tense becomes legal.
2. **api-design** (audit mode) *(Sonnet)* — Full API surface review. Every endpoint, serializer field, permission rule, query parameter, and WebSocket event must be reflected in `docs/api/`. Flag any path, method, schema field, or event type that is undocumented, stale, or inconsistent. Frame this as "what does an external integrator see?" — not internal correctness. Owns `docs/api/` + OpenAPI schema accuracy; `docs-writer` defers API-reference gaps to it.

### `contracts`
Run in parallel:
1. **architect** *(Opus)* — Full codebase architecture audit in "public contract" mode. Review the REST API shape, WebSocket event schema, TypeScript interfaces, settings/env vars, Helm values, scheduler pip API, and OSS/enterprise extension boundary. Flag any API shape, field name, event type, settings key, or extension point that is inconsistent or fragile and would be painful to change in $WORKING_RELEASE or later. **Account for what already shipped** — do not flag already-shipped contracts as "fix now" if they can only be changed in a major bump; instead flag them as "track for next major" against the `1.0`/`2.0` milestone (whichever is open).
2. **migration-check** *(Sonnet)* — Full migration history audit across every `backend/*/models.py` and Django app. Check for destructive operations, missing migrations, NOT NULL columns without defaults, and any pattern that would break a zero-downtime deploy. Verify migration ordering is deterministic.

### `deps`
1. **dependency** *(Sonnet)* — Full dependency audit across all pip packages (scheduler, api) and npm packages (web). Block GPL-2.0/GPL-3.0/AGPL on the OSS Apache 2.0 codebase. Flag known CVEs and any dependency that has been superseded by a safer or lighter alternative. Verify `packages/scheduler` has no transitive dependencies that conflict with Apache 2.0 — once it ships to PyPI this becomes downstream-visible.

### `enterprise`
1. **enterprise-check** *(Opus)* — Full OSS/enterprise boundary audit. Verify the OSS core is fully functional without the `trueppm-enterprise` repo. Run `grep -r "trueppm_enterprise" packages/` — must return zero results in OSS code. Verify all extension points (settings includes, URL patterns, signal hooks, view registry, etc.) are stable and that no enterprise-only logic has leaked into OSS files. Confirm features classified as Enterprise per CLAUDE.md (portfolio dashboard, SSO/SAML, custom roles, etc.) are not present in the OSS surface.

### `tests`
1. **test-strategy** (coverage-audit mode) *(Sonnet)* — Full test coverage audit across all backend Django apps and frontend modules. For each app in `packages/api/trueppm_api/` and each module in `packages/web/src/`, identify: (a) public functions/methods/endpoints with no test, (b) edge cases (empty state, permission boundary, error path, offline fallback) that are exercised in code but not in tests, (c) any `SerializerMethodField`, custom model method, or React hook that has only routing tests (asserting the right function is called) and lacks state/behaviour tests (asserting the result is correct). Include the scheduler package — coverage gaps in CPM, Monte Carlo, or float calculations are correctness-critical. Verify Playwright E2E coverage (`packages/web/e2e/`) for every user-visible flow. Do NOT generate scaffold files — return a structured findings report only, grouped by package/app/module, severity-rated as 🔴 (no coverage at all) or 🟡 (routing-only / missing edge cases). Scope to surfaces shipped since the last tag plus security-sensitive paths (auth, invites, import/seed, sync, signal-privacy); read sibling agents' reports from the run directory first and do not re-derive findings their domains own.

### `scheduler`
1. **scheduler-engine** *(Opus)* — Full audit of the `packages/scheduler` pip package as a public artifact. Verify: (a) every export from `trueppm_scheduler.*` has a Google-style docstring and stable signature, (b) CPM forward/backward pass correctness against known reference cases, (c) Monte Carlo sampling assumptions are documented and reproducible (seeded), (d) float calculations match the standard critical-path definitions, (e) no API or Django-specific imports leak into the pure-Python package, (f) test coverage is ≥ 80% on the public surface, (g) the package builds and installs cleanly via `pip install -e packages/scheduler`. Once 1.0 ships, this surface is locked for the `1.x` line — every signature change becomes a major bump.

### `full`
Run all agents above in 3 parallel waves **with gate checks between waves**. A gate check stops the audit early if blockers are found, so critical issues surface immediately rather than being buried in a mass report.

**Wave 1** (correctness + safety) — Opus: `security-review`, `performance`, `scheduler-engine` · Sonnet: `rbac-check`, `perf-check`:
- security-review, rbac-check, perf-check, performance, scheduler-engine

**Wave 1 gate check** — after all 5 Wave 1 agents complete:
1. Collect all 🔴 blocking findings from the 5 agents.
2. If any 🔴 findings exist:
   - Present them to the user in the consolidated report format (summary + blocking section only).
   - Ask: "Wave 1 found N blocking issue(s) against $WORKING_RELEASE. Fix these first, or continue the audit? (fix first / continue)"
   - If "fix first" → stop here. Run Step 3 (GitLab issue check) for the Wave 1 findings only, then run Step 4 gate check. Do not launch Wave 2.
   - If "continue" → proceed to Wave 2.
3. If no 🔴 findings → proceed to Wave 2 immediately (no prompt needed).

**Wave 2** (UX + contracts) — Opus: `architect` · Sonnet: `ux-review`, `broadcast-check`, `accessibility`, `migration-check`:
- ux-review, broadcast-check, accessibility, architect (full codebase mode), migration-check

**Wave 2 gate check** — after all 5 Wave 2 agents complete:
1. Collect all 🔴 blocking findings from Wave 2.
2. If any 🔴 findings exist:
   - Present them (along with any Wave 1 blockers) in the consolidated format.
   - Ask: "Wave 2 found N additional blocking issue(s) against $WORKING_RELEASE. Fix these first, or continue the audit? (fix first / continue)"
   - If "fix first" → stop here. Run Step 3 for all findings so far, then Step 4. Do not launch Wave 3.
   - If "continue" → proceed to Wave 3.
3. If no 🔴 findings → proceed to Wave 3 immediately.

**Wave 3** (docs + ecosystem) — Opus: `enterprise-check` · Sonnet: `docs-writer`, `api-design`, `dependency`, `regression-check`, `test-strategy`:
- docs-writer, api-design (audit mode), dependency, enterprise-check, regression-check, test-strategy (coverage audit mode — report only, no scaffold generation)

`regression-check` in pre-release mode scopes to code merged since the last release tag — the per-MR day-to-day `regression-check` already gates the rest; full-suite static cross-referencing was the worst ROI of the 2026-06-09 run (171k tokens → 5 🟡).

---

## Step 2 — Consolidate findings

After all agents complete, before writing the report, **cross-reference every finding against GitLab issues in both `opened` and `closed` states**. A finding that matches a closed issue is not automatically new — it may be a regression, an already-decided design trade-off, or a won't-fix. Re-reporting it without that context wastes the user's time and erases the prior reasoning.

For each finding, run:
```bash
glab issue list --repo trueppm/trueppm --state all --search "<keyword>" 2>/dev/null | head -20
```

Annotate every finding in the report with one of these tags:
- `(tracked in #N)` — open issue already exists; do not re-file
- `(closed #N — <date>, <one-line close reason>)` — closed issue matches; user will classify in Step 3
- `(untracked)` — no open or closed match

Then produce a consolidated report using this format:

```
## Pre-Release Audit Report — <type> — <date> — targeting <WORKING_RELEASE> (<pre-1.0|post-1.0> mode)

### Summary
🔴 Blocking: N   🟡 Should-fix: N   🟢 Clean: N
Tracking: N tracked · N matched closed · N untracked

### 🔴 Blocking findings
(issues that must be resolved before the $WORKING_RELEASE tag is cut — each annotated with its tracking tag)

### 🟡 Should-fix findings
(issues that should be tracked against $WORKING_RELEASE but may slip to a patch release — each annotated with its tracking tag)

### 🟢 Clean areas
(agents that found no issues)
```

Severity guide (scoped to $WORKING_RELEASE, mode-aware):

**Pre-1.0 mode (`$WORKING_RELEASE < 1.0.0`):**
- 🔴 **Blocking** — security vulnerability, data loss risk, destructive migration, broken Helm deploy path, scheduler correctness bug, or anything that would corrupt user data or block install
- 🟡 **Should-fix** — API/WS contract awkwardness (still cheap to fix), quality issue, stale doc, performance concern, UX violation
- 🟢 **Clean** — no issues found

**At-or-post-1.0 mode (`$WORKING_RELEASE >= 1.0.0`):**
- 🔴 **Blocking** — everything in pre-1.0 mode, plus any breaking change to the API/WS/scheduler/Helm/settings public contract being introduced in $WORKING_RELEASE
- 🟡 **Should-fix** — quality issue, stale doc, non-breaking performance concern, UX violation
- 🟢 **Clean** — no issues found

**Already-shipped public contracts** (introduced in a prior release) that cannot be changed without a major bump are not $WORKING_RELEASE issues — they are next-major-release issues. File them against the next open major milestone instead (e.g. against `1.0` if currently on `0.x`, or against `2.0` if currently on `1.x`).

**voc-audit findings** (from Step 0.8) fold into this severity model with one carve-out: a triggered persona **hard-NO** against $WORKING_RELEASE is 🔴 blocking regardless of mode (pre-1.0 or post-1.0). Hard-NOs represent product-market-fit risk that the wave audits do not catch, and shipping past one is more expensive than shipping past most code-level findings. All other voc-audit findings (boost candidates, untracked friction, deferred to next minor) follow normal 🟡 severity.

---

## Step 3 — GitLab issue check

After the report:

1. Query GitLab for **both open and closed** issues related to each 🔴 and 🟡 finding. A closed match often represents a prior decision (fixed, won't-fix, or deferred) — re-filing without context turns the audit into a whack-a-mole loop and erases prior reasoning.
   ```bash
   glab issue list --repo trueppm/trueppm --state all --search "<keyword>" 2>/dev/null | head -20
   ```
   Extract 2–3 keywords per finding (file path stem, endpoint, error class, security term) and run the search for each. For multi-faceted findings, run more than one query.

2. Classify each finding against the search results:
   - **Already tracked (open)** — an open issue already exists. Annotate the finding with the issue ID (`tracked in #N`) and skip issue creation. Do **not** open a duplicate.
   - **Previously closed (possible regression or re-opened question)** — a closed issue matches. Read the closed issue's description, final comment, and close reason. Present to the user:
     > Finding X matches closed issue #N ("<title>", closed <date>, resolution: <one-line summary of the close reason>). Options:
     > - **regression** — the problem recurred; reopen #N with a note
     > - **new instance** — same class of bug, different location; open a new issue that references #N
     > - **already decided** — the closed issue resolved this class of issue (e.g. explicit design decision); drop from the report

     Wait for the user's choice before taking action. Never silently re-file a finding that matches a closed issue.
   - **Untracked** — no open or closed match. Offer to create an issue (see step 3).

3. For untracked findings, offer to create issues:
   - 🔴 findings introduced in $WORKING_RELEASE → milestone: **$WORKING_RELEASE**, labels: **$WORKING_RELEASE**, `critical` + `priority::high` (the high-tier priority label is `priority::P1`)
   - 🟡 findings against $WORKING_RELEASE → milestone: **$WORKING_RELEASE**, label: **$WORKING_RELEASE**
   - Already-shipped contract issues needing a major bump → milestone: **next open major milestone** (e.g. `1.0` if currently pre-1.0, `2.0` if currently 1.x), label: that major milestone
   - All findings go under the current working milestone unless they genuinely require a major bump to fix — **do not use generic labels like `post-1.0`**; always name the specific target milestone

4. Ask the user: "Create GitLab issues for the N untracked findings above? (y/n)"
   - If yes, create them using `glab issue create --repo trueppm/trueppm` with heredoc descriptions and `--milestone "$WORKING_RELEASE"` (or the next-major milestone for already-shipped contracts). Cross-link any "new instance" findings to the closed issue they relate to.
   - If no, list the findings as a checklist the user can act on manually

---

## Step 4 — Gate check (full audit only)

If the audit type was `full`:

- If any 🔴 blocking findings remain unresolved against $WORKING_RELEASE → **do not proceed to `/release`**. Tell the user: "Pre-release audit found N blocking issue(s) against $WORKING_RELEASE. Resolve these before running `/release`."
- If only 🟡 findings remain → advise the user to triage them, then they may proceed to `/release`
- If all findings are 🟢 → "Pre-release audit passed. You may proceed to `/release` for $WORKING_RELEASE."

---

## Step 5 — Tighten early-detection agents (full audit only, when blockers found)

If the audit type was `full` and any 🔴 or 🟡 findings were found, update the day-to-day skill definitions in `.claude/skills/` so those classes of issue are caught earlier — during normal feature development, not just at release time.

**How to do this:**

For each finding, identify which day-to-day skill *should* have caught it (e.g. a missing `select_related` belongs in `perf-check/SKILL.md`; an IDOR belongs in `security-review/SKILL.md`; a missing broadcast belongs in `broadcast-check/SKILL.md`; a scheduler signature regression belongs in `scheduler-engine/SKILL.md`).

Then update that skill's `SKILL.md` using these principles:

1. **Abstract to the class of problem, not the specific instance.** Do not add "check for missing select_related on TaskSerializer.assignees". Instead, add: "For every relation traversed in a serializer (ForeignKey, ManyToMany, reverse FK, source= with a dotted path), verify the calling view has a corresponding select_related/prefetch_related. Flag any relation that lacks it as a potential N+1." This catches the whole class, not just the one example.

2. **Add the check to the agent's trigger condition if applicable.** If a blocker was found in a context the agent is already supposed to cover (e.g. new viewset), add an explicit check instruction so it won't be missed again.

3. **Do not hardcode filenames or field names.** The agent should check patterns structurally (e.g. "any SerializerMethodField that calls .filter() or .all()") not by name (e.g. "check `assignees` on `TaskSerializer`").

4. **Add a "what to look for" principle, not a "look for this" rule.** Good: "Check whether every write path that modifies a board-scoped resource calls broadcast_board_event() — look for views that call .save(), .create(), .delete(), or bulk operations without a subsequent broadcast call." Bad: "Check that the card move endpoint calls broadcast."

After updating each affected skill file, list the changes made and which finding they address.

If no 🔴/🟡 findings were found, skip this step.
