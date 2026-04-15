# ADR-0029: Frontend Slot Registry and Edition Detection

## Status
Proposed

## Context

TruePPM is an open-core product. The OSS shell (`packages/web`) must remain fully functional
and Apache 2.0-clean. The Enterprise overlay (`trueppm-enterprise`) needs to inject additional
routes, nav sections, KPI slots, and dashboard widgets into the shared shell without:

1. Forking the shell or maintaining a patched copy
2. Introducing any `import from 'trueppm_enterprise'` in the OSS codebase
3. Requiring runtime feature-flag checks scattered throughout OSS components

The existing backend extension pattern (Django signals — ADR-0010, ADR-0011, ADR-0013)
provides a clean precedent: OSS defines named extension points; Enterprise registers receivers
at startup. This ADR brings the same model to the React frontend.

The VoC, UX Review, and UX Design reviews of the P3M UI proposal (docs/ux/p3m-vs-oss-views.html,
2026-04-14) identified this as a **pre-implementation blocker**: "Building enterprise widgets before
the extension mechanism is defined guarantees a rewrite."

No existing ADR covers frontend plugin hooks, slot registry, or cross-repo widget injection.
ADR-0012 (`MC_SIMULATION_CAP`) is the only precedent for edition-aware behaviour, and it uses
a Django settings variable, not a frontend mechanism.

## Decision

Implement a typed **slot registry** in `packages/web/src/lib/widget-registry.ts` as the single
extension boundary between OSS and Enterprise frontend code.

### Slot registry design

```typescript
// packages/web/src/lib/widget-registry.ts  (OSS, Apache 2.0)

export type SlotId =
  | 'project_overview.kpi_row'       // additional KPI cards right of the 4 OSS cards
  | 'project_overview.hero_right'    // replaces/extends the "Needs attention" panel
  | 'project_overview.below_hero'    // rows injected below the hero row
  | 'nav.portfolio_section'          // nav rail section above the project switcher
  | 'top_bar.context'                // items to the right of the project name chip
  | 'routes'                         // additional React Router routes (path + element)

export interface SlotRegistration<T = React.ComponentType<unknown>> {
  id: string          // stable unique key for the registration
  component: T
  priority: number    // lower = rendered first
}

class WidgetRegistry {
  private slots = new Map<SlotId, SlotRegistration[]>()

  register(slot: SlotId, reg: SlotRegistration): void {
    const existing = this.slots.get(slot) ?? []
    this.slots.set(slot, [...existing, reg].sort((a, b) => a.priority - b.priority))
  }

  get(slot: SlotId): SlotRegistration[] {
    return this.slots.get(slot) ?? []
  }
}

export const registry = new WidgetRegistry()
```

The registry is a plain singleton — no React context, no build-time magic. Enterprise code
imports and calls `registry.register(...)` once, in its own entry point, before the React
tree mounts.

### OSS shell renders slots

OSS components render registered slot components alongside (or instead of) their defaults:

```tsx
// Example: project overview additional KPI cards
{registry.get('project_overview.kpi_row').map(({ id, component: C }) => (
  <C key={id} projectId={projectId} />
))}
```

Empty slots produce no output. No conditional `if (edition === 'enterprise')` checks appear
in OSS code.

### Edition detection

OSS needs to know the running edition to make one routing decision (landing page — see ADR-0030).
This is the only place edition is checked in OSS, and it must not import enterprise code.

**New endpoint:** `GET /api/v1/edition/` — public, no auth required, response is not sensitive.

```json
{ "edition": "community" }   // or "enterprise"
```

Django setting: `TRUEPPM_EDITION = os.environ.get("TRUEPPM_EDITION", "community")`

Frontend: a single `useEdition()` hook reads this endpoint (cached, refetch-on-window-focus
disabled). The hook result is used only in the root router to decide the landing redirect.

The backend `TRUEPPM_EDITION` variable is set to `"enterprise"` by the enterprise Helm chart.

### Enterprise registration entry point

Enterprise ships `packages/enterprise-web/src/index.ts`:

```typescript
// trueppm-enterprise repo — NOT in trueppm/trueppm
import { registry } from '@trueppm/web/lib/widget-registry'
import { PortfolioNavSection } from './features/portfolio/PortfolioNavSection'
import { PortfolioRoute } from './features/portfolio/PortfolioRoute'
// ... other widgets

registry.register('nav.portfolio_section', {
  id: 'enterprise.portfolio_nav',
  component: PortfolioNavSection,
  priority: 10,
})
registry.register('routes', {
  id: 'enterprise.portfolio_route',
  component: PortfolioRoute,  // renders at /portfolios/:id
  priority: 10,
})
// ... other registrations
```

The OSS app entry point (`main.tsx`) conditionally imports this file only when the enterprise
package is installed:

```typescript
// main.tsx (OSS)
try {
  // This import resolves only when trueppm-enterprise is installed as a workspace package.
  // If the package is absent, the dynamic import fails silently — OSS runs unchanged.
  await import('@trueppm/enterprise-web')
} catch {
  // Community edition — no enterprise widgets registered
}
```

This keeps OSS source clean: there is no static `import from 'trueppm_enterprise'`, and the
`grep -r "trueppm_enterprise" packages/` check continues to pass.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Slot registry (chosen)** | Clean OSS boundary; typed; testable; mirrors Django signal pattern | Requires enterprise to ship a companion `packages/enterprise-web/` package |
| Build-time conditional compilation (env flag sets which chunks are included) | No runtime dynamic import | Requires two separate builds; cannot ship a single image that activates on license detection |
| React context / provider injection (enterprise wraps the OSS app in providers) | Flexible | Requires enterprise to own the app entry point — forks the shell |
| URL-based feature flags (query params) | Simple to demo | Not a security boundary; leaks enterprise routes to OSS users |
| CSS-class toggling (show/hide enterprise elements) | No code change needed | Enterprise DOM ships to all users; violates Apache 2.0 clean boundary |

## Consequences

**Easier:**
- Enterprise widgets are fully isolated in the enterprise repo
- OSS ships and runs with zero enterprise code present
- New enterprise slots can be added without touching OSS code (add a new `SlotId` value)
- The extension mechanism is inspectable: `registry.get(slot)` at runtime shows what is registered

**Harder:**
- Enterprise must ship a `packages/enterprise-web/` companion package and keep it in sync
  with the OSS slot contract (SlotId enum is the API surface — changes are breaking)
- Dynamic import in `main.tsx` is slightly unusual; developers must understand why it exists
- Each slot component receives props defined by the OSS slot contract — enterprise components
  cannot read arbitrary OSS state without going through props or their own data hooks

**Risks:**
- If the enterprise package fails to load (corrupt install, version mismatch), the OSS shell
  continues but enterprise features are silently absent. Mitigation: add a startup log warning
  when the dynamic import fails.
- Slot contract is a public API. Any rename of a `SlotId` is a breaking change for enterprise.
  Treat `SlotId` additions as additive/non-breaking; treat renames/removals as major-version bumps.

## Implementation Notes

- **P3M layer:** Programs and Projects (OSS shell) + Portfolios (Enterprise registration)
- **Affected packages:** `packages/web` (OSS — registry + slot rendering + edition endpoint + `useEdition` hook), `packages/api` (OSS — `/api/v1/edition/` endpoint), `trueppm-enterprise:packages/enterprise-web` (Enterprise — registration)
- **Migration required:** No
- **API changes:** Yes — new `GET /api/v1/edition/` endpoint (no auth, read-only, returns `{"edition": "community"|"enterprise"}`)
- **OSS or Enterprise:** Registry and edition endpoint are OSS. Registration code is Enterprise.
- **Durable execution:** N/A (no async dispatch)
- **Breaking change surface:** `SlotId` enum in `widget-registry.ts` is a public contract between the two repos. Document in `packages/web/CHANGELOG.md` whenever a slot is added, renamed, or removed.
- **OSS boundary verification:** `grep -r "trueppm_enterprise" packages/` must return zero. The dynamic import in `main.tsx` uses the npm package name `@trueppm/enterprise-web`, not a source path — passes the check.
