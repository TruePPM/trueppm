# ADR-0508: Expand the ⌘K command palette — Recent projects, scope-aware task cap, off-project switcher

## Status
Proposed (extends ADR-0138 §"frontend-only, no new endpoints" — see Decision D0; builds on ADR-0150 ProjectVisit and ADR-0401 palette people/overflow work)

## Context
Issue #1557 asks to "expand the ⌘K command palette" so it scales past the demo
workspace into the account size TruePPM is sold for (40+ projects, cross-program).
A code-verified gap analysis against `useCommandItems.ts`, `CommandPalette.tsx`,
`useLocationModel.ts`, the `profiles` app, and the task/backlog search endpoints
resolves the issue into five distinct asks, of which two already ship in full:

1. **Cross-program / global project+program resolution — SHIPPED.**
   `useCommandItems.ts` builds `jump` items for *every* program and project the
   user belongs to, from `useProjects`/`usePrograms` (membership-wide,
   `page_size=200` per ADR-0401 A1). No work.
2. **A "Recent" group — PARTIAL.** The `ProjectVisit` model (ADR-0150,
   `profiles/models.py`) records real last-visited telemetry, indexed
   `(user, -visited_at)`, and `services.most_recent_project()` reads it — but
   returns only **one** project. There is **no recent-*list* endpoint** and no
   `recent` palette group. Backlog/task recents have no telemetry model at all.
3. **Richer result types.** (a) **People — SHIPPED** (ADR-0401 A2: query-gated
   `person` group over `/resources/?search=`, deep-links `/resources?q=`).
   (b) **Epic/Story — MISSING.** The domain supports it (`TaskType` EPIC/STORY/TASK,
   `Task.epic` self-FK, `BacklogItemType`), but there is **no global search
   endpoint**: task search is per-project (`GET /projects/{id}/tasks/?search=`) and
   backlog search is per-program (`GET /programs/{pk}/backlog-items/?q=`). ADR-0401
   (line 69) explicitly records that no workspace-wide task-search endpoint exists.
4. **Top-bar project switcher off project routes — PARTIAL.** `LocationSwitcher`
   (ADR-0203) exists, but `useLocationModel`'s `projectSegment` is `null` whenever
   `projectId` is undefined (`useLocationModel.ts:156-157`) — so from My Work,
   Notifications, or Programs there is no project hop. Web-only.
5. **Relax the static 8-task cap when scoped — MISSING.** `TASK_RESULT_CAP = 8`
   is a static constant (`CommandPalette.tsx:50`) and task search is not
   sprint-scoped. Because the current-project task set is already loaded
   client-side (`useScheduleTasks`), scoping and cap-relaxation are pure web work.

**The binding constraint from ADR-0138.** The v2 palette was scoped
*"frontend-only, no new endpoints."* Asks 2 (Recent list) and 3b (Epic/Story
global search) both **break that constraint** — each needs a new server endpoint.
This ADR supersedes ADR-0138 on that single point (D0) and governs which of the
two new endpoints lands now versus in a dedicated follow-up.

**P3M layer.** Programs and Projects / Operations, scoped to the *individual
user's own reachable set* — the same lens as ADR-0138, ADR-0150, and ADR-0401.
Cross-program *resolution and search* is OSS navigation (table stakes); it must
**not** drift into cross-program *rollup/aggregation*, which is Enterprise
(ADR-0030/0088). `Recent` is per-user private navigation telemetry, a direct
descendant of ADR-0150 (`/auth/me/` landing resolver) and ADR-0221 (`/me/work/`).

**VoC panel (avg 4.0/5, strong ship).** Priority order, most→least user value:
(1) cross-program resolution [shipped]; (2) People [shipped] + Epic/Story [missing]
co-top — Product-Owner persona rates Epic/Story 5/5 but requires **agile vocabulary
("Epic ▸ Story"), never WBS codes**; (3) Recent group — "cheapest high-value,
benefits everyone, no gates"; (4) relaxed cap — medium, "only if *scoped* includes
sprint and stays bounded/paginated"; (5) off-project switcher — lowest
differentiated value, overlaps ask 1, "defer if scope must be cut." Two 🔴 gates:
(a) any new cross-program/global search endpoint **must** filter strictly to the
requester's membership — leaking a project name, task title, or person name across
an access boundary is an IDOR defect; (b) ⌘K is desktop-keyboard-only — a
mobile/offline quick-find is a separate follow-up (referenced in the issue).

## Decision

### D0 — This ADR extends ADR-0138's "no new endpoints" constraint, narrowly
ADR-0138 forbade new API surface so the palette could stay a pure frontend feature.
That constraint is relaxed for exactly one new endpoint this MR — the read-only,
membership-scoped **`GET /me/recent-projects/`** — and no further. Asks 4 and 5 stay
frontend-only. The larger new API surface (ask 3b Epic/Story omni-search) is
**explicitly deferred to a dedicated follow-up** (see Alternatives → "Bundle
Epic/Story") because it is a genuinely new, IDOR-gated, perf-sensitive search
surface that warrants its own `/api-design` + `/threat-model` cycle.

### D1 — Recent projects: `GET /me/recent-projects/` (new, read-only) + a `recent` group
A first-class versioned endpoint that returns the current user's most-recently
**visited** projects, reusing the ADR-0150 `ProjectVisit` telemetry that already
exists — no new model, no migration.

- **Path:** `GET /api/v1/me/recent-projects/`, alongside `/me/work/` (per-user
  namespace), **not** an `@action` on `ProjectViewSet` — the resource is "my recent
  navigation," keyed on `request.user`, not a project sub-resource. (An
  `@action(detail=False)` on `ProjectViewSet` is an acceptable alternative wiring;
  the `/me/` namespace is preferred for semantic parity with `/me/work/` and
  `/auth/me/`.)
- **Query params:** `?limit=<int>` (default **5**, hard max **10**). No other
  params — this is a fixed "recents" strip, not a search surface.
- **RBAC:** `IsAuthenticated`. The queryset is
  `ProjectVisit.objects.filter(user=request.user)` — **own visits only** — and is
  **re-joined to live membership** (`project__memberships__user=request.user`,
  `project__is_deleted=False`, `project__is_archived=False`) so a project the user
  has since been removed from, or that was archived/deleted, never surfaces from a
  stale visit row. There is no path to another user's visits (no `user` param, no
  detail lookup): no IDOR surface.
- **Ordering:** `-visited_at`, served directly by the existing
  `projectvisit_user_recent_idx` index `(user, -visited_at)` — no new index.
- **Response (slim, per row):**
  ```json
  [
    {
      "id": "<project uuid>",
      "name": "Website Relaunch",
      "program_id": "<program uuid|null>",
      "program_name": "Q3 Marketing|null",
      "visited_at": "2026-07-17T14:03:11Z"
    }
  ]
  ```
  `program_id`/`program_name` back the palette row's breadcrumb subtitle so a
  Recent entry is disambiguated across programs; `visited_at` lets the client show
  a relative "2h ago" hint. No counts, no health, no schedule — a governance
  rollup would push this toward Enterprise; this is navigation only.
- **Perf:** one indexed query, `LIMIT ≤ 10`, `select_related("project",
  "project__program")` to fold the program breadcrumb — no N+1, bounded payload.
  Not a hot path (fires on palette open, not per render).
- **Web:** a new `recent` command group renders these as items with the **bare
  project name** as the label (identical to their `jump` twin — same `Project`
  object, same neutral `Project` chip; the ux-design pass superseded the earlier
  "Open: &lt;project&gt;" sketch, since an `Open:` prefix is reserved for `task`
  rows that open a drawer rather than navigate) **only in the empty-query (default)
  state** of the palette — the Spotlight-style "recents when you haven't typed yet"
  pattern. The program + a relative "2h ago" hint go in the muted `detail` span.
  Once the user types, the `recent` group is hidden and the existing fuzzy filter
  over the `jump` group (which already contains every project) owns typed search,
  so a project is never listed twice. Each `recent` item deep-links
  `/projects/:id/overview` (the one view present for every methodology).
- **API-first / agent:** because it is a real endpoint, an MCP agent can call it
  read-only under its own scoped token to answer "what has this user been working
  on lately" — the recents fact is not stranded in the web client.

### D2 — Scope-aware task cap (ask 5, frontend-only)
The cap governs the **current-project** task group (ADR-0138 Tier-2; task search
only exists when `useProjectId()` is defined). "Scoped" is defined **deterministically
as sprint scope**, not "a specific-enough query" (which is untestable):

- **Unscoped (project-wide) search keeps `TASK_RESULT_CAP = 8`** with the ADR-0401 A2
  overflow cue **"Showing first 8 — refine your search."** Unchanged.
- **When the current project has an active sprint** (`useActiveSprint`, already
  cached), the palette renders a **sprint-scoped task sub-group** — matches whose
  `sprint_id` equals the active sprint — under a **raised but still bounded**
  `SPRINT_TASK_RESULT_CAP = 25`. A sprint is a working set the user recognizes and
  wants to see whole; 25 is well above a healthy sprint's task count yet never
  unbounded. The same "Showing N of M" cue fires if a sprint somehow exceeds 25.
- Entirely client-side: the tasks are already loaded via `useScheduleTasks`, and
  `sprint_id` is on each task, so sprint membership is derived without a fetch. No
  new endpoint, no request-shape change (preserves the ADR-0401 A1 route-glob
  invariant that Playwright mocks depend on).

### D3 — Off-project project switcher (ask 4, frontend-only) — reuse `LocationSwitcher` — **DEFERRED to a follow-up MR**
**Not shipped in the Recent+cap MR.** The VoC panel ranked the switcher the
lowest-value ask and "the first thing to cut," and the architecture confirmed it
overlaps the already-shipped cross-program `jump` resolution (ask 1) — a ⌘K →
type-project-name → Enter already gives a near-one-keystroke hop from anywhere.
Landing it also requires modifying the shared, a11y-heavy, e2e-tested
`LocationSegment` to render a placeholder *picker* (not its `< 2 options` static
row) plus a new `useLocationModel` branch — non-trivial risk on a high-traffic
top-bar surface (ADR-0203) for the lowest-value ask. It is therefore filed as its
own follow-up (see "Follow-up issues"); the design below is retained as the
implementation spec for that follow-up. Design (for the follow-up):

Do **not** add a distinct control (that would re-introduce the second wayfinding
surface ADR-0203 deliberately removed). Instead, make `useLocationModel`'s
`projectSegment` **non-null off a project route**:

- When `projectId` is undefined, still build a `projectSegment` from the
  already-loaded membership-wide `projects` list (the same source the on-project
  segment uses), with **no `current`** and a placeholder label
  **"Jump to project…"**. `LocationSegment` already renders this options list as a
  dropdown; each option navigates to `/projects/:id/overview`.
- `LocationSwitcher` renders the placeholder segment where the project name would
  sit, giving a one-hop jump into any project from My Work, Notifications, or the
  Programs list. It **keeps** self-suppressing on `/settings/*` (rule 123 — the
  SettingsShell owns scope switching there) and on mobile stays non-interactive
  wayfinding (switching via the rail drawer), per the existing render split.
- Lowest-value ask (VoC); it is the **first thing to cut** if the MR must be
  trimmed, since it overlaps the shipped cross-program `jump` resolution.

### D4 — Split Epic/Story global search (ask 3b) into a dedicated follow-up
Ask 3b needs a genuinely new omni-search endpoint spanning **two** models with
**different** RBAC scopes (`Task` per-project, `BacklogItem` per-program), an
agile-vocabulary result serializer ("Epic ▸ Story" breadcrumbs, never WBS codes),
trigram/GIN indexing for cross-entity ranking, pagination, and a 🔴 IDOR review.
Bundling that into this 0.4 MR would gate the whole MR on its riskiest, least-baked
piece. It is filed as a follow-up (see "Follow-up issues") to run its own
`/api-design` → `/threat-model` → `/perf-check` chain. The intended shape is
sketched there so the follow-up starts well-formed.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **D1: `GET /me/recent-projects/` reusing `ProjectVisit`** (chosen) | No new model/migration; membership-scoped for free; one indexed query; forward-compatible with ADR-0150's stated "recently-viewed switcher"; MCP-reachable | One new read endpoint to document/test; breaks ADR-0138's "no endpoints" (narrowly, via D0) |
| D1-alt: derive Recent client-side from `-visited_at` with no endpoint | Zero backend | No client telemetry exists — `ProjectVisit` is server-side only; the client cannot know visit order without an endpoint |
| D1-alt: extend `most_recent_project()` to return N and fold into `/auth/me/` | Reuses the landing fetch | Bloats the auth hot path with a list every user pays for; `/auth/me/` is not where a palette-open read belongs |
| **D2: sprint-scoped cap at 25, project-wide stays 8** (chosen) | Deterministic + testable "scoped"; bounded; zero backend; recognizable working set | A second cap constant; sprint sub-group only helps Agile/Hybrid projects (acceptable — Waterfall has no sprint) |
| D2-alt: relax cap on "specific enough query" | Helps every methodology | "Specific enough" is a fuzzy, untestable heuristic; risks unbounded lists; VoC asked for sprint scope specifically |
| **D3: reuse `LocationSwitcher`, unanchored project segment** (chosen) | One wayfinding surface (ADR-0203 invariant); minimal diff; reuses `LocationSegment` dropdown | Placeholder-state ("no current project") is a new render branch to test |
| D3-alt: a distinct top-bar `ProjectSwitcher` control | Purpose-built | Re-introduces the dual-switcher ADR-0203 removed; more chrome; duplicate a11y name risk |
| **D4: split Epic/Story into a follow-up** (chosen) | Keeps the 0.4 MR low-risk + testable; gives the IDOR/perf surface its own gate cycle | Epic/Story (a co-top VoC ask) doesn't land this MR |
| D4-alt: bundle Epic/Story omni-search now | One MR closes all of #1557 | New cross-model IDOR-gated, perf-sensitive endpoint; gates the whole MR on the riskiest piece; needs `/threat-model` this MR can't absorb |

## Consequences
- **Easier:** a PM lands back on recent work in one keystroke; the palette gains a
  bounded sprint-scoped task view; any route offers a one-hop project jump; the
  ADR-0150 "recently-viewed" affordance it was designed for finally exists.
- **Harder:** one new read endpoint to keep documented/tested; a second cap
  constant; #1557 closes in **three** MRs — this one (Recent + scope-aware cap),
  the off-project switcher follow-up (D3), and the Epic/Story omni-search follow-up
  (D4) — not one.
- **Risks:**
  - *Boundary drift* — `/me/recent-projects/` must stay a per-user navigation list
    and never grow counts/health/cross-program rollup (that is Enterprise). Guarded
    by the slim serializer and the membership re-filter.
  - *Stale-visit leakage* — mitigated by re-joining live membership on every read
    (a removed/archived project never surfaces).
  - *Recent/jump duplication* — mitigated by showing `recent` **only** in the
    empty-query state; typed search uses the existing `jump` fuzzy filter.

## Implementation Notes
- **P3M layer:** Programs and Projects / Operations — the individual user's own
  reachable set. **OSS.**
- **Affected packages:** api (`/me/recent-projects/` view + serializer + URL; reuses
  the existing `ProjectVisit` model and `projectvisit_user_recent_idx` index),
  web (`recent` command group + empty-query gating; `SPRINT_TASK_RESULT_CAP` +
  sprint sub-group in `CommandPalette.tsx`). The unanchored `projectSegment` /
  `LocationSwitcher` placeholder (D3) is **deferred to the switcher follow-up** and
  not touched by this MR.
- **Migration required:** **no** — `ProjectVisit` and its index already exist
  (`profiles/0003_projectvisit`, ADR-0150). No schema change.
- **API changes:** yes — one new endpoint, `GET /api/v1/me/recent-projects/`
  (`?limit`, default 5 / max 10; returns `[{id, name, program_id, program_name,
  visited_at}]`). OpenAPI schema regenerated. Asks 4 and 5 add no API surface.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). Boundary guard: the recents
  endpoint is scoped to `request.user`'s own visits, re-filtered to live
  membership, and returns navigation fields only — never cross-program aggregation.

### Durable Execution
1. Broker-down behaviour: **N/A** — all three changes are synchronous reads (a new
   read endpoint + two pure web changes). No async dispatch, no DB writes.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no `transaction.on_commit` / outbox path.
4. Service layer: **N/A** for dispatch. The endpoint reads `ProjectVisit` directly
   (or via a thin `services.recent_projects(user, limit)` helper paralleling the
   existing `most_recent_project`); the `visited_at` rows it reads are written by
   the existing ADR-0150 `record_project_visit` path, unchanged.
5. API response on best-effort dispatch: **N/A** — synchronous `200` with the
   recents list; no `{"queued": true}` path.
6. Outbox cleanup: **N/A** — no outbox rows. `ProjectVisit` is self-bounding
   (one row per user×project, ADR-0150).
7. Idempotency: reads are naturally idempotent; no state mutation.
8. Dead-letter / failure handling: **N/A** — no task. A query error surfaces as a
   standard DRF error and the palette omits the `recent` group (degrades to `jump`),
   exactly as ADR-0138 degrades a failed Tier-2 read.

## Follow-up issues
Spun out of #1557 so this MR stays scoped to Recent + scope-aware cap:
1. **Off-project ⌘K/top-bar project switcher (D3).** — filed as **#2102**. Make the `LocationSwitcher`
   project segment an off-project placeholder picker per D3 above (reuse
   `LocationSegment`; placeholder "Jump to project…"; `aria-label` "Jump to a
   project"; options → `/projects/:id/overview`). Web-only. Lowest VoC value.
2. **Global cross-program Epic/Story omni-search result type (D4, ask 3b).** — filed as **#2103**. A new
   RBAC-filtered, paginated search endpoint spanning `Task` (per-project scope) and
   `BacklogItem` (per-program scope), membership-filtered, returning an agile-vocab
   "Epic ▸ Story" breadcrumb (never WBS codes), trigram/GIN-indexed. Requires
   `/api-design` + `/threat-model` (IDOR) + `/perf-check`. OSS.
3. **Mobile / offline ⌘K-equivalent quick-find (VoC 🔴, Sarah).** — filed as **#2104**. ⌘K is
   desktop-keyboard-only; design a touch quick-find that resolves against the local
   WatermelonDB cache offline. `/mobile-design`.
4. *(optional, low priority)* **Recent tasks/backlog telemetry + palette group.** No
   visit model exists for tasks or backlog items; a `recent` group for those needs a
   new telemetry model first. Deferred until there is demand.
