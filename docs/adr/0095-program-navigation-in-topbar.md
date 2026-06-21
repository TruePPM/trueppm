# ADR-0095: Program navigation moves to the global TopBar

## Status
Accepted (2026-05-27) — amends the navigation decision of ADR-0070. Resolves #790.

## Context

P3M layer: **Programs and Projects (OSS)**. Apache-2.0 boundary unaffected — `Program`
remains an OSS entity (ADR-0070); this is a frontend navigation change only.

Project navigation lives in the global `TopBar`: `ViewTabs` (Overview · Board · Sprints ·
Schedule · Grid · Calendar · Team · Risks · Reports · **Settings**) renders inside the
constant-height top bar, gated on `:projectId`. "Settings" is a first-class project
view-tab, so a project's settings is discoverable and renders with no layout shift.

Program navigation was different: `ProgramShell` rendered, **in-content** below the top
bar, a program header (name + a ⋯ Delete menu) and a secondary tab strip (Overview ·
Backlog · Projects · Members) — per ADR-0070. There was **no Settings tab**, so program
settings was reachable only via the settings SCOPE switcher (#776), and the in-content
strip caused a ~100px vertical jump on the settings route (worked around in #776 by
suppressing the program chrome on `/settings/*`). The net effect: projects keep their
tabs (incl. Settings) in settings; programs showed nothing — an inconsistency, and
program settings had no discoverable entry point (#790).

## Decision

Move program navigation into the global `TopBar`, mirroring projects.

1. **New `ProgramTabs` component** (the program analog of `ViewTabs`) renders inside the
   `TopBar`, `h-full`, gated on `useProgramId()` (new hook mirroring `useProjectId`).
   Tabs: **Overview · Backlog · Projects · Members · Settings** — Settings is new and
   last, matching projects. Active state is the path segment after `:programId`; the
   Settings tab stays active across every `/programs/:id/settings/*` sub-route.
2. **`ViewTabs` and `ProgramTabs` are mutually exclusive.** Each returns `null` when its
   id is absent; a URL is either `/projects/:id/*` or `/programs/:id/*`, never both, so
   exactly one strip renders. The TopBar renders both unconditionally.
3. **`ProgramShell` becomes minimal** — like `ProjectShell`: just a full-height `<Outlet>`
   wrapper, no header and no in-content tab strip. The program name shows in the left
   sidebar and in each view's own content; program **delete** lives at Settings →
   Archive/Close (the header ⋯ menu is removed, no capability lost).
4. **No role gating on the program tabs** — all five are always visible; writes are gated
   inside each page (same model as the project Settings tab).
5. **Mobile** parity (`BottomNav`) is a deferred follow-up; `ProgramTabs` is `hidden md:flex`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| A. `ProgramTabs` in TopBar (chosen) | Symmetric with projects; constant height (no jump); Settings discoverable; minimal shell | One merge overlap with the in-flight #776 branch in `ProgramShell.tsx` |
| B. Keep tabs in `ProgramShell`, just add a Settings tab | Smaller diff | Reintroduces the in-content strip above settings → the #776 jump returns; still asymmetric |
| C. Generalize `ViewTabs` for both scopes | One component | Overloads a project-specific component with program branching; muddier than two small siblings |

## Consequences
- **Easier**: program navigation is consistent with projects; program settings is reachable from a tab; the `ProgramShell` settings-route suppression hack from #776 becomes unnecessary (the eventual merge drops it).
- **Harder**: two tab components to keep visually in sync (both follow web-rule 38).
- **Risks**: `ProgramShell.tsx` overlaps the unmerged #776 branch (MR !407). Resolution on merge is always "take the minimal `ProgramShell`". Recommended order: land !407 first, then rebase this branch.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: web
- Migration required: no
- API changes: no
- OSS or Enterprise: OSS

### Durable Execution
1. Broker-down behaviour: **N/A** — pure frontend navigation, no async dispatch.
2. Drain task: N/A.
3. Orphan window: N/A.
4. Service layer: N/A — no server work.
5. API response on best-effort dispatch: N/A.
6. Outbox cleanup: N/A.
7. Idempotency: N/A — navigation is a client-side route change.
8. Dead-letter / failure handling: N/A.
