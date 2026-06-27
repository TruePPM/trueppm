# TruePPM Pre-Release Audit — June 27, 2026 (targeting 0.3)

**Scope**: `/pre-release full` against `origin/main` @ `ba508b564` as if cutting the **0.3** tag. Last shipped: `v0.2.0-alpha.1` → **pre-1.0 mode**. 16 agents over 3 waves (kaizen + voc pre-passes skipped by request). Public-contract lens across all four packages (scheduler pip, api, web, helm) plus the OSS/Enterprise boundary.

**Method**: each agent audited a detached read-only worktree of `origin/main`; findings cross-referenced against a single dump of all 1345 GitLab issues (open + closed); full per-agent reports retained in the run directory. Severity recalibrated against the pre-1.0 bar before filing (agents over-rate 🔴). Every 🔴 was verified directly against source before filing.

**Pre-flight**: 0.3 had **0 open issues / 0 open MRs** at launch; all five 0.3 close-gate items verified clean (fixture-drift test, retro + flow-analytics surfaces, v2 in roadmap, CHANGELOG 0.1/0.2 headings, `0001_squashed_*` baseline).

---

## Gate verdict

**Do NOT proceed to `/release` for 0.3 until #1354 and #1093 are resolved.** Everything else is 🟡 — triage the 0.3 list, but it does not block the tag. Because this audit reopened the 0.3 issue tree (0 → 16 open), a final `/pre-release full` (or a targeted re-check) should run after these land and before tagging.

### Summary
- 🔴 Blocking: **1** (#1354 — install crash-loop)
- 🟧 Privilege bypass, pulled into 0.3: **1** (#1093 — must-fix before tag)
- 🟡 Should-fix: **13** filed under 0.3
- Spillover: 1 → 1.0 (#1356), 1 → 0.4 (#1360)
- 🟢 Clean: scheduler engine, OSS/Enterprise boundary, migration squash, dependency licenses, WS/canvas perf, version-tense gate

---

## 🔴 Blocking (gates the 0.3 tag)

- **#1354 — self-host install crash-loops on documented paths.** `settings/prod.py:74-80` (INTEGRATION_ENCRYPTION_KEY, #1002) and `:62-68` (attachment storage, #775) raise `RuntimeError("Refusing to start…")` at **import time** in prod (the asgi/gunicorn worker never runs `manage.py check`). But root `.env.example:38` ships `INTEGRATION_ENCRYPTION_KEY=` empty, and Helm `README.md:86`/`values.yaml:110` document an `envFrom:` pattern **no app deployment template renders**. A self-hoster following the docs with `DEBUG=False` boot-loops. Fix: env-example guidance + render `envFrom` in the api/celery deployment templates.

## 🟧 Privilege bypass — pulled into 0.3 (must-fix before tag)

- **#1093 — Sprint scheduler-fields RBAC bypass on CREATE.** `SprintSerializer.validate()` gates scheduler-only fields with `self.instance is not None` (None on POST), so a Member can set `capacity_points`/`wip_limit`/`exclude_from_velocity` at sprint creation. Real within-project privilege escalation (not cross-tenant / not data-loss → 🟡 under the pre-1.0 bar). **Pulled from 0.4 into 0.3** as a gate item; the CREATE path has zero CI coverage, so its regression test (#1365) must land with the fix.

## 🟡 Should-fix — filed under 0.3

| # | Area | Title |
|---|---|---|
| #1349 | security | `BaselineSerializer.is_active` writable — bypasses `BaselineActivateView`, 500 on double-activate |
| #1350 | security | `seed_demo_project` hardcodes `DEMO_PASSWORD="demo"`, no production guard |
| #1351 | rbac | In-body role gates → DRF permission classes (defense-in-depth) + Viewer WebSocket read consistency |
| #1352 | perf | Residual N+1 / missing-index / unbounded-list gaps (follow-up to #1316-#1319, #1317) |
| #1353 | scheduler | pip public-surface hygiene — (de)serialization docstrings, export validator caps, consistent `InvalidScheduleInput` |
| #1355 | contract | 0.3 fix-now public-surface tidies (scheduler enum casing + error base, WS versioning, env-var namespace, pagination envelope, slot-registry reserve) |
| #1357 | a11y | Dialog focus-trap + `window.confirm` regressions + touch targets + Gantt-deps accessible alternative |
| #1358 | ux | Residual v2 token drift (raw hex role chips, sub-12px chips, disabled-token on readable text) + WIP-limit at-limit band bug |
| #1359 | realtime | Untracked broadcast gaps — `roster_changed` zero-assignment skip, silent sprint-retro upsert/visibility, MS Project import, slip-conflict |
| #1362 | docs | Pre-tag polish — fill screenshot placeholders, add Flow-analytics page, fix version-tense + shipped-feature "will be", missing nav links |
| #1363 | api-docs | OpenAPI accuracy — `MonteCarloLatest`/rollup/resource-contention return rich JSON documented as "No response body"/untyped |
| #1364 | deps | Caret the `html-to-image` pin + add a `psycopg` LGPL-3.0 redistribution note to the 0.3 release notes |
| #1365 | test | 0.3 coverage gaps — #1093 CREATE-bypass + Baseline `is_active` regression tests, stale MC mocks, routing-only hooks, `import_seed` CLI, #1347 positive E2E |

## Spillover (filed outside 0.3)

- **#1356 → 1.0** — `Task.assignee` exposes the integer User PK while all else is UUID, plus FK-encoding / enum-casing / id-spelling cleanup for the v1 wire freeze (home #726).
- **#1360 → 0.4** — squash-cycle prep: extract migration backfill functions out of test imports (CLAUDE.md migration rule 3) + extend the squash through the 0.3 tag.

---

## 🟢 Clean areas (no action)

- **Scheduler engine** — 730 tests, 98% coverage, all four dependency types + calendar-aware lag + seeded Monte Carlo + float/critical-path verified against hand-checked reference cases; zero Django import leak; #1341-#1344 confirmed closed.
- **OSS/Enterprise boundary** — `grep -r "trueppm_enterprise" packages/` returns zero imports; OSS builds and functions standalone. The architect's "`portfolio` in an OSS enum" flag was **refuted** by enterprise-check — `DefaultLanding.PORTFOLIO` is correct ADR-0030 edition-routing, triple-gated and degrading to My Work in community.
- **Migrations** — squash baseline intact across all 17 apps; non-regenerable ops (ltree/pg_trgm extensions, GiST `wbs_path` index, `historicaltask` composite index) preserved in both squash and originals.
- **Dependencies** — 603 npm packages scanned, zero GPL/AGPL; no known-exploited CVE in any shipped package; esbuild HIGH CVEs cleared (Vite 8 / Rolldown).
- **Real-time** — every existing broadcast is correctly deferred via `transaction.on_commit()` with plain-value closures; no payload leaks role-gated values.
- **Performance** — WebSocket fanout (single `group_send`, no per-message DB query, CPM delta capped at 500) and the canvas renderer (virtualized + cached layout + RAF-throttled) are clean; the dangerous super-linear engine paths were already hardened and closed for 0.3.
- **Docs** — version-tense CI gate (`scripts/check-version-status.sh`) passes; no broken internal links.

---

## Severity recalibrations (for the record)

- **accessibility's 3 "🔴" → 🟡**: `window.confirm()` is natively assistive-tech-accessible, and focus-escape from a modal is a degraded-not-broken WCAG 2.4.3 failure — neither renders a core flow *completely* unusable. Filed in #1357.
- **api-design's "🔴" → 🟡**: the `MonteCarloLatest` "No response body" schema is an **additive, non-breaking** `@extend_schema` fix on a 0.3-new endpoint — worth doing before the tag, but not irreversible. Filed in #1363.

The only finding that survived recalibration as a genuine 🔴 is the install blocker (#1354).
