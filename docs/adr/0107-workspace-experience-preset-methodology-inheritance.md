# ADR-0107: Workspace Experience Preset — Methodology Inheritance and the Enforce Extension Point

## Status
Proposed

## Context

TruePPM's adoption wedge is "easier than MS Project": an agile-only team should not be
drowned in waterfall chrome (Gantt / WBS / critical-path), and a waterfall team should
not be drowned in sprint chrome. Issue #955 framed this as a new "per-workspace
experience preset (Agile / Waterfall / Hybrid)" subsystem.

Architecture research showed that **most of this already exists or is already designed** —
so this ADR is a *reconciliation and extension*, not a new subsystem:

- **ADR-0041 (Accepted, shipped #233)** already gives every `Project` a `methodology`
  field (`WATERFALL | AGILE | HYBRID`, default `HYBRID`) that hides tabs by DOM-removal:
  `WATERFALL` hides Sprints; `AGILE` hides Schedule + Calendar (and WBS); `HYBRID` hides
  nothing. Tab hiding is a **preference, not a permission** — routes are never gated, the
  API surface is unchanged, and **CPM always runs underneath** regardless of methodology.
  This *is* the per-project experience preset, in production today.
- **ADR-0087(b) (Accepted)** establishes the `Workspace` singleton, which already carries
  `default_project_view` — direct precedent for a workspace-level default that seeds new
  projects. `PATCH /api/v1/workspace/` is gated on `IsWorkspaceAdmin`
  (`WorkspaceRole.ADMIN = 300`).
- The workspace-level inheritance **UI is already built as stubs**: `WorkspaceMethodologyPage`
  (web, shipped via #510) and `ProjectMethodologyPage` (#511) already mock the
  "Inherit / Suggest / Enforce" override-policy picker and the three method cards — they
  are wrapped in `<StubFieldset disabled>` with `<StubPageBanner>` and are not wired to
  any model or serializer.
- The `Methodology` enum already lives on both `Project` and `Program`.

**The decisive consequence for scope and milestone:** because per-project methodology
already ships, an agile design-partner team can *today* set their project to `AGILE` and
never see the Gantt. A **workspace-level default** is therefore a *convenience* (set once;
new projects inherit) — it does **not** convert a blocking objection. Epic #883 (the 0.3
agile-cohort cut) admits an issue only if it "converts a blocking objection," so this work
does not belong in the frozen 0.3 cut. It is correctly milestoned **0.4**.

### P3M layer
Programs and Projects (single project/workspace configuration) → **OSS**. This is per-team
adoption configuration, not cross-program governance. The org-wide *enforcement* of a
preset is a Portfolio-layer governance concern → **Enterprise** (trueppm-enterprise#144).

### VoC signal (panel avg 5.9/10; agile trio Jordan/Alex/Morgan 8/8/8)
The sub-6 average is dragged entirely by the portfolio layer (Marcus 3 🔴 / Janet 4 /
David 4) asking for *enforcement + audit*, which is correctly the Enterprise carve-out.
The OSS-relevant personas (PO + SM + Coach) scored it the strongest possible adoption
signal. Constraints folded into this design: bundle behavior not just chrome; team-readable
audit; RBAC on change; no PM-y vocabulary leaks; CPM substrate stays live and visible.

## Decision

Reuse the existing `Methodology` concept — **do not introduce a parallel `ExperiencePreset`
type**. "Experience preset" *is* `methodology` plus a workspace-level default and an
inheritance resolution. Concretely:

### 1. Workspace-level default + override policy (additive fields on the singleton)
Add to `Workspace` (app `workspace`):
- `default_methodology` — `CharField(choices=Methodology.choices, default=Methodology.HYBRID)`.
  The site-wide default a new project inherits.
- `methodology_override_policy` — `CharField(choices=MethodologyOverridePolicy.choices,
  default=SUGGEST)`. **OSS honors `INHERIT` and `SUGGEST` only.** `ENFORCE` is the
  extension point (see §4).

`MethodologyOverridePolicy` (new `TextChoices`, pinned in `ENUM_NAME_OVERRIDES`):
- `INHERIT = "inherit"` — projects always use the workspace default; the per-project
  picker is read-only (shows "Inherited from workspace"). A project may still be changed
  by raising no barrier beyond role — i.e. INHERIT sets the default and hides the override
  affordance but does **not** lock (locking is ENFORCE).
- `SUGGEST = "suggest"` — workspace default pre-fills new projects; a project ADMIN may
  override per project. (Default — preserves today's behavior where each project owns its
  methodology.)
- `ENFORCE = "enforce"` — workspace default is mandatory; project override is blocked.
  **OSS treats `ENFORCE` as `SUGGEST`** (no-op enforcement) unless an enforcement provider
  is registered (§4).

### 2. Server-computed `effective_methodology`
Add a read-only `effective_methodology` field to `ProjectSerializer`, resolved server-side:

```
effective_methodology(project) =
    workspace.default_methodology              if policy == INHERIT
    workspace.default_methodology              if policy == ENFORCE and enforcement active
    project.methodology                        otherwise (SUGGEST, or ENFORCE inactive)
```

This is the **single source of truth** consumed by both web and (future) mobile. The
frontend tab-gate (`methodologyTabs.ts` / `ViewTabs.tsx`) switches from reading
`project.methodology` to reading `effective_methodology` — a transparent change, since the
field already drives tab visibility. `project.methodology` remains the stored per-project
override; `effective_methodology` is the resolved value.

### 3. Wire the existing stub pages
Wire `WorkspaceMethodologyPage` (#510) and `ProjectMethodologyPage` (#511) to the API:
- Workspace page → `default_methodology` + `methodology_override_policy` via the existing
  `useWorkspaceSettings` / `useUpdateWorkspaceSettings` hooks and the `useDirtyForm`
  save-bar contract. Remove the stub banner/fieldset.
- Project page → shows "Inherited from workspace (<value>)" when policy is `INHERIT`/active
  `ENFORCE` (picker read-only); editable override when `SUGGEST`.
- The `ENFORCE` card renders an `<EnterpriseBadge />` in Community edition (self-gating per
  ADR-0029) — selectable in UI but documented as no-op without Enterprise.

### 4. The Enforce extension point (enterprise#144 registers here)
OSS defines the full `MethodologyOverridePolicy` enum (including `ENFORCE`) and a backend
enforcement provider hook following the established registry pattern (ADR-0029 / ADR-0049
`integrations/registry.py` / `workflows/registry.py`):

- A new `METHODOLOGY_ENFORCEMENT_PROVIDER` registry slot (default: `None` in OSS).
- When policy is `ENFORCE` and a provider is registered, the provider (a) makes
  `effective_methodology` resolve to the workspace default and (b) rejects a project-level
  `methodology` PATCH with `403`. With no provider (OSS), `ENFORCE` degrades to `SUGGEST`
  and the project PATCH is allowed.
- Frontend: the existing `SlotId` registry; no OSS core changes required for enterprise to
  add an "config-drift" surface.

This keeps the Apache-2.0 boundary one-way: OSS ships the enum + the empty hook; Enterprise
registers the enforcer + the audit/drift report. Renaming the policy enum or the registry
slot is a breaking change for enterprise.

### 5. Audit trail (team-readable)
`Workspace` has no `HistoricalRecords` today. Add `HistoricalRecords` to `Workspace` so
changes to `default_methodology` / `methodology_override_policy` (who/when/old→new) are
recorded and surfaced via the existing `history_record_created` signal (which enterprise
already consumes for unlimited retention). Per-project `methodology` changes are already
audited via `Project.history`. Write `history_change_reason` at the workspace write site to
classify the source.

### 6. Surface-hiding stays frontend-only (per ADR-0036 / ADR-0041)
No endpoint is disabled and no route is gated. The data (schedule/CPM, resource allocation)
always exists and is always computed. Resource-allocation data is **never** hidden from the
resource-manager cross-project view (David's guarantee) — that view does not consult
`effective_methodology`. Velocity stays first-class in `AGILE` and is **not** a hideable
leaf surface.

### Out of scope (deliberately deferred)
- **Independent leaf-feature toggles** (turn reporting / time-tracking / baselines /
  Monte-Carlo surface on/off independently of methodology) — no persona asked for it;
  methodology already hides the heavy chrome. Filed as a separate follow-up issue.
- **Org-wide enforcement + config-drift audit** — Enterprise (trueppm-enterprise#144).
- **Mobile UI** — no mobile package exists yet; this ADR only guarantees the API contract
  (`effective_methodology` on the Project payload) the 0.4 mobile app will consume.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Reuse `Methodology` + workspace default + `effective_methodology` resolution (chosen)** | Builds on shipped ADR-0041; wires existing stubs; one additive migration on a singleton; one transparent frontend swap; clean enterprise seam | Requires an inheritance resolver and a serializer computed field; `ENFORCE`-as-no-op in OSS needs clear docs |
| B. New `ExperiencePreset` model/enum separate from `methodology` | "Clean" conceptual name matching the issue title | Two parallel concepts for the same three values; duplicates the tab-gate logic; orphans ADR-0041; migration + drf-spectacular churn for zero user benefit |
| C. Per-surface JSON `surface_overrides` on Project (the "framework") | Maximally flexible; future surfaces need no migration | Depends on the unbuilt #645 schema_version registry; less type-safe; solves a problem no persona has; far heavier than the wedge needs |
| D. Pull a thin slice into 0.3 under #883 | Agile design-partner gets workspace-default-Agile sooner | Per-project methodology already serves the wedge today, so this converts no blocking objection — fails #883's own admission bar; crowds a frozen milestone |

## Consequences

- **Easier:** Setting an org default once (new projects inherit); the agile wedge is
  reinforced without per-project setup; enterprise can add enforcement without touching OSS
  core; one source of truth (`effective_methodology`) for web + mobile.
- **Harder:** A second input now feeds tab visibility (workspace default + per-project
  override) — the resolver must be the only place inheritance is computed, or the two can
  drift. Tests must cover all (policy × override) combinations.
- **Risks:**
  - `ENFORCE`-as-no-op in Community could confuse self-hosters → mitigate with the
    `EnterpriseBadge` on the card and explicit admin-docs copy.
  - Adding `HistoricalRecords` to `Workspace` is a migration that creates a historical
    table — must use `makemigrations` (never hand-write — per project convention for
    historical models).
  - `Methodology` is currently **not** pinned in `ENUM_NAME_OVERRIDES`; adding the new
    `MethodologyOverridePolicy` enum (and a third use of `Methodology` on `Workspace`) can
    trigger the drf-spectacular enum-name-collision / schema-drift regression — pin both
    `MethodologyEnum` and `MethodologyOverridePolicyEnum` proactively.

## Implementation Notes
- **P3M layer:** Programs and Projects → OSS.
- **Affected packages:** api (Workspace fields, ProjectSerializer computed field, resolver,
  enforcement registry hook, migration), web (wire #510/#511 stub pages, swap tab-gate to
  `effective_methodology`).
- **Migration required:** yes — `workspace` app (next number `0005`): add
  `default_methodology`, `methodology_override_policy`, and `HistoricalRecords` table.
  No collision risk at `workspace/0005` (projects-app churn is at 0057/0058).
- **API changes:** yes — `WorkspaceSettingsSerializer` gains two writable fields;
  `ProjectSerializer` gains read-only `effective_methodology`; project `methodology` PATCH
  may return `403` when an enforcement provider is active.
- **OSS or Enterprise:** OSS. Enterprise (trueppm-enterprise#144) registers the enforcement
  provider + config-drift audit against the OSS hook.

### Durable Execution
1. **Broker-down behaviour:** N/A — preset changes are synchronous singleton/row writes
   with no async side effect. No outbox row is needed. (CPM recompute is unchanged and
   already goes through `scheduling/services.py::enqueue_recalculate()` on schedule edits,
   not on methodology changes — changing a tab's visibility does not alter schedule data.)
2. **Drain task:** N/A — no async work introduced.
3. **Orphan window:** N/A.
4. **Service layer:** No new dispatch path. Methodology resolution is a pure synchronous
   function (`resolve_effective_methodology(project)`); the enforcement check is a synchronous
   registry lookup in the serializer/permission layer.
5. **API response:** Synchronous — `PATCH /api/v1/workspace/` and project PATCH return the
   updated resource (200), not `{"queued": true}`.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** Writes are naturally idempotent (PATCH sets a field to a value; repeating
   the same PATCH yields the same state). The historical-record write is keyed off the actual
   row change, so a no-op PATCH records no spurious history.
8. **Dead-letter / failure handling:** N/A — synchronous request/response; a failed write
   returns 4xx/5xx to the caller with no background retry.
