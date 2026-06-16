# ADR-0139: Customize Views — Per-User Nav Visibility

> ⚠️ **ADR number may race.** At authoring time the highest committed ADR was 0138
> (command-palette v2), with a known duplicate-0135 pair on main. If another branch
> claims 0139 before this merges, renumber this file (and the issue/MR references) to
> the next free number at merge time. See the repo's known duplicate-number pattern
> (#918).

## Status
Accepted

## Context

The v2 grouped view bar (ADR-0128, hosted in the unified shell bar ADR-0134) renders
every methodology-appropriate view tab — for a HYBRID project that is up to ten tabs
(Overview, Backlog, Sprints, Schedule, Grid, Calendar, Board, Risks, Reports, Team).
The methodology preset (ADR-0041, `HIDDEN_FOR_METHODOLOGY` /
`isTabVisibleForMethodology`) already suppresses the views that don't fit a project's
delivery style, but it cannot account for **how an individual works**: a PO lives in
Backlog/Sprints/Board and never opens Schedule or Calendar; a construction PM lives in
Schedule and never opens the board. Issue #220 asks for user-configurable tab
visibility to declutter the nav so each person sees only the views their workflow uses.

**P3M layer:** Operations / Programs-and-Projects. This is a single-user cosmetic
preference, not cross-project aggregation or governance. **OSS** (enterprise-check
confirmed). The deferred admin-lock variant (a workspace/PMO admin force-hiding views
for all members) is policy-enforced inheritance — **Enterprise** — and this ADR must
leave a stable seam for it without implementing it.

**VoC** (panel avg 5.5/10 overall; ~6.6 among the daily-driver target cohort
Sarah/Jordan/Alex/Morgan/Priya; no hard-NO on the feature itself). The decisive finding:
per-project customization (storing a separate hidden-set per project) is a configuration
**tax** 6 of 8 personas said they would refuse to pay — "if I have to redo it on every
project, I won't bother." A global per-user preference (configure once, applies
everywhere) is the near-unanimous preference; an explicit global-vs-per-project settings
toggle was called over-engineering by nearly everyone, including the one persona (Marcus)
who wanted per-project. The key architectural unlock: **the methodology preset already
differentiates projects automatically** (a waterfall project hides Sprints; an agile
project hides Schedule), so a global personal layer composed on top of the per-project
methodology baseline captures most of the per-project value for free.

This ADR is scoped to **show/hide only, desktop/web only, for 0.3**. Tab reordering
(#220's original drag-to-reorder AC) is deferred to 0.7; mobile tab-bar customization is
a separate follow-up; role/methodology smart defaults are a separate OSS follow-up.

## Decision

Add a per-user, **global** hidden-views preference, composed on top of the existing
per-project methodology baseline, surfaced through a "Customize views" dropdown in the
shell.

### 1. Storage — `UserProfile.hidden_views` (no new model)

Extend the existing `UserProfile` model (ADR-0129) with one additive field:

```python
hidden_views = models.JSONField(default=list, blank=True)
# A flat list of canonical view-key strings the user has chosen to hide from
# their own nav, applied across every project. Layers on top of the methodology
# preset (ADR-0041): the effective hidden set for a project is the methodology
# default UNION this personal set. Unset/empty = methodology default only.
```

`UserProfile` is deliberately **not** a `VersionedModel` (no `server_version`, never
synced, never broadcast) — `hidden_views` inherits that: it is a personal app
preference, not a board-scoped collaborative entity. Migration: additive
`0002_userprofile_hidden_views`, `default=list` (no data backfill, no NOT-NULL risk).

**Why global, not per-project:** VoC. A per-project map (`{project_id: [...]}`) is the
configuration tax the panel rejected. The methodology baseline already gives per-project
differentiation; the personal layer is the small "also hide the 2–3 I never touch"
delta, which is stable across a user's projects.

### 2. Server-side view-key vocabulary (new source of truth)

The canonical view keys live only in the web package today (`methodologyTabs.ts`). Per
API-first, introduce a server-side constant so the API validates the vocabulary and
MCP/API clients can enumerate valid values:

```python
# profiles/constants.py
HIDEABLE_VIEW_KEYS: frozenset[str] = frozenset({
    "product-backlog", "sprints", "schedule", "grid", "calendar",
    "board", "risk", "reports", "resources",
})
# Note: "overview" and "settings" are intentionally absent — Overview is the
# always-on landing (ADR-0030) and cannot be hidden; settings is an admin surface
# not shown as a hideable nav tab.
```

This is the canonical "at least one view always remains" enforcement: `overview` is
never hideable, so the nav can never be emptied. We therefore do **not** need a
separate "minimum one visible" runtime check — the always-on Overview guarantees it
structurally, which is simpler and not methodology-dependent.

### 3. API contract — extend the existing profile endpoints

No new endpoints. Extend `UserProfileSerializer` (used by `MyProfileView`,
`GET`/`PATCH /api/v1/auth/me/profile/`) and surface the value on `GET /api/v1/auth/me/`:

- `UserProfileSerializer.fields` += `hidden_views` as
  `ListField(child=CharField(max_length=32), max_length=32)` (bounds list length and
  element length against the DoS-via-error-string pattern called out in
  `ProgramRollupConfigSerializer`).
- `validate_hidden_views`: reject any key not in `HIDEABLE_VIEW_KEYS` (clear error
  naming the unknown keys, matching `validate_enabled_kpis`), de-duplicate while
  preserving order. Unknown/`overview`/`settings` → 400.
- `MeSerializer` gains a `hidden_views` `SerializerMethodField` (memoized, mirroring the
  existing `_default_landing` pattern) so the web reads it from the same `/auth/me/`
  call with no extra request.
- **"Reset to default" is not a new endpoint** — it is `PATCH .../profile/ {"hidden_views": []}`.
  Clearing the personal layer reverts to the methodology baseline. The web labels the
  action with the project's methodology ("Reset to Hybrid default") for clarity, but the
  server stores only the empty list (global), since the methodology default is computed
  per project client-side.

### 4. Composition in the web nav (the layering seam)

`methodologyTabs.ts` gains a pure helper that composes the personal set on top of the
methodology filter (the existing `groupedVisibleViews` is unchanged, so its tests and
all other callers are unaffected):

```ts
export function groupedVisibleViewsForUser(
  methodology: Methodology,
  hiddenViews: ReadonlySet<string>,
): VisibleViewGroup[] {
  return groupedVisibleViews(methodology)
    .map((g) => ({ ...g, visibleViews: g.visibleViews.filter((v) => !hiddenViews.has(v)) }))
    .filter((g) => g.visibleViews.length > 0);
}
```

`ViewTabs.tsx` reads `hiddenViews` from `useCurrentUser()` and calls
`groupedVisibleViewsForUser` before its existing role-gate filter. `overview` is
rendered from `STANDALONE_LEADING` outside the groups and is never filtered by the
personal set, guaranteeing a non-empty nav. **`BottomNav` (mobile) does NOT apply the
personal set in 0.3** — mobile customization is deferred; the personal set is a
desktop-only concern this milestone.

**Deep-link safety:** hiding a view only removes its nav tab. Routes are unchanged, so a
direct URL or shared deep link to a hidden view still renders normally (no 404, no
permission error) — confirmed against the routing layer, which is independent of nav
composition.

### 5. "Customize views" dropdown (the control)

A new shell dropdown (hand-rolled, following the `UserMenu.tsx` pattern — the repo has
no Radix/headless primitive). Mounted in the `TopBar` right cluster (pinned, never
scrolls off behind the tab strip) just before `HealthCluster`. Panel uses
`role="menu"` with one `role="menuitemcheckbox" aria-checked` row per hideable view,
grouped under the existing section labels, plus a footer "Reset to {methodology}
default" action. Toggling a row PATCHes the profile (optimistic local state seeded from
server, reverted on error — the established `MyGeneralPreferencesPage` pattern) and
invalidates `['current-user']`. The same controls also appear as a section in
`MyGeneralPreferencesPage` (`/me/settings/general`) for discoverability.

### 6. Hidden views stay reachable via ⌘K

`useCommandItems` reads the user's `hidden_views` and, when on a project route, emits a
jump item per hidden view ("Go to {label} — {project}") so hidden views are never
stranded. This requires exporting the tab label/icon metadata (`TAB_META`) from
`ViewTabs.tsx` (or hoisting it to `methodologyTabs.ts` as `VIEW_TAB_META`) so the
palette can label them.

### 7. Deferred enterprise-pin seam (designed, not built)

The web computes the effective hidden set through a single composition function
(`groupedVisibleViewsForUser`). A future Enterprise layer that force-hides/pins views
for all members will register an additional override source that composes at this same
seam, **plus a visible disclosure indicator** ("hidden by your workspace admin") — never
a silent lockout (Morgan's hard-NO). 0.3 ships only the personal source and leaves the
composition point as the stable extension seam; no override field, no lock, no disclosure
UI is implemented now.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **B — Per-user global (chosen)** | VoC near-unanimous; one JSON field on existing model; methodology baseline gives per-project differentiation for free; simplest API | A user with genuinely divergent projects can't vary nav per project (rare; mitigated by methodology baseline) |
| A — Per-user, per-project (`{project_id: [...]}`) | Marcus/Morgan's multi-methodology contexts get exact control | VoC rejected: configuration tax 6/8 personas won't pay; larger JSON, per-project key hygiene, more UI state |
| C — Global default + per-project override toggle | Maximum flexibility | VoC called it over-engineering (incl. Marcus); doubles model + UI surface for a setting users won't touch; a settings inheritance system for a cosmetic feature |
| New `UserPreference` model (per #220's original suggestion) | Clean namespace | Duplicates `UserProfile` (ADR-0129) which already exists for exactly this purpose; two preference tables to reason about |
| Client-only (localStorage) | No backend change | Fails #220 AC "survives reload / not localStorage"; doesn't sync across devices; not API-first (MCP can't read it) |

## Consequences

**Easier:**
- Declutter is one toggle, persisted server-side, applied everywhere — Priya/Jordan/Alex
  configure once.
- API-first: `hidden_views` is a first-class server fact on `/auth/me/`, readable by
  MCP/mobile, not stranded in client storage.
- The composition function is the single seam for the future Enterprise pin layer.

**Harder / risks:**
- `TAB_META` must be exported/hoisted so the palette can label hidden views — a small
  refactor touching `ViewTabs.tsx` and `useCommandItems`.
- All existing `ViewTabs`/`useCommandItems` vitest specs must add a `useCurrentUser`
  mock returning `hidden_views: []`; the e2e `/auth/me/` fixture
  (`e2e/fixtures/api-mocks.ts`) must return `hidden_views: []` so existing nav-tab
  assertions stay stable. This is the primary regression surface.
- The server view-key vocabulary (`HIDEABLE_VIEW_KEYS`) is now a second place that must
  be updated when a new view is added (web `VIEW_GROUPS` + server constant). Accepted
  cost for API-first validation; documented in both files.
- Global scope means a user who later wants per-project variance is not served until the
  0.7 reorder/per-project work — explicitly deferred, acceptable per VoC.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations (single-user preference).
- **Affected packages:** api (profiles model+serializer+constants, access MeSerializer),
  web (methodologyTabs, ViewTabs, TopBar, useCurrentUser, new useUpdateHiddenViews hook,
  ViewsMenu component, MyGeneralPreferencesPage section, command palette).
- **Migration required:** yes — `profiles/0002_userprofile_hidden_views`, additive,
  `default=list`, no backfill.
- **API changes:** yes — additive `hidden_views` on `UserProfileSerializer` (PATCH) and
  `MeSerializer` (read). No new endpoints.
- **OSS or Enterprise:** OSS. Admin force-hide/pin is the deferred Enterprise variant;
  this ADR leaves the composition seam + planned disclosure indicator for it.

### Durable Execution
1. **Broker-down behaviour:** N/A — `PATCH /auth/me/profile/` is a synchronous DB write
   with zero async side effects (no Celery task, no WebSocket broadcast). It is a
   personal preference, not a board-scoped mutation, so `broadcast_board_event()` does
   not apply.
2. **Drain task:** N/A — no async work dispatched.
3. **Orphan window:** N/A — no `transaction.on_commit()` callback; the write is the whole
   operation.
4. **Service layer:** Reuses the existing `profiles` serializer `update()` path
   (targeted `save(update_fields=["hidden_views"])`). No new service function needed.
5. **API response:** Synchronous — `PATCH` returns the updated profile representation
   (200), not a `{"queued": true}` envelope. No best-effort dispatch involved.
6. **Outbox cleanup:** N/A — no outbox rows created.
7. **Idempotency:** Naturally idempotent — `hidden_views` is a full-list PATCH (the
   client sends the complete desired set, not a delta), so re-applying the same request
   yields the same state. No idempotency key required.
8. **Dead-letter / failure handling:** N/A — synchronous request/response. On validation
   failure the API returns 400 with the offending keys; the web reverts its optimistic
   local state (existing `MyGeneralPreferencesPage` error pattern).
