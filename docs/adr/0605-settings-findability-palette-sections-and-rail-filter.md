# ADR-0605: Settings findability — ⌘K section indexing and in-rail filter

## Status
Proposed

## Context
The Workspace settings surface grew to ~16 sections across 4 groups (Organization /
Delivery / Danger / System). #2298 made the System group scroll-reachable and added
three top-level ⌘K jumps (Workspace settings / Personal settings / Trash) plus the
scroll-spy rail — but finding a *specific* setting still means landing on `/settings`
and scanning the rail. This is the third attempt at the same findability gripe
(#2291 label-only, #2252 IA, #2298 scroll-reachability). Two convergent asks remain:

- **#2319** — index individual settings *sections* into the ⌘K palette so typing
  "sso" / "retention" / "email" jumps straight to that section.
- **#2320** — a filter box on the settings rail that narrows sections in-place.

Both are frontend-only, no API change. The palette *is* the global search surface, so
#2319 doubles as settings search for keyboard users; #2320 serves users already inside
`/settings`.

**P3M layer:** Programs and Projects / Operations (workspace + project + program
settings are all OSS, single-workspace scope). No cross-program aggregation → OSS.

Constraining prior art (from ADR scan):
- **ADR-0146** — the settings shell is a single scroll-spy page per entity; each
  section is a `<SettingsSection id>` anchored region and the rail is a section
  registry keyed by stable anchor ids. This is the substrate both features build on.
- **ADR-0138 / ADR-0508** — palette is a pure, testable `CommandItem[]`; new
  capabilities are added as `CommandItem` groups with empty-query-vs-typed gating and
  bounded caps. Tier-1 targets carry no invented client-only rule (API-first); role
  gating mirrors a server-provided fact.
- The whole `/settings` route tree is wrapped in `<RequireWorkspaceAdmin>` — every
  workspace section is admin-only (all-or-nothing at the route boundary; server
  authoritative). The existing `jump:trash` is pushed unconditionally yet routes into
  that admin-gated tree — a pre-existing inconsistency.

## Decision

### 1. Metadata lives in the existing nav builders, not a new module
Add an optional `keywords?: string` field to `SettingsNavItem` (in `SettingsShell.tsx`)
and populate it in the existing per-scope nav sources. The nav builders **are** the
section catalog — one source of truth per scope, no parallel catalog to drift:
- `workspaceNav.tsx` (`buildWorkspaceNavGroups`) — workspace sections.
- inline `navGroups` in `ProjectSettingsPage.tsx` / `ProgramSettingsPage.tsx`.
- `ME_SETTINGS_LINKS` in `MeSettingsSubNav.tsx` — personal sections (gets a
  `keywords` field on its link objects).

A fully unified cross-scope catalog was rejected: the three shell scopes and the flat
personal subnav have different shapes and lifecycles, and merging them is a large
refactor for no user-visible gain.

### 2. Scope split — palette indexes global sections; rail filter is scope-agnostic
- **#2319 palette** indexes **Workspace + Personal** settings sections only. Both are
  *global* with *static* routes (`/settings#<id>`, `/me/settings/<slug>`) — no dynamic
  entity id required. This is exactly the #2298 gripe (workspace settings). Workspace
  entries are derived from `buildWorkspaceNavGroups({ linked: true })` (which yields
  `to: '/settings#<slug>'`), so labels/keywords/anchors stay in lockstep with the rail
  automatically. Personal entries derive from `ME_SETTINGS_LINKS`.
- **Project / Program** section indexing is **deferred** (follow-up): those need the
  current entity id and methodology-conditional gating, adding scope-context
  complexity for a narrower payoff. Filed as a follow-up on #2319's umbrella.
- **#2320 rail filter** is *scope-agnostic by construction*: it filters whatever
  `navGroups` `SettingsShell` receives, so it works for Workspace, Project, **and**
  Program rails with no per-scope code. Personal settings has no `SettingsShell` rail
  (flat 4-link subnav) → filter N/A there, and its four links need no filter.

### 3. Role gating — mirror the existing workspace-admin check, hidden not disabled
Workspace-section palette entries are gated behind the same inline check the existing
`jump:workspace-settings` uses (`(user?.workspace_role ?? -1) >= WORKSPACE_ADMIN_ROLE`)
and are *hidden* (not shown-disabled) for non-admins — no permission-wall dead end,
consistent with #2298. Personal-section entries are ungated. The pre-existing
`jump:trash` inconsistency (pushed unconditionally, yet `/settings/trash` requires
admin) is fixed by **gating the cold `jump:trash` behind the same admin check** — it
keeps its dedicated `/settings/trash` full-page route and its cold visibility for
admins. The generated Settings section group therefore **omits `trash`** to avoid a
duplicate row (trash is represented by the cold jump, not the `#trash` landing
anchor). Client gate is render-only; the `RequireWorkspaceAdmin` route wrapper
remains authoritative.

### 4. Palette group — new query-only `settings` group
Section entries join a **new** `settings` command group (not the cold-visible `jump`
group), added to `QUERY_ONLY_GROUPS` so they surface only once the user types — the
cold palette is not flooded with ~20 section rows. The three existing top-level jumps
stay cold-visible in `jump`. This follows the ADR-0508 precedent (the `sprintTask`
group was added the same way). `GROUP_LABEL['settings'] = 'Settings'`; slotted in
`GROUP_ORDER` immediately after `jump`.

### 5. Filter interaction — filter-in-place, not a typeahead dropdown
The rail filter is a text `<input>` at the top of the desktop rail (between the
scope/context block and the scrolling `<nav>`). Typing narrows visible nav items by
`label + keywords` (case-insensitive substring, matching the palette's
`filterCommandItems` model); non-matching items and now-empty groups are hidden.
Enter or click on a match runs the existing `handleSectionNav(id)` (scroll-spy, no
route change). Empty result shows "No matching setting". Clearing restores the full
rail. This preserves the existing rail mental model (a scrollable section list) rather
than introducing a competing dropdown. Mobile keeps its native `<select>` jump
affordance unchanged (already a findability shortcut; native selects aren't usefully
filterable).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| New unified cross-scope `settingsCatalog.ts` consumed by rail + palette | Single source across all scopes | Large refactor; 3 shells + flat personal have different shapes/lifecycles; no user-visible gain (chosen: extend existing nav builders) |
| Index project/program sections in palette now | Complete coverage | Needs current entity id + methodology gating; scope-context complexity; deferred to follow-up |
| Section entries in cold-visible `jump` group | Simpler (no new group) | Floods empty palette with ~20 rows; rejected — made query-only `settings` group |
| Rail filter as typeahead dropdown | Familiar combobox | Competes with the scroll-spy list mental model and with ⌘K itself; rejected for in-place filter |
| Match rail filter on `label` only (no keywords) | No new field | Weaker matchability ("SMTP" wouldn't find "Email & SMTP"); chosen to add `keywords` shared with the palette |

## Consequences
- **Easier:** finding any setting by name/synonym from ⌘K or in-rail; keywords are
  authored once and reused by both surfaces; the `jump:trash` gating bug is fixed.
- **Harder:** every new settings section now benefits from (but does not require)
  `keywords`; authors should add them. Workspace palette entries depend on
  `buildWorkspaceNavGroups({ linked: true })` returning `to` anchors — a contract to
  keep.
- **Risks:** (a) cold-palette regression if the `settings` group is not correctly in
  `QUERY_ONLY_GROUPS` — covered by a vitest asserting the group is absent on empty
  query; (b) e2e route-glob / catch-all mock interactions on `/settings` navigation —
  covered by mocking the sections a page reads (per repo rule); (c) mobile rail has no
  filter — intentional, documented.

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: **web only**
- Migration required: no
- API changes: no (both features consume existing routes/nav metadata; no endpoint,
  serializer, or permission change)
- OSS or Enterprise: **OSS** (single-workspace findability; no cross-program aggregation)
- New web rule(s) to add to `packages/web/CLAUDE.md`: (1) new settings sections should
  carry `keywords` on their `SettingsNavItem`; (2) workspace palette section entries
  derive from `buildWorkspaceNavGroups({ linked: true })` — keep its `to` anchors intact.

### Durable Execution
1. Broker-down behaviour: **N/A** — purely client-side navigation/filtering; no
   server dispatch, no async side effect.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — no backend path; consumes existing read routes only.
5. API response on best-effort dispatch: **N/A** — no API call introduced.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: **N/A** — navigation and in-memory filtering are naturally idempotent
   and stateless (no persisted effect).
8. Dead-letter / failure handling: **N/A** — no task; a bad section id simply scrolls
   to nothing and the filter shows the empty state.
