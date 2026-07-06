# ADR-0266: Object-first design methodology (OOUX spine + DX/OX as first-class surfaces)

## Status
Accepted (methodology ADR — establishes a design practice; no code or schema change). #1676.

## Context
TruePPM's product thesis is *one object, many role-native lenses*: a single `Task`
is Priya's Jira-synced checklist item, Sarah's critical-path node, and Alex's
sprint-container item — the **same** server object projected through different views.
The Apache-2.0 boundary, API-first contract, and 5-role RBAC already force a shared
object model server-side; the design practice had not, until now, been named to match it.

Two gaps motivated this ADR, surfaced while kicking off the Shell Redesign v2 family
(#1640/#1642–#1645):

1. **No stated object-first discipline.** Screen-first design lets the same object drift
   into incompatible per-view mental models. The shell redesign moves view tabs into a
   3-tier rail (You / This project / Jump), which is exactly an object→lens map — but we
   had no rule saying "design the objects and their relationships first, then derive the
   lenses," so each sub-issue risked re-deciding the object model locally.
2. **Non-visual interfaces are not treated as design artifacts.** For the integration/API
   developer persona (Nadia) the interface *is* the OpenAPI error shape, pagination, and
   webhook contract; for the self-hosting operator (Omar) it is `values.yaml` and the
   Helm failure modes. A confusing 400 payload or an undocumented Helm value is a broken
   button for those personas, but our design gates (`ux-design`, `ux-review`, `brand`)
   only covered pixels.

### Considered and rejected: a new branded "Ecosystem-Centered Design" framework
An external suggestion proposed coining **Ecosystem-Centered Design (ECD)** with three
pillars — OOUX, DX/OX, and "Agent-Oriented Constraints (AOC)." We reject the branding:

- **AOC is architecture we already enforce server-side, not a design pillar.** The
  `_provenance` envelope (`stamp_answer`), the `project_scope` floor, and ADR-0112 agent
  behavioral bounds live in the API/serializer layer *precisely so* a design-system
  component can never forget to apply them — a machine actor never touches the component
  library. Agent safety is owned by the `ai-review` gate and stays there. Moving it into
  "design" would invite exactly the edge-application bug that server-side enforcement exists
  to prevent.
- **A new capitalized framework adds a vocabulary tax without a method.** The useful
  content reduces to two practices (object-first IA; DX/OX as design deliverables) plus one
  already-owned invariant (server-side agent safety). We adopt the practices under existing
  vocabulary rather than a new acronym.

We also reject the framing that "classic HCD is structurally incomplete." Competent
human-centered / service design already handles multiple actor types and API consumers;
the failure mode is a *naive* application that seeks one homogeneous UI. This ADR names the
discipline that prevents the naive application — it does not replace HCD.

## Decision

### 1. OOUX is the design spine (IA layer), above the Design System v2 visual layer
Before proposing screens for any new user-visible feature, `ux-design` states the **object
model first**: the core objects the feature touches (`Task`, `Sprint`, `Program`,
`Allocation`, `Milestone`, …), their relationships, and the **per-persona lens** each object
is viewed through. Screens are derived from that map; they never introduce a new mental
model for an object that already has one elsewhere in the product.

- This sits **above**, not instead of, ADR-0126 (Design System v2). OOUX governs *which
  objects appear and how they relate across views*; DS-v2 governs *tokens, color, and
  component shape*. A screen must satisfy both.
- The object model is anchored to the **server** object (API-first): a lens is a projection
  of a first-class server fact, never a client-only invention. This keeps OOUX aligned with
  the `ai-review` "every value is a server fact" gate — an object an MCP client can't reach
  is a design smell, not just an architecture one.

### 2. DX and OX are first-class design surfaces with named artifacts
- **DX (integration/API developer):** error shapes, rate-limit responses, and pagination
  contracts are design deliverables held to the same bar as a web-form validation message.
  Owned jointly by `api-design` / `api-docs`; a breaking change to an error shape is a design
  change, not just a code change.
- **OX (self-hosting operator):** the Helm chart and its `values.yaml` are the operator's
  onboarding flow. Undocumented values, silent-failure defaults, and unversioned config are
  UX defects. Owned by `devops` / `docs` (administration).
- Neither adds a new agent; each *scopes existing gates* to treat these contracts as UX.

### 3. Agent safety stays server-side (unchanged)
No change. Agent-facing invariants remain enforced in the API/serializer layer and gated by
`ai-review`. This ADR explicitly declines to duplicate them into the design system.

## Consequences
- `ux-design` output for a new feature opens with an object→lens map before wireframes
  (an added expectation on the existing skill, not a new gate).
- The OSS/Enterprise *surfacing* rule derived from the object-first lens lands as
  `packages/web/CLAUDE.md` **rule 231**, resolved by a **daily-path-vs-seam classifier**:
  231 governs daily-path surfaces (shell, rail, nav, workspace) — empty extension-point slots,
  no ambient upsell; **seam surfaces** (Settings → Roles & permissions, org-identity/governance
  settings, the `/programs`→portfolio boundary) may carry a single contextual affordance, so
  rule 121's `EnterpriseBadge` stays there (231 and 121 are the same principle on two surface
  types). The one shipped correction — converting the rail's disabled "Portfolio rollup" row
  (rule 178 / `Sidebar.tsx`) to an empty `nav.portfolio_section` slot, with discovery at the
  `/programs` seam — is the scoped follow-up tracked in **#1677**.
- DX/OX contracts (error shapes, Helm values) become review-blocking design artifacts, not
  post-hoc documentation.
- No migration, no API change, no code change ships with this ADR itself.
