# TruePPM Product Audit — June 10, 2026

**Scope**: full-repo audit at v0.2.0-alpha.1 covering (1) issue/roadmap alignment, (2) agile methodology coverage incl. a dedicated XP pass, (3) API-first compliance, (4) demo data and simulated history, (5) personas, and (6) findings beyond the requested scope.

**Method**: static analysis of the monorepo (models, serializers, views, web features, ADRs, seeds, skills). The sandbox shell was unavailable, so no test runs or live API calls — every claim below is sourced from code or docs, with paths. Issues live on GitLab (`gitlab.com/trueppm/trueppm`), not in the repo, so §2 audits alignment via the dense ADR↔issue cross-references in the codebase rather than the live tracker.

---

## Executive summary

TruePPM at 0.2 is in unusually good structural health: the API-first claim survives scrutiny, the hybrid (CPM + sprint) positioning is genuinely implemented rather than marketed, the persona system is among the best-engineered I've seen in an OSS repo, and demo data already has real infrastructure (4 bundled seeds, a canonical JSON schema, REST import/export, a UI load button and sample banner).

The five findings that matter most:

1. **Kanban is the weak methodology leg.** Scrum is ~complete, hybrid is the flagship, but a team that runs *pure flow* gets no per-column WIP limits (not persisted — the model's `columns` JSON is `{status, label, visible}` only), no cycle/lead time, no CFD, and no KANBAN delivery mode (deferred as #410). "The Agile Team" release (0.3) that only deepens Scrum will disappoint half of agile teams.
2. **Demo data is a snapshot, not a life.** The seed importer materializes final state at import time: every `django-simple-history` row is stamped "now" by the importing user, and the JSON seeds carry **fixed dates** (Atlas kickoff = 2026-01-05, already 5 months stale). The activity timeline (ADR-0096) of a freshly imported demo reads "one person did everything, today." Fixing this is the single highest-leverage demo investment — full design in §5.
3. **The webhook event catalog has no agile events.** 11 event types, all task/dependency/schedule — no `sprint.activated`, `sprint.closed`, `card.moved`. For an "agile team" release with CI-adjacent integrations this is the API-first gap that bites first.
4. **Sarah (PM persona #1) is dealbreaker-blocked until 1.0.** Her hard NO is "web-only / no real native mobile"; mobile is Android-first in 0.4, iPhone at 1.0 (Jan 2027). Either the roadmap or her first-priority billing needs to acknowledge this.
5. **ADR numbering has collided** (duplicate 0079, 0083×3, 0087, 0088, 0090, 0091, 0092, 0109×2). Harmless today, but ADRs are the source of record and references like "per ADR-0083" are now ambiguous. _**Resolved by #918 (2026-06-23):** every live duplicate renumbered, all references re-pointed, and a `check-adr-collisions.sh` CI gate added to prevent recurrence._

---

## 1. Current state (baseline for the audit)

- **Version**: 0.2.0-alpha.1 across all packages (`packages/*/pyproject.toml`, `packages/web/package.json`); 0.2 stable was targeted Jun 8, 2026 — two days ago — and the repo still shows alpha. See §7.3.
- **Roadmap** (`packages/website/src/content/docs/overview/roadmap.md`, source of truth): 0.1 + 0.2 shipped; **0.3 "The Agile Team" underway** (Jun 29–Jul 6): first-class sprint states, audited scope changes, team-owned velocity, sprint↔milestone bridge, task taxonomy, epic hierarchy, dual backlog, PO role, acceptance criteria, **sample projects + universal JSON import/export**; then 0.4 mobile → 0.5 resources → 0.6 portability/MCP-write → 0.7 PO surface → 0.8 reporting → 0.9 GA hardening → 1.0 (Jan–Feb 2027).
- **Backend**: 17 Django apps (projects, access, resources, scheduling, sync, history, msproject, webhooks, taskruns, workshops, notifications, integrations, observability, workflow_engine, idempotency, workspace, teams).
- **Frontend**: ~15 feature areas (schedule, board, sprints, resource, roster, risk, grid, project, calendar, programs, settings, shell…).
- **ADRs**: 112 in `docs/adr/` — exceptionally dense decision record, with issue numbers cross-referenced throughout.

---

## 2. Do the issues match what the program is meant to do?

**Direct answer: cannot be fully verified from the repo** — issues are on GitLab and no local export exists. What *can* be audited is strong:

**Evidence of alignment (good):**

- ADRs cite issue numbers pervasively (#191 saved views, #248/249/253/340 schedule waves, #308 subtasks, #363 task types, #375 demo load button, #410 kanban mode, #442 estimation modes, #546 sprint WIP, #599 multi-team, #617–620 the four seeds, #642 schema hook, #731 DOR, #807 version-tense regression, #851 live retro, #922 prioritization, #923 pulse, #927 PO role, #983 goal verdict). Every sampled number maps onto a roadmap theme for the version where the ADR sits. The 0.3 issue cluster (#731, #851, #922, #923, #927, #983 + ADR-0094/0101/0102/0104/0105/0106/0111) matches the published 0.3 scope line-for-line.
- **Boundary enforcement is real, not aspirational**: `scripts/check-issue-boundary.sh` + the `boundary:check` CI job fail the pipeline if any open OSS issue carries `enterprise`/`portfolio` labels. This is the only mechanism I've seen that makes "issues are part of the boundary" executable.
- The integration carve-out (ADR-0097, user-scoped read-only pull = OSS) is reflected in shipped code (`apps/integrations/`), so past boundary calls were honored in implementation.

**Risks / what to check on GitLab (15 minutes with `glab` or a GitLab connector):**

1. **Stale-milestone drift** — does the 0.3 milestone contain only the published 0.3 scope, or has it accreted? The roadmap is the source of truth; issues should derive from it, not vice versa.
2. **`TODO(#NNN)` against closed issues** — `lint:todo-grep` catches this in CI, but only on touched files; a one-off full sweep is cheap.
3. **Kanban gap has a home?** — #410 (Kanban delivery mode) is referenced in code comments as deferred. Verify it's filed, milestoned, and not orphaned, because §3 argues it belongs in 0.3.
4. **changelog.d/ is currently empty** (no fragments, not even the README the convention doc references). Expected immediately post-release-assembly, but if 0.2 stable hasn't tagged (§7.3), fragments may have been assembled prematurely or the directory state is wrong either way.

**Verdict**: the in-repo machinery keeps issues honest (boundary CI, ADR cross-refs, roadmap-as-source). Alignment is very likely good; confirm the four checks above against the live tracker.

---

## 3. Methodology coverage — does it work across different agile methodologies?

TruePPM's stated position (ADR-0036): the tool for teams that *already run hybrid* — CPM milestones upward, sprints downward, translation in between. Judged against that, coverage is strong. Judged against "an agile team of any flavor can adopt this and love it in 0.3," there are specific gaps.

### 3.1 Coverage matrix

| Methodology | Coverage | Evidence | Gaps |
|---|---|---|---|
| **Scrum** | Strong (~95%) | First-class `Sprint` state machine (PLANNED→ACTIVE→COMPLETED/CANCELLED) with goal, capacity, committed/completed snapshots, `goal_outcome`; burndown (`SprintBurnSnapshot`); velocity (rolling, team-owned per ADR-0104); retro + action-item→backlog promotion (ADR-0071); sprint review outcomes (`SprintTaskOutcome`, ADR-0176); scope-injection approve-gate (ADR-0102); carry-over on close. `projects/models.py`, `services.py`, `features/sprints/` (47 files) | Multi-team per project deferred to 0.6 (#599); velocity forecast is historical-only, no confidence band yet |
| **Kanban** | Weak (~55%) | 5-status board, column rename/reorder/hide (`BoardColumnConfig`), swimlanes, `Task.status_changed_at` (stall detection), board saved views, real-time card sync | **No persisted per-column WIP limits** (columns JSON = `{status,label,visible}`; `Sprint.wip_limit` comment at models.py:2039 explicitly defers per-column limits and Kanban `delivery_mode` to #410). No CFD, no cycle/lead time, no classes of service, no flow forecasting (throughput-based) |
| **Scrumban** | Moderate (~75%) | Sprint + always-live board coexist; sprint-level WIP threshold; backlog = `sprint=NULL` | Inherits every Kanban gap |
| **Hybrid (flagship)** | Strong (~90%) | `GovernanceClass` + `DeliveryMode` per subtree; sprint↔milestone binding with immutable snapshot; `promote_sprint_to_milestone()`; velocity→CPM reforecast (ADR-0106, 0.3); methodology preset drives tab visibility (ADR-0041); rollup engine (ADR-0108) | `DeliveryMode` lacks KANBAN — a hybrid program with one flow team can't express it |
| **XP** | Mixed — see §3.2 | AC with Given/When/Then + review trail; DOR gate; inbound/outbound webhooks; SPIKE/BUG types; sustainable-pace guardrails | No pairing/multi-assignee; no automated test-result ingestion; no tech-debt category |
| **SAFe-style (within one program)** | Partial by design (~40%) | Program entity, ceremony templates, rollup KPIs, cross-project risk propagation, program backlog (ADR-0069/0070/0079) | No PI planning, no ART board, no cross-team velocity — most of this is correctly Enterprise per the boundary, but **program-level board within one program is OSS-legitimate and absent** |

### 3.2 XP deep-dive (added per request)

| XP practice | Status | Detail |
|---|---|---|
| Planning game | **Strong** | 3-point PERT + estimation governance (OPEN/SUGGEST_APPROVE/PM_ONLY), sprint capacity vs commitment split (ADR-0073), subtasks for splitting (ADR-0060), scope-injection gate (ADR-0102) |
| Acceptance-test driven | **Strong model, manual loop** | `AcceptanceCriterion` (given/when/then, `met_by`/`met_at` trail, DOR gate enforces all-met before READY). But criteria flip only by hand — no CI test-result ingestion |
| Small releases / CD | **Partial** | Git-aware task links (PR/MR/issue, read-only via `TaskLink` providers); inbound task-sync (ADR-0068, HMAC, rate-limited); Release object not until 0.7 (ADR-0099) |
| Continuous integration signals | **Plumbing yes, surface no** | Bi-directional webhooks exist, but no CI/build status on cards and no `sprint.*` events outbound |
| Sustainable pace | **Strong and differentiated** | Capacity preflight, WIP threshold, overallocation heatmap, and — crucially — ADR-0104 team-signal privacy: velocity/pulse default to TEAM visibility, PMO is blocked by default. This is the anti-"velocity as surveillance" guard XP coaches ask for and almost no tool ships |
| Collective ownership / pairing | **Absent** | `Task.assignee` is a single FK; `TaskResource` is capacity math, not co-ownership. No pairing concept anywhere |
| Refactoring / tech debt | **Partial** | TaskType = EPIC/STORY/TASK/BUG/SPIKE — no tech-debt type or flag, so debt can't be tracked or charted distinctly |
| On-site customer | **Strong** | PO facet on TeamMembership (#927), AC ceremony, sprint review outcome read (ADR-0176), prioritization scoring guarded off contributor views |

### 3.3 What 0.3 needs to be *lovable* (gap list, prioritized)

The 0.3 theme is "The Agile Team." The planned scope nails Scrum/hybrid depth. To make it lovable *across* methodologies:

1. **Per-column WIP limits, persisted + breach signal** — extend `BoardColumnConfig.columns` JSON with `wip_limit`; board column header shows count/limit and flips at-risk. Small change (model is lazy-created JSON; no migration of shape needed), closes the most-cited Kanban gap, and the sprint-level pattern (#546) already established the UX.
2. **Cycle time + CFD from data you already have.** `Task.status_changed_at` plus `django-simple-history` rows on `Task.status` mean per-column residency is *already recorded* — no new write path. A read-only `/projects/{id}/flow-metrics/` endpoint (cycle time percentiles, lead time, daily per-status counts for CFD) plus a Reports-tab chart is pure derivation. This single feature converts the Kanban story from "weak" to "credible" and gives Alex the flow metrics his maturing stakeholders ask for (persona file, line 405).
3. **KANBAN `DeliveryMode` (#410)** — the enum and tab-preset plumbing exist; a flow team inside a hybrid program currently has to cosplay as SCRUM. Without it, "teams choose their method" (personas philosophy, line 12) is false for one of the three methods.
4. **CI test-result ingestion to flip AC** — one inbound endpoint (extend ADR-0068 token model): CI posts pass/fail per criterion or per task; `met_by` records the token identity. Closes the XP acceptance loop and is the cheapest "developers love it" feature available.
5. **`sprint.activated` / `sprint.closed` / `sprint.scope_changed` webhook events** — see §4; without them the 0.3 sprint sovereignty story is invisible to external tooling.
6. **Tech-debt visibility** — either a `TECH_DEBT` TaskType or a boolean flag + board filter. Trivial; disproportionate goodwill from engineering teams.
7. *(Defer, but file it)* multi-assignee/pairing — real demand, real model cost; 0.5+ with resources work.

Items 1, 2, 5 and 6 are small relative to what's already in the 0.3 plan; 3 is medium; 4 is small-medium.

---

## 4. Is it API-first? Gaps

**The core claim holds.** ~150 REST endpoints across all apps; CPM and Monte Carlo are exposed (`/projects/{pk}/schedule/`, `/projects/{pk}/monte-carlo/`) not library-only; sprint lifecycle, board moves, baselines, time, import/export, offline sync, history reads — all reachable; web is a JWT-bearing API consumer; OpenAPI schema is CI-drift-guarded with worktree-safe regeneration; the browser WASM CPM is a drag-*preview* with the server authoritative (correct pattern, not a violation). Real-time goes through Channels consumers. The one fixtures directory in web (`src/fixtures/monteCarlo.ts`) is test scaffolding, not a shadow data path.

**Gaps, in priority order:**

1. **Webhook event coverage (hard cap of 11, all task/dependency/schedule/project).** Missing entirely: sprint lifecycle, board/status transitions as first-class events, risk events, baseline events, comment/mention events beyond `task.mentioned`. ADR-0083 deliberately capped the catalog — revisit the cap for 0.3's domain. An external dashboard cannot today observe a sprint closing.
2. **No user-scoped API tokens (PATs).** `ProjectApiToken` exists but is project-scoped and inbound-sync-specific. Automation acting *as a user* must use JWT password flows. With MCP write surface coming in 0.6 and agent-as-actor (ADR-0112), PATs with scopes are a prerequisite — earlier is cheaper.
3. **Rate limiting** exists only on the inbound-sync path (100/min steady). No documented general API throttle; self-hosters get no protection or guidance. DRF throttling + a documented default is a half-day.
4. **No API deprecation/versioning policy ahead of the 0.9 "public API v1 freeze".** Single `/api/v1/` path is fine, but the freeze needs a published stability contract (what's covered, deprecation window, change classes) *before* 0.6 invites external consumers. Write the policy doc in 0.3–0.4 while the surface is still cheap to change.
5. **Calendar management API completeness** — flagged as possibly partial; verify CRUD on calendars/exceptions is fully exposed (working-time data is critical for any external scheduler integration).
6. **Flow/analytics reads** — the §3.3 flow-metrics endpoint is also an API-first item: today a consumer can't get cycle time without replaying history rows themselves.

---

## 5. Demo data — from snapshot to simulated life

### 5.1 What exists (more than expected)

- **Canonical seed format** (ADR-0109): `seed_v1.json` schema, validation with full-error collection, idempotent two-pass importer (`apps/projects/seed/importer.py`), round-trip exporter.
- **Four bundled samples** (`apps/projects/fixtures/seeds/`): `atlas-platform-launch` (hybrid program, 3 projects, 15 accounts, 21+ sprints, 100+ tasks, baselines, risks), `aurora-mobile-app` (pure Scrum), `bayside-civic-center` (pure waterfall, all 4 dependency types, weather calendar), `helios-crm-replacement` (small hybrid). Deliberately mapped to methodology stories — good.
- **API**: `POST /programs/import`, `GET /programs/samples`, `GET /programs/{id}/export`.
- **UI**: `LoadSampleButton` (#375) in the Programs header *and* the zero-state hero; `SampleDataBanner` with owner-gated remove on `is_sample` programs. (An earlier internal review claimed no UI existed — that's wrong; it shipped.)
- **`seed_demo_project` management command**: the richest dataset — relative-to-today dates, 8 closed sprints with realistic velocity spread, an active sprint with 8 days of burndown including a day-4 scope add, a retro with a promoted action item, an over-allocated resource, an overdue milestone, optional persona logins (`--with-personas`, 6 users).

### 5.2 The gap: no history, frozen clock

Your requirement — *"history should show movements & actions since it was created to the current state"* — fails on three counts today:

1. **All history is stamped at import.** The importer does plain ORM writes; `django-simple-history` therefore creates one historical row per object with `history_date = now()` and `history_user = importer`. Open any task's History tab (ADR-0011/0096 surfaces) on a fresh demo: every object was "created today by one person." There are no intermediate rows — a COMPLETE task never *was* IN_PROGRESS as far as history shows.
2. **JSON seeds carry fixed dates.** `scripts/seeds/build_atlas_seed.py` pins `KICKOFF = date(2026, 1, 5)` and the importer does no date shifting. Today the Atlas demo already looks 5 months old; in a year it's a museum piece. (`seed_demo_project` got this right with relative dates — the JSON path regressed it.)
3. **Schema v1 has no history constructs.** No burn snapshots, comments, retro content, status-transition events, or actor attribution in the seed format. Only the management command hand-builds burndown/retro, and it isn't reachable from the UI.

### 5.3 Design: seed schema v2 with event replay

**Principle: a demo seed is a *script*, not a snapshot.** The importer becomes a replay engine.

1. **Relative dates everywhere.** All dates encode as day-offsets from an `anchor` resolved to *import day* (e.g. `"start": "A-120"`). The builder scripts already think this way internally; move the convention into the schema and shift at import. Weekend/calendar snapping happens through the existing Calendar model.
2. **An `events` section** — an ordered timeline of actions with offsets and actors:
   `{at: "A-87T14:10", actor: "priya", action: "task.status", task: "story-checkout", from: "IN_PROGRESS", to: "REVIEW"}` — covering: create, status transitions, assignment changes, estimate set/approve, sprint activate/close (with commitment snapshots), scope injection + acceptance, baseline capture, risk lifecycle, comment posts, AC met, retro + action-item promotion, time entries.
3. **Replay with backdating.** Apply events chronologically; for each write set `instance._history_date = event.at` (simple-history supports this) and `_history_user` from a **persona actor map**. `auto_now_add` fields (comments, snapshots) are set via `bulk_create` or post-create `update()`. Derived artifacts fall out for free: `SprintBurnSnapshot` rows generate per replayed day; `status_changed_at` lands on the last transition; velocity history becomes real history rather than asserted numbers.
4. **Synthesizer for the boring middle.** Authoring every event for 100+ tasks is unsustainable. Final-state seeds get a deterministic (seeded-RNG) synthesis pass: walk each task backward from its current status through the canonical column sequence, distributing transition dates plausibly inside its sprint/schedule window, assigning actors from the roster. Schema-authored events override; synthesis fills gaps. Hand-author only narrative beats (the scope-add, the slipped milestone, the spicy retro).
5. **Actor policy.** The UI import path forces `create_users=False` (correct — never mint logins on live instances). Demo actors should therefore be **display-only attribution** (history rows reference seeded persona identities without login capability), with the dev/CLI path keeping `--with-personas` real logins. Map actors to the persona cast — Sarah making schedule changes, Alex closing sprints, Jordan reordering backlog, Priya moving cards — so the demo also *teaches the persona model*.
6. **Suppress side effects during replay.** Webhooks, notifications, and email must not fire for synthetic events (wrap replay in the existing dispatch-suppression seams / skip `transaction.on_commit` outbox enqueues); recalc once at the end as the importer already does.

**Acceptance criteria for "first-class":** import Atlas from the UI button → (a) project reads as started ~5 months ago *relative to today*; (b) any COMPLETE task's history shows dated transitions by named people; (c) the activity timeline reads like a believable project narrative; (d) burndown/velocity charts show multi-sprint real history; (e) export→import round-trips events; (f) `Remove demo` still cleanly tears down. Smoke-test in CI by importing and asserting history-row counts and date spreads — this also hardens the 0.3 "universal JSON import/export" deliverable, so the work lands inside an already-planned 0.3 item rather than beside it.

---

## 6. Personas — interrogation and updates

`.claude/personas.md` is genuinely strong: 8 personas with hard NOs, one-question filters, time budgets, 10/10 anchors, decision authority; a P3M-layer mapping that *drives the OSS/Enterprise boundary*; a VoC scoring rubric; cross-persona tensions; and 5 anti-personas. The tension table ("a feature that ignores a tension is technical debt with a customer-facing fuse") is the best artifact in the file. Recommended updates:

1. **Resolve the Sarah/mobile contradiction.** Persona #1's hard NO is "web-only / no real native mobile app," and her one-question filter is offline mobile — yet mobile ships Android-first in 0.4 and iPhone-parity at 1.0. Until then every VoC run scoring Sarah should be returning 🔴 blockers, and if it isn't, the rubric isn't being applied honestly. Either annotate the persona ("Sarah is a 0.4+/1.0 persona; pre-0.4 VoC runs weight her accordingly") or accept that 0.1–0.3 releases are Alex/Jordan/Priya releases and say so in the roadmap.
2. **Add Persona 9: the integration/API developer.** The platform's identity is API-first; 0.4 ships a read-only MCP server, 0.6 ships MCP writes and connectors, ADR-0112 defines agent-as-actor — and *nobody on the panel* evaluates webhook ergonomics, token scoping, schema stability, or docs quality. Every §4 gap (events, PATs, rate limits, deprecation policy) exists partly because no persona pulls on it. This is the highest-value persona addition.
3. **Add Persona 10: the self-hosting operator.** OSS adoption begins with someone running `helm install`. Upgrade safety, backup/restore, observability, resource sizing, dead-letter alerting (ADR-0084 ships *for* this person) have no advocate. The GitLab adoption model the project explicitly copies lives or dies on this persona's first 30 minutes.
4. **Add an AI-agent actor note (not a full persona).** With ADR-0112 and the 0.4 AI-native foundation, an agent operating via API becomes a user class with RBAC and audit implications. A short section defining what agents may never do (mirroring hard NOs) would keep `/voc` and `/ai-review` aligned.
5. **Add a persona↔RBAC mapping table.** The 5 roles (Viewer 0 / Member 100 / Scheduler 200 / Admin 300 / Owner 400, `apps/access/models.py`) map to personas only by inference. Jordan (PO) is the sharpest case: backlog sovereignty needs more than Member, less than Admin — the team-facet approach (#927) is the answer, but the persona file should document the mapping so RBAC reviews (`/rbac-check`) have a reference.
6. **David's hard NO is honestly scheduled** (partial allocation lands 0.5) — fine, but annotate like Sarah's so pre-0.5 VoC runs treat David scores correctly.
7. **Tie demo seeds to personas explicitly.** Each bundled sample should declare which persona's story it tells (aurora→Alex/Jordan, bayside→Sarah, atlas→program-level, helios→hybrid bridge) in `samples.py` descriptions — and §5.3's actor mapping makes the demo a working persona showcase.
8. **Keep the anti-personas** — they're doing their job; no changes needed.

---

## 7. Beyond-scope findings

1. **ADR numbering collisions.** Duplicates: 0079 (×2), 0083 (×3), 0087, 0088, 0090, 0091, 0092 (×2 each), 0109 (×2); gaps at 0003–0009, 0095, 0098–0100. ADRs are the declared source of record and code comments cite them by number; "per ADR-0083" now has three referents. Fix cheaply: renumber the younger duplicates, add an index file, and a 5-line CI check that fails on duplicate prefixes. _**Resolved by #918 (2026-06-23):** the duplicates that were still live at fix time (0079, 0083×3, 0087, 0090, 0092, 0109, 0111, 0126, 0135) were renumbered by canonical external usage and the CI duplicate-prefix gate was added. An ADR index file remains a future nicety._
2. **`changelog.d/` is empty** — including the README that `CLAUDE.md` says defines the naming convention. If fragments were assembled for a 0.2 release that hasn't actually tagged (see next), the changelog state and release state disagree.
3. **0.2 stable slip vs version-tense rule.** Roadmap targeted 0.2 stable for Jun 8; packages remain 0.2.0-alpha.1 on Jun 10. The repo has a rule written in blood (issue #807) about past-tense claims for untagged versions. Run the prescribed grep over `packages/website/src/content/docs/` for "0.2" tense violations *now*, and update the roadmap's Underway/Shipped classification if the date slipped.
4. **Scheduler PyPI status** is `Development Status :: Alpha` at 0.2.0a1 — consistent; just ensure README install instructions don't imply stable.
5. **Strengths worth naming** (so they survive refactors): the scope-injection approve-gate (ADR-0102) + team-signal privacy (ADR-0104) pair is the most defensible differentiator in the agile market — it's the only credible answer to Morgan's "autonomy vs surveillance" filter; the version-tense rule, boundary CI, and pre-push gate are unusually mature process for a pre-1.0 project.

---

## 8. Consolidated recommendations

**Land in 0.3** (small/medium, theme-aligned):
1. Per-column WIP limits (persist in `BoardColumnConfig.columns`, breach signal on board).
2. Flow metrics read API + Reports charts (cycle/lead time, CFD) derived from existing history — no new writes.
3. KANBAN `DeliveryMode` (#410).
4. Sprint lifecycle webhook events (`sprint.activated/closed/scope_changed`).
5. Seed schema v2: relative dates + event replay + history backdating + persona actors (folds into the planned "sample projects + universal JSON import/export" deliverable). §5.3.
6. CI test-result ingestion endpoint to flip `AcceptanceCriterion.met` *(stretch)*.
7. Tech-debt task type/flag *(trivial)*.
8. Persona file updates (§6 items 1, 5, 6, 7) — docs-only.
9. Hygiene: ADR renumber + CI duplicate check; 0.2 tense sweep; restore `changelog.d/README.md`.

**0.4–0.5:**
10. Personal access tokens with scopes (before MCP write in 0.6, ideally alongside 0.4's read-only MCP).
11. General API rate limiting + docs; API stability/deprecation policy doc ahead of the 0.9 freeze.
12. New personas: integration developer + self-hosting operator; AI-agent actor note.
13. Calendar API completeness check.

**Backlog (file now, schedule later):**
14. Multi-assignee/pairing model (with 0.5 resources work).
15. Webhook catalog expansion beyond agile events (risk, baseline).
16. Program-level board (OSS-legitimate single-program surface).

**Verify on GitLab (needs tracker access):** §2's four checks — 0.3 milestone contents, orphaned #410, TODO sweep, changelog/release-state consistency.

---

## 9. Issue tracking (triage addendum, 2026-06-12)

Triaged §8's recommendations against the live tracker. **All 16 are already filed** (this audit was filed as the `fable-audit-20260610` batch). Mapping:

| # | Recommendation | Issue | State |
|---|---|---|---|
| 1 | Per-column WIP limits + breach signal | [#1071](https://gitlab.com/trueppm/trueppm/-/issues/1071) (web indicator [#1139](https://gitlab.com/trueppm/trueppm/-/issues/1139)) | open |
| 2 | Flow metrics read API + CFD/cycle/lead | [#1072](https://gitlab.com/trueppm/trueppm/-/issues/1072) | open |
| 3 | KANBAN `DeliveryMode` | [#410](https://gitlab.com/trueppm/trueppm/-/issues/410) (0.3, not orphaned) | open |
| 4 | Sprint lifecycle webhook events | [#1073](https://gitlab.com/trueppm/trueppm/-/issues/1073) | open |
| 5 | Seed schema v2 (replay engine) | [#1074](https://gitlab.com/trueppm/trueppm/-/issues/1074) | open |
| 6 | CI test-result ingestion → AC | [#1075](https://gitlab.com/trueppm/trueppm/-/issues/1075) | open |
| 7 | Tech-debt task type/flag | [#1076](https://gitlab.com/trueppm/trueppm/-/issues/1076) | open |
| 8 | Persona file updates | [#1077](https://gitlab.com/trueppm/trueppm/-/issues/1077) | open |
| 9 | ADR hygiene (renumber/index/CI) | [#918](https://gitlab.com/trueppm/trueppm/-/issues/918) (parent [#877](https://gitlab.com/trueppm/trueppm/-/issues/877)) | open |
| 10 | PATs with scopes | [#648](https://gitlab.com/trueppm/trueppm/-/issues/648) + [#601](https://gitlab.com/trueppm/trueppm/-/issues/601) | open |
| 11 | API rate limiting + deprecation policy | [#1080](https://gitlab.com/trueppm/trueppm/-/issues/1080) (freeze [#726](https://gitlab.com/trueppm/trueppm/-/issues/726)) | open |
| 12 | New personas (integration / operator / agent) | [#1078](https://gitlab.com/trueppm/trueppm/-/issues/1078) | open |
| 13 | Calendar API completeness | [#1079](https://gitlab.com/trueppm/trueppm/-/issues/1079) | open |
| 14 | Multi-assignee / pairing | [#1081](https://gitlab.com/trueppm/trueppm/-/issues/1081) | open |
| 15 | Webhook catalog expansion | [#1082](https://gitlab.com/trueppm/trueppm/-/issues/1082) | open |
| 16 | Program-level board (single program, OSS) | [#1083](https://gitlab.com/trueppm/trueppm/-/issues/1083) | open |

All 16 are correctly OSS (no cross-program/portfolio/SSO/audit-trail scope; #1083 and #16 are explicitly single-program).

**§2 verification resolutions:** (A) #410 is open and milestoned 0.3 — **not orphaned**. (B) `changelog.d/README.md` **exists** on main. (C) TODO sweep found **`TODO(#185)` points at a CLOSED issue** — a latent `lint:todo-grep` CI liability (the gate fails on closed-issue refs when that file is next touched); worth a one-off cleanup, not yet filed.

**Scope boost (resolved):** #918 was widened beyond the original 7 collisions to renumber every duplicate that was still live at fix time — the original set plus the 0109/0111/0126/0135 duplicates that churned in during the Wave-4 merges — and it adds the CI duplicate-prefix guard ([`scripts/check-adr-collisions.sh`](https://gitlab.com/trueppm/trueppm/-/issues/918)). A standalone ADR index file was left out of scope as a future nicety.

---

*Audit method note: produced by static analysis with five parallel exploration passes plus targeted verification reads; two exploration-level claims were caught and corrected during verification (per-column WIP limits do **not** persist; the demo-data UI **does** exist). No tests were executed (sandbox unavailable). File written but not committed — it is untracked; commit via a `docs/` branch + MR per repo convention if you want to keep it.*
