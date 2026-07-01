# ADR-0193: Independent Leaf-Surface Visibility Toggles (reporting / time-tracking / baselines / Monte-Carlo)

## Status
Proposed

## Context

ADR-0107 (workspace experience presets, issue #955) made `effective_methodology`
the single source of truth for **heavy-chrome** tab visibility: AGILE hides
Schedule/Calendar, WATERFALL hides Sprints/Backlog. In its "Out of scope" section
(lines 136-139) it explicitly deferred **independent leaf-surface toggles** —
turning reporting / time-tracking / baselines / the Monte-Carlo surface on or off
*independently* of the methodology preset — because no VoC persona asked for it.
Issue #956 is that deferred follow-up, to be built "only if a real ask
materializes."

The design must answer two questions ADR-0107 left open: **how the visibility is
stored**, and **how four heterogeneous surfaces are gated coherently**. Research
against the current code surfaced the load-bearing fact: **the four "surfaces" do
not share a gating mechanism.**

| Surface | What it is today | How it is gated today |
|---|---|---|
| `reporting` | The `reports` **view tab** (`viewMeta.ts`, in `HIDEABLE_VIEW_KEYS`) | Tab filter (`methodologyTabs.ts`) — cleanly hideable |
| `baselines` | Sub-surface **inside** the Schedule view (ghost bars, `BaselineSection`, legend swatch) | **Data presence** (`has_baseline`) — no toggle exists |
| `monte-carlo` | Sub-surface inside Schedule (`ScheduleForecastBar`, rule 189) | **Role** (`>= MEMBER`) — no toggle exists |
| `time-tracking` | **No web surface exists** — API (`apps/timetracking`) + mobile (`Time` tab) only | Nothing to gate on web today |

So one of four is a view tab; two render inside Schedule gated by data/role; one
has no web surface at all. A naive "add four tab-filter entries" design is wrong.

**P3M layer:** Programs and Projects (per-project preference). **OSS** — a PM
configuring their own project's surfaces; no cross-program or governance concern.

## Decision

### 1. Storage — four explicit nullable boolean columns on `Project` (not JSON)

Add `show_reporting`, `show_time_tracking`, `show_baselines`, `show_monte_carlo`
as `BooleanField(null=True, blank=True)` on `Project`, following the ADR-0135 /
`sharing_settings.py` tri-state precedent (`public_sharing`, `allow_guests`,
`attachments_enabled`, `mc_history_enabled` are all declared this way). `null` =
"inherit the methodology default"; `True`/`False` = explicit override.

The `surface_overrides` JSONField alternative is **rejected** — it was already
rejected as Alternative C in ADR-0107 ("depends on the unbuilt #645
`schema_version` registry; less type-safe; far heavier than the wedge needs"), and
per ADR-0086 a new user-state JSONField without a registered `schema_version`
surface is a blocking finding. Four booleans is the type-safe, migration-cheap,
audit-free (`HistoricalRecords`) shape.

### 2. Seeding — a methodology → surface-defaults map (two-level resolution)

Unlike sharing (which inherits project → program → workspace), #956 seeds the
**default** from the methodology preset, not a parent scope. A new resolver module
`apps/projects/surface_visibility.py` holds:

```python
SURFACE_KEYS = ("reporting", "time_tracking", "baselines", "monte_carlo")

# Methodology default when a project leaves the override NULL. Overridable per
# project; these are floors, not ceilings (OSS never clamps — ADR-0135 §5).
METHODOLOGY_SURFACE_DEFAULTS = {
    Methodology.WATERFALL: {"reporting": True, "time_tracking": True,
                            "baselines": True,  "monte_carlo": True},
    Methodology.AGILE:     {"reporting": True, "time_tracking": True,
                            "baselines": False, "monte_carlo": False},
    Methodology.HYBRID:    {"reporting": True, "time_tracking": True,
                            "baselines": True,  "monte_carlo": True},
}
```

Rationale for the AGILE defaults-off: baselines and Monte-Carlo are CPM/schedule
artifacts an Agile team rarely surfaces; this matches the issue's own example ("an
Agile preset could default the Monte-Carlo surface off"). Reporting and
time-tracking default on everywhere (universally useful).

Resolution is two-level, computed-on-read (ADR-0108 — no denormalized column):

```
effective(surface) = project.show_<surface>
                     if project.show_<surface> is not None
                     else METHODOLOGY_SURFACE_DEFAULTS[effective_methodology][surface]
```

`effective_methodology` is already server-resolved (ADR-0107); this resolver
consumes it, so the workspace/program methodology-override policy flows through for
free.

### 3. Serializer contract — server owns resolution; clients read it

On `ProjectDetailSerializer`:

- Four **raw writable** nullable fields: `show_reporting`, `show_time_tracking`,
  `show_baselines`, `show_monte_carlo` (`null` = inherit).
- One **read-only** `effective_surface_visibility` `SerializerMethodField` →
  `{"reporting": bool, "time_tracking": bool, "baselines": bool, "monte_carlo": bool}`
  (the resolved values every client renders against).
- One **read-only** `inherited_surface_visibility` `SerializerMethodField` → the
  `METHODOLOGY_SURFACE_DEFAULTS[effective_methodology]` map — i.e. "what you'd get
  if you cleared the override," which feeds the settings "Inherit (On/Off)"
  affordance (`InheritableToggleField`'s `inherited` prop).

Clients (web, **mobile**, MCP) never re-implement the methodology→default map —
API-first: visibility is a server-computed value, not client domain logic.

### 4. Write gate — ADMIN-only, seeded/read by all

The four raw fields join the existing ADMIN-only set enforced in
`ProjectSerializer.validate()` (403 for `role < ADMIN`). Lower roles receive the
same read payload and render read-only inherited indicators (server-derived
gating, ADR-0133). No ENFORCE lock is needed — this is a per-project preference,
not a cross-scope policy, so there is no Enterprise enforcement seam to register
(unlike sharing/methodology).

### 5. Web gating — one resolution path, per-surface consumers

A thin `useSurfaceVisibility(projectId)` hook reads
`useProject().effective_surface_visibility` (default all-`true` until loaded) — no
recomputation. Consumers:

- **reporting** → thread into the tab filter: when `!visibility.reporting`, add
  `'reports'` to the effective hidden set alongside the methodology hidden set and
  the per-user `hidden_views` set (ADR-0139). One composed hide-union.
- **baselines** → `visibility.baselines` gates the drawer **`BaselineSection`**
  (the "baseline vs current comparison" — the unambiguous stored-baseline *feature*
  surface). The section owns the gate via `useSurfaceVisibility(projectId)` (it
  already receives `projectId`; the registry `canRender` context carries only
  `{ user, task }`, so an internal gate is cleaner than threading project data into
  the ctx). **Explicitly NOT gated:** the canvas actual-date/variance overlay
  (`drawActualDateBar`) and its "Planned baseline" legend swatch. Despite the legend
  label, that dashed overlay is the **execution-progress actuals** affordance
  (actual vs planned dates), not the stored-baseline snapshot the toggle governs —
  gating it would require an engine-API `showBaseline` setter for a surface the
  toggle does not conceptually own. It stays always-on; the pre-existing legend
  mislabel is out of scope for #956.
- **monte-carlo** → `visibility.monte_carlo` is AND-ed into the existing
  `ScheduleForecastBar` render condition (role gate stays).
- **time-tracking** → **web has no surface to gate today**; the server field is
  live and honored by the mobile `Time` tab. The web gate is deferred until a web
  time-entry surface ships (0.4 time-entry web work, #926/#1258). Building a web
  gate now would gate nothing (dead code) — explicitly out of scope for this MR,
  not forgotten.

### 6. Settings UI — one `<SettingsSection>` (ADR-0146)

A `surface-visibility` section on the consolidated project settings page (scroll-spy
IA, ADR-0146) with four `InheritableToggleField`s, one `useDirtyForm({ sectionId })`,
and the legacy-redirect stub. Below ADMIN the toggles render read-only with the
inherited provenance.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. 4 nullable boolean columns + methodology-default map (chosen)** | Type-safe; migration-cheap; matches ADR-0135 precedent; free `HistoricalRecords` audit; no JSON registry dependency | 4 columns; a future 5th surface needs a migration (acceptable — surfaces are rare) |
| B. `surface_overrides` JSONField + `schema_version` | No migration per new surface | Rejected in ADR-0107 Alt C; depends on unbuilt #645 registry; ADR-0086 blocking finding; less type-safe; solves a problem no persona has |
| C. Extend per-user `hidden_views` (ADR-0139) to carry these | Reuses existing vocabulary | Wrong scope — #956 is **per-project, methodology-seeded**; `hidden_views` is per-user global and VoC-rejected per-project as a "configuration tax" |
| D. Route/endpoint gating | — | Violates "hide don't gate" (ADR-0041 §2); data must stay computed and URL-reachable |

## Consequences

- **Easier:** a project ADMIN can turn off surfaces their team never uses, seeded
  sensibly by methodology; mobile honors the same server contract with zero extra
  work; the resolver is a 15-line pure function trivially unit-tested.
- **Harder:** the Schedule view now reads one more visibility input for its
  baseline/MC sub-surfaces (threaded, not scattered — single hook).
- **Risks:** (a) toggling a surface off must never disable its endpoint — E2E must
  prove the URL still renders the data (ADR-0041). (b) The methodology-default map
  is a product decision; AGILE-off-by-default for baselines/MC could surprise — it
  is a *default*, fully overridable, and documented. (c) Empty-nav guard: reporting
  is not Overview, so hiding it can never empty the nav (Overview always remains).

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (model + resolver + serializer + migration), web (hook +
  tab filter + Schedule gates + settings section), docs
- Migration required: **yes** — one migration, 4 nullable booleans, no backfill
  (`null` = inherit is the correct default for every existing row)
- API changes: yes — 4 writable nullable fields + 2 read-only computed fields on
  `ProjectDetailSerializer`; OpenAPI regenerated
- OSS or Enterprise: **OSS** (`trueppm/trueppm-suite`)
- MR shape: **one cohesive MR** — the API contract plus the three web gates that
  have a real surface (reporting tab, baselines, Monte-Carlo). Splitting API from
  its web consumer would ship settings toggles that visibly do nothing. Alpha/first-
  beta latitude (large cohesive MR) applies. The time-tracking web gate is a
  documented follow-up, not part of this MR.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure synchronous DB write of preference
   booleans; no async side effects, no task dispatch.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no `on_commit` dispatch.
4. Service layer: **N/A** — resolution is a pure function
   (`surface_visibility.resolve_effective_visibility`); no enqueue path.
5. API response on best-effort dispatch: **N/A** — standard synchronous
   `PATCH /projects/{id}/` 200 with the updated serializer payload.
6. Outbox cleanup: **N/A** — no outbox row.
7. Idempotency: writing the same boolean is naturally idempotent (last-write-wins
   on the column); no duplicate-execution concern.
8. Dead-letter / failure handling: **N/A** — a failed PATCH returns 4xx/5xx to the
   caller synchronously; nothing to retry out of band.
