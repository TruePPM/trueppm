# ADR-1478: A server-resolved project view set — lens seeds, source-tagged hides, and the `hidden_views` migration

## Status

Accepted (2026-11-24)

> **Implementation status (2026-11-24, at acceptance):** the *decision* stands, but **none of it
> is built yet**. Verified 2026-11-24: no `ProjectViewState`, `resolve_project_views`,
> `LENS_VIEW_SEEDS` or `/views/` route exists under `packages/api/src`, `packages/web/src`
> or `packages/mcp/src`, and `contracts/` holds no `methodology-views.json`.
> `UserProfile.hidden_views` and the #3713 seed are still the live mechanism.
> Implementation is #3715.

## Context

**P3M layer:** Programs and Projects (per-user navigation within a project). OSS.

The views a person sees in a project are composed today from four inputs. Three of them are
resolved in the web bundle:

| Input | Where it lives | Scope |
|---|---|---|
| Methodology preset (ADR-0041) | `HIDDEN_FOR_METHODOLOGY` in `packages/web/src/features/shell/methodologyTabs.ts`. WATERFALL hides `sprints` and `product-backlog`; AGILE hides `schedule` and `calendar`. Shell v2 overrides AGILE's `schedule` hide (ADR-1298, `contextTabs.ts`). | per project, client-side |
| Workspace capability (ADR-1460) | `GET /workspace/` `capabilities[]` | per workspace, hide-only |
| Personal hides (ADR-0139) | `UserProfile.hidden_views`, a flat list validated against `profiles/constants.py::HIDEABLE_VIEW_KEYS` and `contracts/hideable-views.json` | per user, **global** |
| First-project seed (#3713) | `profiles/services.py::seed_hidden_views_for_first_project`, from methodology | written once into the global list |

The role lens (ADR-0162, `RoleContext` = `pm` \| `scrum_master` \| `unified`) reorders
views and never changes which are visible.

#3715 asks for a *suggest* layer, where the lens seeds a person's hidden views. Redesign
Pass 5 §1 (`docs/design/pass5/`, frames 1A–1D) designs it and settles several points:
- seeded-hidden is a distinct state from user-hidden (Q5.1);
- a lens change never re-seeds automatically (Q5.2);
- each hide records its source;
- Overview, one Plan layout and More can never be hidden;
- the UI never resolves precedence itself.

A global flat list can't express any of that, so the store and the resolver must change.

## Decision

### 1. Storage: per user, per project, with a source

A new model in `apps/profiles`:

**`ProjectViewState`** holds one row per `(user, project)`, created on first resolve.

| Field | Meaning |
|---|---|
| `seeded_lens` | The lens the seed used, or null when nothing was seeded |
| `seeded_at` | When the seed was applied |
| `seed_line_dismissed_at` | When the person dismissed the one-time explainer line (1A) |
| `lens_offer_dismissed_for` | The lens whose "Apply {lens} suggestions…" offer was dismissed (1C) |
| `last_layouts` | JSON such as `{"plan":"gantt","deliver":"board"}`. The remembered layout from Pass 5 §2, which #3887 draws. |
| `hides` | JSON list of `{view, source: "seed"\|"user", lens, at}` |

`hides` is a JSON list on one row rather than a row per view, for three reasons:
- the set is small (at most 12 keys);
- it is always read and written whole;
- a set-level `UniqueConstraint(user, project)` plus `select_for_update` gives atomic
  replace semantics with no per-key races.

`server_version` is not added. View state is an online preference, not synced data, and the
offline mobile layer (#41) doesn't carry `UserProfile` either.

### 2. The seed registry, server-side

`profiles/constants.py` gains `LENS_VIEW_SEEDS: dict[str, LensSeed]`, keyed by `RoleContext`.
Each entry carries `hide: frozenset[view_key]` and `landing: {methodology: view_key}`.
Initial values come from Pass 5 frame 1A:

| Lens | Hides | Opens on (Waterfall / Agile / Hybrid) |
|---|---|---|
| `pm` | `product-backlog` | `schedule` / `schedule` / `schedule` |
| `scrum_master` | `schedule`, `calendar`, `resources` | `board` / `board` / `board` |
| `unified` | nothing (today's default, no seed) | as today |

The Product Owner lens doesn't exist (`RoleContext` has no `product_owner`). Its seed, which
hides `schedule`, `calendar`, `risk` and `resources` and lands on `product-backlog`, is added
in the same change that adds the lens (#1467). This ADR doesn't add a lens.

`HIDDEN_FOR_METHODOLOGY` moves to `profiles/constants.py`. It joins `contracts/hideable-views.json`
as a second contract file, `contracts/methodology-views.json`, asserted from pytest and vitest
the way `hideable-views.json` already is. The web keeps its copy only for the pre-save flip
warning (#3294), and that copy is checked against the contract.

A seed may only name keys in `HIDEABLE_VIEW_KEYS`. A seed naming a retired key is ignored
and logged. That is how #3887's view inventory can retire keys without editing this ADR.

### 3. Resolution, and what "binding" means

`profiles/services.py::resolve_project_views(user, project)` returns one entry per view key.

Precedence: methodology default, then workspace capability, then the lens seed (narrows only),
then the user's own choices (override the seed). The fields:

| Field | Values |
|---|---|
| `key` | the view key |
| `visible` | bool |
| `source` | `always` \| `methodology` \| `capability` \| `seed` \| `user` \| `default` |
| `binding` | `advisory` \| `enforced` |
| `lens` | set when `source` is `seed` |
| `at` | when the hide was set |

**Q1.1 is answered the other way from the canvas's recommendation, and this is called out
deliberately.** Methodology stays **advisory**, as ADR-0041 and today's code define it: "the
preset communicates 'this is not how we work here', not 'this is not allowed'", and
methodology-hidden views stay reachable by URL. The canvas recommended that methodology own
an *allowed* set. Nothing in the tree enforces that today, and enforcing it would be a new
authorization-shaped rule for a preference. ADR-0041 would have to be superseded explicitly,
not drifted past. Frame 1C's "◑ This project is Waterfall, so it has no sprints" note stays
correct as a description of the default.

`binding: enforced` therefore means only one thing: **the web refuses to render the view and
shows the AreaOff page** (Pass 4 · 1B), because the workspace turned the area off (ADR-1460).
It is a UI contract, not API authorization. ADR-1460's areas are hide-only, and the API keeps
reading and writing them. Everything else is `advisory`: it opens from More and by URL. A
client must never read `visible: false` as forbidden.

**Never empty.**
- `overview` and `settings` are already absent from `HIDEABLE_VIEW_KEYS` (`source: always`).
- **ADR-1298 holds: Plan always offers Schedule.** Methodology never removes `schedule`. That
  is shell v2's `ALWAYS_VISIBLE_PROJECT_VIEWS` (`contextTabs.ts`), and the server resolver
  adopts it, so AGILE's methodology default hides only `calendar` in the resolved set.
  Like a user's hide, a seed hide of `schedule` is honored (ADR-1298: "a person's own
  `hidden_views` choice is still honored"), because a seed is a labeled, reversible
  suggestion, not a methodology rule.
- If seed and user hides together would leave Plan with no layout, the resolver shows
  `schedule` with `source: always`.
- A seed or user write that would hide the last Plan layout is refused with
  `400 last_plan_layout`.

**Allocation managers (Q1.7).** No seed hides `resources` for a person who manages a capacity
pool (ADR-1461). Pools don't exist yet (#3122 is open), so the check is a single function,
`is_allocation_manager(user, workspace)`. It returns `False` until #3122 ships, and #3122
implements it. A person's own hide of `resources` is always honored.

### 4. Seeding: on first resolve, idempotently

The first `resolve_project_views` for a `(user, project)` with no `ProjectViewState`:
1. creates the row;
2. applies `LENS_VIEW_SEEDS[user.role_context]`, narrowed by methodology;
3. sets `seeded_lens` and `seeded_at`.

It runs under the `(user, project)` unique constraint with `get_or_create`, so concurrent first
reads seed once.

This is a write on first read, chosen on purpose. Membership is created on at least six paths:
project create, invite accept, program add, import, admin add, and Enterprise directory sync
(through extension points). A seed hooked into all of them would be missed on the next one
added.

- **Failure:** if the seed write fails, the resolver returns every allowed view with
  `source: default` and writes nothing, so the next read seeds (frame 1A "fails open").
- **Lens change (Q5.2):**
  - Changing `UserProfile.role_context` reorders and never re-seeds.
  - `POST /projects/{id}/views/apply-seed/ {lens, dry_run}` returns the diff (Will hide /
    Will open on / Kept) and, when `dry_run` is false, rewrites **only** `source: "seed"`
    entries.
  - `POST …/views/reset/` restores the current lens's seed and leaves user entries alone.

### 5. API

| Method and path | Who | What |
|---|---|---|
| `GET /projects/{id}/views/` | project member | The resolved set (§3), plus `seed_line` (show or not), `lens_offer` (a lens or null) and `last_layouts` |
| `PATCH /projects/{id}/views/` | the member, about their own state | `{key, hidden}` sets a `user` entry. `{seed_line_dismissed: true}`, `{lens_offer_dismissed: lens}` and `{last_layouts: {...}}` set those fields. |
| `POST /projects/{id}/views/apply-seed/` | the member | as in §4 |
| `POST /projects/{id}/views/reset/` | the member | as in §4 |

- **Ownership:** every write applies to the requesting user's own row. There is no path to
  read or write another person's view state, and the view is scoped by membership
  (`ProjectScopedViewSet`).
- **Schema:** `source` and `binding` are OpenAPI enums.
- **MCP (Q1.5):** a read tool, `get_project_views`, returns the caller's resolved set. It is
  the "why can't I see Sprints?" fact an agent needs.

### 6. Migrating `UserProfile.hidden_views` (#3713)

1. **Data migration:** for each `UserProfile` with a non-empty `hidden_views`, and each project
   the user is a member of, create `ProjectViewState` with those keys as `source: "user"`
   entries and `seeded_at` null. Nothing reappears and nothing is re-seeded. The migration
   runs in batches with a `RunPython` that is idempotent on the unique constraint, and it
   imports no live service (CLAUDE.md migration rule 3; a frozen copy lives in
   `profiles/backfill.py`).

   > **Clarification (2026-11-24, maintainer decision during #3715 review).** An empty
   > `hidden_views` does not mean "never customized" for a project the user had already
   > opened. The same migration also creates a row, with no entries and `seeded_lens` set
   > to the user's lens at migration time, for each `ProjectVisit` on a live membership of
   > a user whose list is empty (or who has no profile). Those projects resolve without a
   > seed and without an offer, as backfilled non-empty lists do. The cutoff is the
   > migration run itself, not a date compared against `visited_at`, because `visited_at`
   > records the *last* visit and every open after the upgrade overwrites it. A project
   > joined or first opened after the upgrade has no row and still seeds. Separately, a
   > row created on first resolve carries the stored list in as `source: "user"` entries,
   > so a list written while the user had no live membership is not lost.
2. **Compatibility window, one minor release:**
   - `GET /auth/me/` and `GET /auth/me/profile/` keep returning `hidden_views`, now computed as the
     de-duplicated union of the user's `source: "user"` hides across their projects.
   - `PATCH /auth/me/profile/ {hidden_views}` keeps working: it fans out as `source: "user"` entries to
     every project the user belongs to, which is today's global semantics. The v1 shell's
     Customize views, still the default UI, keeps working unchanged.
   - Both responses carry `Deprecation` and `Sunset` headers, and the field is marked
     `deprecated: true` in the schema.
3. **Removal:** the field is removed after that release, in a `null=True`-then-remove
   sequence per CLAUDE.md migration rule 8. `seed_hidden_views_for_first_project` is deleted
   in step 1's release, because the lens seed supersedes it.

This corrects one line in #3715 and #5122, which said writes to `hidden_views` "return a
pointer to `…/views/`". Refusing writes would break the default v1 shell, so they fan out
instead.

## AI review (2026-11-24, before implementation)

**Verdict:** AI-ready.

| Check | Verdict | Note |
|---|---|---|
| 1 API-first / MCP | PASS | Precedence moves from the web bundle to `resolve_project_views`, with the `get_project_views` MCP read |
| 2 Provenance | PASS | Each entry carries `source`, `binding`, `lens` and `at`, the "why" behind visibility |
| 3 Write safety | PASS | Writes apply only to the caller's own row, keys are validated against `HIDEABLE_VIEW_KEYS`, and a write that would hide the last Plan layout is refused with `400 last_plan_layout` |
| 4 Decision memory | PASS (non-goal) | These are navigation preferences, not plan decisions |
| 5 AI boundary | PASS | OSS. An admin-editable seed registry would need an `enterprise-check` first (Q1.3). |

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Per-(user, project) row with a `hides` list (chosen)** | One read, atomic replace, small | JSON not queryable by key. Nothing needs that query. |
| B. One row per (user, project, view) | Queryable | Twelve rows per member per project, and per-key races on Reset and Apply |
| C. Keep the global list and add a parallel per-project override | Smaller migration | Two stores that can disagree, which is the drift `contracts/hideable-views.json` exists to stop |
| D. Seed at membership creation | No write on read | At least six creation paths, and missing one is silent (§4) |
| E. Methodology as an enforced allowed set (canvas Q1.1 recommendation) | Matches the brief | Contradicts ADR-0041 and today's behavior, and adds an authorization-shaped rule to a preference. Needs an explicit supersession, not this ADR. |

## Consequences

- **Easier:**
  - One resolver serves web, phone and MCP.
  - A Scrum Master stops carrying the full waterfall plan.
  - "Why is Gantt missing?" has an answer with a source.
  - #3887 can retire view keys without touching seeds.
- **Harder:**
  - Precedence moves out of the web bundle, so shell v1 and shell v2 must both switch to the
    endpoint, or v1 keeps reading the compatibility field until it is retired (#4758 flips
    the default).
  - A second contract file must be kept honest.
- **Risks:**
  - A write on first read: it's bounded to one row per (user, project), idempotent, and fails
    open.
  - The fan-out on `PATCH hidden_views` is O(memberships) per write. It's a single bulk
    upsert, and the field is retired after one release.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: api, web, mcp
- Migration required: yes. One new table and a data migration from `UserProfile.hidden_views`.
  Field removal comes a release later.
- API changes: yes. Four routes under `/projects/{id}/views/`; `hidden_views` deprecated with
  headers; a new MCP read tool. These are new routes, so `test_role_route_matrix.py` needs its
  oracle updated.
- OSS or Enterprise: OSS. An admin-editable seed registry (Q1.3) would edge toward org policy.
  Seeds ship as defaults only, and editability needs an `enterprise-check` first.

### Durable Execution
1. **Broker-down behavior:** N/A. All writes are synchronous DB writes, with no Celery dispatch
   and no broadcast (per-user state).
2. **Drain task:** N/A.
3. **Orphan window:** N/A.
4. **Service layer:** new `profiles/services.py::resolve_project_views`, `apply_lens_seed`,
   `reset_project_views`, and `is_allocation_manager` (a stub until #3122).
5. **API response on best-effort dispatch:** N/A. Synchronous 200.
6. **Outbox cleanup:** N/A.
7. **Idempotency:**
   - First-resolve seeding is `get_or_create` on `(user, project)`.
   - `apply-seed` and `reset` are deterministic replaces of the seed entries.
   - The data migration is idempotent on the unique constraint.
8. **Dead-letter / failure handling:** N/A. A seeding failure fails open and retries on the
   next read (§4).

### On Acceptance
- [x] `python3 scripts/adr-accepted-issue-sweep.py --adr 1478`: **0** issues, because the
      issues named this ADR only in comments when the sweep ran.
- [x] Rewritten by hand, each led by a dated correction note: **2** (#3715, #5122). The
      deviations below were confirmed by the maintainer at acceptance:
  - methodology stays advisory (Q1.1);
  - Schedule is always offered (ADR-1298);
  - `hidden_views` writes fan out;
  - the Product Owner seed waits for #1467.
