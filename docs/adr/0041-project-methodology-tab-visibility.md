# ADR-0041: Project Methodology Preset — Tab Visibility for Waterfall / Agile / Hybrid

## Status
Accepted (2026-04-30) — implemented in #233.

## Context

With the Sprints tab shipping in wave/10 (issues #227–#229), the project workspace will
expose nine tabs: Overview · Board · Sprints · Schedule · WBS · Table · Calendar · Team · Risks.

This creates two problems that a simple user-configurable tab toggle (issue #220) does not
solve:

**Problem 1 — cognitive overload at onboarding.** A construction PM (Sarah) opening a new
project should not see Board + Sprints tabs she will never use. A software Scrum team (Alex)
should not see a Gantt / WBS tree they find unfamiliar and irrelevant.

**Problem 2 — conflicting mental models.** Schedule (Gantt) and Sprints both answer the
question "what's the plan?", but in incompatible vocabularies. Time-boxing (sprint cadence)
and CPM sequencing (early start / float / critical path) are valid approaches to the same
problem space, not views of the same underlying data. Displaying both without context implies
they are interchangeable, which misleads new users and confuses onboarding.

These problems call for a **project-level preset** that communicates which planning model the
project uses, and hides the irrelevant tabs by default. A raw visibility toggle (issue #220)
is flexible but provides no guidance; a methodology preset is opinionated and learnable in
30 seconds at project creation.

A VoC panel review (2026-04-29) confirmed the framing: Sarah (PM) and Marcus (PMO) work
primarily in Gantt/WBS; Alex (Scrum Master) and Priya (Team Member) work primarily in
Board/Sprints. Neither group benefits from seeing both tab sets simultaneously, and both
groups benefit from a clean default that matches their practice.

## Decision

### 1. Add `Project.methodology` with three values

A new field `methodology` is added to the `Project` model:

```python
class Methodology(models.TextChoices):
    WATERFALL = "WATERFALL", "Waterfall"
    AGILE     = "AGILE",     "Agile"
    HYBRID    = "HYBRID",    "Hybrid"

methodology = models.CharField(
    max_length=16,
    choices=Methodology.choices,
    default=Methodology.HYBRID,
)
```

Default is `HYBRID` so that existing projects and any project created without an explicit
choice see all tabs — no behaviour change for current users.

### 2. Tab visibility is controlled by the preset — API surface is unchanged

The methodology preset controls **tab visibility only**. The API surface is not affected:

- All endpoints remain available regardless of `methodology` value.
- A user who navigates directly to `/projects/:id/schedule` on an AGILE project will see
  the Schedule view. The preset hides the tab; it does not gate the route.
- This avoids coupling routing logic to a project setting and keeps the API surface stable
  for API consumers and integrations.

Rationale: hiding a tab communicates "this is not how we work here"; blocking the route
would communicate "this is not allowed". The former is the right message for a methodology
choice. Power users who know what they want can always reach a view by URL.

### 3. Default tab visibility matrix

`ViewTabs.tsx` and `BottomNav.tsx` filter the `TABS` array based on `project.methodology`.
Tabs marked ❌ are omitted from the rendered array; the DOM element does not exist (not
`display:none`).

| Tab | WATERFALL | AGILE | HYBRID |
|---|---|---|---|
| Overview | ✅ | ✅ | ✅ |
| Board | ✅ | ✅ | ✅ |
| Sprints | ❌ | ✅ | ✅ |
| Schedule | ✅ | ❌ | ✅ |
| WBS | ✅ | ❌ | ✅ |
| Table | ✅ | ✅ | ✅ |
| Calendar | ✅ | ❌ | ✅ |
| Team | ✅ | ✅ | ✅ |
| Risks | ✅ | ✅ | ✅ |

Design rationale for the non-obvious omissions:

- **Sprints hidden for WATERFALL** — sprint cadence is meaningless in phase-gate scheduling.
  Showing the tab implies TruePPM expects the team to run sprints.
- **Schedule + WBS hidden for AGILE** — CPM critical-path analysis and hierarchical work
  breakdown are waterfall-origin concepts. Agile teams plan via backlog ordering, not
  decomposition trees. Velocity-feeds-CPM (ADR-0036) handles the bridge to milestone
  forecasting without exposing the Gantt to the agile team.
- **Calendar hidden for AGILE** — sprint cadence already provides the time-boxing a
  calendar would add. Milestone-based calendar view adds noise, not signal, for a team
  whose delivery unit is the sprint.
- **Board always visible for WATERFALL** — even phase-gate teams use a status board.
  Board is universal; Sprints is agile-specific.

### 4. Per-user overrides stack on top

Issue #220 (user-configurable tab order and visibility) remains planned and is not
superseded by this ADR. The layering is:

```
Final visible tabs = methodology_defaults ∩ user_overrides
```

A WATERFALL project hides Sprints by default; a user who enables Sprints via #220 sees it.
A user who hides Overview on a HYBRID project still doesn't see it. The methodology preset
sets the floor; user overrides adjust from there.

### 5. Methodology picker in project creation and settings

- **Project creation wizard**: a 3-option selector (radio or segmented control) with a
  one-sentence description for each:
  - **Waterfall** — "Phase-gate scheduling with Gantt, WBS, and critical path"
  - **Agile** — "Sprint-based delivery with Board, velocity, and burndown"
  - **Hybrid** — "Both scheduling models — all views available (default)"
- **Project settings page**: the same selector, editable post-creation. Changing the
  methodology takes effect immediately without a page reload (the `ViewTabs` component
  re-reads the project query cache, which is updated via the PATCH response).

### 6. API change: `methodology` field on Project serializer

The `ProjectSerializer` exposes `methodology` as a read-write field. This is the only
API surface change:

```
GET  /api/v1/projects/:id/          → includes "methodology": "HYBRID"
PATCH /api/v1/projects/:id/         → accepts "methodology": "WATERFALL" | "AGILE" | "HYBRID"
```

The field is included in the OpenAPI schema. No other endpoints change.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Methodology preset (chosen)** | Opinionated; learnable at creation; encodes planning model semantics | Requires model field + migration |
| Per-user tab toggle only (issue #220) | Maximum flexibility | No onboarding guidance; doesn't solve "two plans" confusion |
| Route-level gating by methodology | Enforces the model boundary strictly | Wrong semantics (methodology is a preference, not a permission); breaks direct URL navigation; API consumers affected |
| Feature flags per tab (booleans on Project) | Most granular | 9 booleans to configure; no semantic grouping; no onboarding narrative |
| Client-side only (no DB field) | No migration | Cannot be used in project listing, templates, or future org-level defaults |

## Consequences

**Easier:**
- New users pick their planning model at creation and see a focused, relevant tab set
  immediately — reducing time-to-value for both waterfall and agile practitioners
- The "which tab do I use?" onboarding question is answered by the methodology choice,
  not by reading documentation
- The OSS/Enterprise boundary is clean: the 3-value preset is OSS; Enterprise can register
  additional methodology values (e.g. `CCPM`, `EVM_ONLY`) via the slot registry (ADR-0029)
  or set an org-level default methodology for all new projects

**Harder:**
- One new migration required (`Project.methodology`, non-nullable with default `HYBRID`)
- `ViewTabs.tsx` and `BottomNav.tsx` must read from the project query cache and filter
  `TABS` accordingly — a small coupling between the nav and the project data model
- The `HYBRID` default means existing users see no change, but new agile-only users who
  forget to set the picker get all 9 tabs until they change it

**Risks:**
- Users may choose WATERFALL or AGILE and then realise mid-project they need a hidden tab.
  Mitigate by making the methodology selector visible and easy to change in project settings,
  and by surfacing a "You're missing a tab? Change your project methodology →" prompt the
  first time a user navigates directly to a hidden view's URL.
- Three-value taxonomy may be too coarse for some hybrid teams (e.g. "we use Gantt for
  the programme level but sprints for delivery teams within a phase"). Accept this for now;
  the `HYBRID` option covers it, and per-user overrides (issue #220) handle edge cases.

## Implementation Notes

- **P3M layer:** Programs/Projects (single-project setting) → OSS
- **Affected packages:**
  - `packages/api`: `Project` model + migration, `ProjectSerializer` field, `ProjectViewSet`
  - `packages/web`: `ViewTabs.tsx`, `BottomNav.tsx` (filter `TABS` by methodology),
    project creation wizard, project settings page
- **Migration required:** Yes — add `methodology VARCHAR(16) NOT NULL DEFAULT 'HYBRID'`
- **API changes:** `methodology` field on `ProjectSerializer` (read-write); OpenAPI schema
  must be regenerated
- **OSS boundary:** `methodology` field and 3-value enum live in OSS. Enterprise additional
  values and org-level defaults are registered via ADR-0029 slot registry.
- **Durable execution:** N/A
- **Issue:** #233
