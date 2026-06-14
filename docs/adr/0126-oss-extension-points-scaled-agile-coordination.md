# ADR-0126: OSS Extension Points for a Scaled-Agile Coordination Layer

## Status

Accepted (2026-06-14) — the four blocking design questions below are resolved.

> **Numbering caveat (confirm at merge):** `0124` is claimed by an unmerged
> branch (the blocker end-to-end wave) and `0125` by the unmerged REST-over-GraphQL
> branch; neither is on `main` yet. `0123` is the highest number currently on `main`.
> This ADR takes `0126` to sit above both in-flight claims, but the numbering scheme
> already has nine reused numbers — **verify the next free number and renumber this
> file if it collides at merge.**

## Context

**P3M layer:** This ADR defines seams that span the **Programs/Projects** layer (OSS)
and the **Portfolio** layer (Enterprise). The seams themselves are OSS; everything
that consumes them across teams is Enterprise.

A 2026-06-14 methodology-neutrality review (persona panel: agile coach, delivery
lead, PMO director) surfaced a "scaled-agile coordination" gap: larger organizations
that coordinate **multiple teams under one shared cadence** have no first-class
representation for it. A follow-up boundary classification (`enterprise-check`)
split the requested capability into three sub-constructs:

| Sub-construct | Classification | Rationale |
|---|---|---|
| (a) Multi-iteration planning window, **single team** | OSS-basic | A team planning several of its own iterations toward a date is table-stakes; may already be served by milestones + iterations + the throughput forecast (#1161). |
| (a′) The same window **shared/synchronized across teams** | Enterprise | Cross-team coordination crosses the program boundary. |
| (b) Cross-team delivery group (stable grouping of multiple teams toward a common goal) | Enterprise | "Cross-team" is by definition coordination across the OSS program unit. |
| (c) Value-stream grouping (organizing delivery groups by flow of value) | Enterprise | Portfolio-level taxonomy aggregating across delivery groups. |
| Portfolio delivery rollup | Enterprise | Portfolio scope by definition. |

The OSS unit is the **Program** (related projects for one PM/team). The Enterprise
unit is the **Portfolio**. The boundary rules are non-negotiable:

- `trueppm-suite` MUST NEVER import `trueppm_enterprise` (one-way dependency:
  enterprise → core).
- Extension points must be **stable** — enterprise registers against them without
  OSS knowing; changing their shape is a breaking change for enterprise customers.
- The community edition must be **fully functional standalone**.

Therefore the enterprise coordination layer (a′, b, c, rollup) is **not** designed
here and **not** filed in the OSS tracker — it belongs in `trueppm-enterprise`. This
ADR scopes **only the OSS extension points** that enterprise will register against,
so that the cross-team layer can be built later without a single OSS change.

**Forces at play:**

- *Lock-in risk (from the panel's agile coach):* a prescriptive scaled construct
  risks baking one methodology's cadence/ceremony/terminology into the core. The
  OSS primitives must be **generic and structural** so the opinionated workflow
  lives entirely in Enterprise and is configurable.
- *Silent-breakage risk:* enterprise aggregates by reading OSS shapes (forecast,
  iteration, program, backlog). Today those shapes are incidental serializer output;
  if treated casually they can drift and break enterprise silently. They must be
  promoted to a declared, versioned contract.
- *Unwired frontend seams:* research found the ADR-0029 slot registry exists, but
  several of its consumer seams are **specified-but-unwired** in OSS (see Decision §3).

## Decision

Define and stabilize **three OSS extension points**. No new domain feature ships in
OSS as part of this ADR beyond the seams themselves (the single-team OSS-basic
planning window (a) is tracked separately and may need nothing — see Consequences).

### Extension Point 1 — Stable cross-team read contract

Promote the existing forecast / iteration / program / backlog read shapes to a
**declared, versioned read contract** that enterprise consumes to aggregate across
teams. No new endpoints; this freezes and documents what already exists.

Frozen shapes (all already present in `docs/api/openapi.json`):

- **Iteration read shape** — `GET /api/v1/projects/{id}/sprints/`,
  `GET /api/v1/sprints/{id}/` (`SprintSerializer`):
  `id, server_version, project, name, goal, start_date, finish_date,
  state (PLANNED|ACTIVE|COMPLETED|CANCELLED), target_milestone, capacity_points,
  wip_limit, goal_outcome (MET|PARTIAL|MISSED|null), exclude_from_velocity,
  committed_points, committed_task_count, completed_points, completed_task_count,
  completion_ratio_points, completion_ratio_tasks, pending_count, wip_count,
  activated_at, closed_at, …`
- **Forecast read shapes:**
  - `GET /api/v1/projects/{id}/velocity/` → `{sprints[], rolling_avg_points,
    rolling_stdev_points, forecast_range_low, forecast_range_high,
    rolling_avg_tasks, rolling_stdev_tasks, team_velocity_per_day, excluded_count}`
  - `GET /api/v1/projects/{id}/forecast/` → `{velocity:{…},
    remaining_committed_points, sprints_to_complete_low, sprints_to_complete_high,
    milestones:[{milestone_id, basis, cpm_finish, p50, p80, velocity_low,
    velocity_high, confidence, …}]}`
  - `GET /api/v1/projects/{id}/sprint-forecast/` → `{status (ready|warming_up),
    remaining_points, sample_count, p50_sprints, p80_sprints, p50_date, p80_date,
    basis, velocity_suppressed}` — to be extended by #1161 with a throughput basis
    discriminator; **the discriminator field is part of this contract.**
- **Program / backlog read shapes** — `GET /api/v1/programs/{id}/`,
  `GET /api/v1/programs/{id}/backlog-items/` (`ProgramSerializer`,
  `BacklogItemSerializer`): program identity + `BacklogItem{id, server_version,
  program, title, item_type, status, priority_rank, story_points, …}`.

**Stability mechanism:** these paths/shapes are declared a **stable read contract
tier**. The existing `api:schema-drift` CI check already detects shape changes; this
ADR adds the *policy* that a drift on any contract-tier path is a breaking change
requiring an enterprise-coordination note in the MR. A lightweight marker (a
`# stable-contract: enterprise` comment on the relevant serializers/`@action`s, plus
a checked-in `docs/api/stable-contract.md` allowlist) records membership in the tier.

**Contract version signal (decided — Q1):** OSS exposes a machine-checkable
`contract_version` integer on the existing `GET /api/v1/edition/` response (alongside
`edition`), bumped whenever a contract-tier shape changes incompatibly. Enterprise
reads it once at startup and refuses to run against an OSS whose `contract_version`
exceeds the maximum it understands — converting silent breakage into a loud,
detectable refusal. `server_version` remains a per-row sync counter and is explicitly
**not** the contract version. Privacy stays intact: the ADR-0104
velocity-suppression gate (`velocity_suppressed`, nulled bands) is part of the
contract — enterprise consumes already-gated values, it does not bypass the gate.

### Extension Point 2 — Group-membership registration hook (backend)

A backend seam by which enterprise attaches **generic group membership** onto OSS
`Program`/team entities, mirroring the established provider-registry idiom
(ADR-0049 `ProviderRegistry`; the single-provider `register_terminology_enforcement_provider` /
`register_default_posture_provider` pattern):

```python
# packages/api/src/trueppm_api/apps/projects/grouping.py   (OSS, Apache 2.0)
#
# Generic, structural grouping seam. OSS defines the hook and never imports
# enterprise. Enterprise registers a provider from its own AppConfig.ready().
# No OSS model holds an FK to an enterprise table.

from collections.abc import Callable

# A provider maps an OSS Program (by id) to opaque, generic group-membership
# records supplied by whatever edition is installed. OSS ships no provider →
# returns [] (community edition has no cross-team groups).
GroupMembershipProvider = Callable[[str], list["GroupMembership"]]

_PROVIDER: GroupMembershipProvider | None = None

def register_group_membership_provider(provider: GroupMembershipProvider | None) -> None:
    """Register (or clear) the cross-team group-membership provider. Enterprise calls this."""
    global _PROVIDER
    _PROVIDER = provider

def group_memberships_for(program_id: str) -> list["GroupMembership"]:
    """OSS-safe accessor. Returns [] when no provider is registered (community)."""
    return _PROVIDER(program_id) if _PROVIDER is not None else []
```

`GroupMembership` is a **generic structural record** (a frozen dataclass:
`group_id`, `group_kind` *(opaque string supplied by the provider — OSS assigns no
meaning)*, `member_ref`, `role` *(optional, opaque)*). OSS assigns **no** cadence,
ceremony, or methodology semantics to any field — that is the lock-in guard. The
direction of dependency is strictly enterprise → OSS: enterprise holds the
membership tables and FKs *to* OSS `Program`; OSS holds **no** reference to
enterprise.

### Extension Point 3 — Frontend nav/route/settings slot wiring

The portfolio delivery view is an enterprise-provided React surface that registers
into the OSS shell via the ADR-0029 `WidgetRegistry`. Research found the registry
class and `SlotId` type exist (`packages/web/src/lib/widget-registry.ts`) — including
`nav.portfolio_section` and `routes` — but the **consumer seams are not yet wired**:

- `main.tsx` lacks the `try { await import('@trueppm/enterprise-web') } catch {}`
  self-registration seam (ADR-0029 specified it; it is absent).
- `router.tsx` has no `registry.get('routes')` consumer.
- `Sidebar.tsx` has no `registry.get('nav.portfolio_section')` consumer.
- Settings nav injection has **no mechanism** — `SettingsShell` nav groups are
  hardcoded props (a gap already noted in `WorkspaceSettingsPage.tsx`).

**Decision (Q2):** these four generic, edition-agnostic seams are **split into a
dedicated ADR-0029-completion issue that #1162 depends on** — they benefit any
registered slot, not just the portfolio view, and deserve their own focused change +
tests. That issue **must conform to the current v2 (navy/sage) design system**: the
sidebar nav section, settings-nav injection, and any new shell affordance build
against current brand tokens and the redesigned shell (post sidebar-cleanup #959),
**not** the pre-rebrand layout — gated by `/brand` and `ux-review`. A portfolio
settings sub-page, if needed, requires a new `SlotId`
(e.g. `workspace_settings.nav_groups`) plus a consumer in the settings shell, added
in that same issue.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Define OSS extension points only (chosen)** | Preserves the one-way boundary; enterprise builds the coordination layer with zero OSS changes; generic primitives avoid methodology lock-in | Up-front seam work with no immediate OSS-user-visible feature; requires wiring the unfinished ADR-0029 consumers |
| B. Build the coordination constructs in OSS | Immediate capability | Cross-team/portfolio coordination is Enterprise by the boundary rules; would trip `boundary:check`; bakes methodology assumptions into core (lock-in) |
| C. Enterprise reads OSS via private/undeclared serializer internals | No OSS work now | Silent breakage — exactly the failure mode this ADR exists to prevent; not a contract |
| D. OSS model holds an FK / nullable column pointing at enterprise grouping | Simple join | Violates the one-way dependency; community edition carries dead enterprise scaffolding; rejected outright |

## Consequences

**Easier:**
- Enterprise can build the cross-team planning window, delivery group, value-stream
  grouping, and portfolio rollup entirely in its own repo against stable seams.
- Any future optional surface (not just portfolio) benefits from the now-wired
  ADR-0029 consumer seams.
- The single-team OSS-basic planning window (a) can be evaluated independently — it
  likely needs **no new model** (milestones + iterations + #1161 may already cover
  it); confirm before building anything.

**Harder / risks:**
- The stable read contract adds a maintenance constraint: contract-tier shapes can no
  longer be changed casually. Mitigated by the existing `api:schema-drift` check plus
  the new MR-note policy.
- EP3 depends on finishing the ADR-0029 wiring, which was assumed done but is not.
  This is a prerequisite, not a nice-to-have (blocking question Q2).
- Contract versioning is unsolved (Q1): the `server_version` field is a per-row sync
  counter, **not** an API contract version. A separate contract-version signal may be
  needed so enterprise can detect an incompatible OSS.

### Durable Execution

1. **Broker-down behaviour:** N/A — EP1 is read-only endpoints; EP2/EP3 are
   synchronous in-process registrations at app/module load. No async dispatch is
   introduced by these seams.
2. **Drain task:** N/A — no async work enqueued.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** EP2 adds `projects/grouping.py` (`register_group_membership_provider`,
   `group_memberships_for`); EP1 reuses existing `projects/services.py` forecast
   functions unchanged.
5. **API response on best-effort dispatch:** N/A — synchronous reads return `200`
   with the contract shape; no `202 {"queued":true}` paths.
6. **Outbox cleanup:** N/A — no outbox.
7. **Idempotency:** Registration calls are idempotent by construction —
   `register_*_provider` replaces the single provider slot; the frontend
   `registry.register(slot, {id})` is idempotent by `(slot, id)`. Re-registration
   (HMR, StrictMode double-invoke, app reload) is safe.
8. **Dead-letter / failure handling:** N/A — no tasks. A missing/throwing provider
   degrades to the community default (`group_memberships_for` → `[]`); the frontend
   dynamic-import seam swallows the absent-enterprise case in a `catch`.

## Implementation Notes

- **P3M layer:** Programs/Projects (OSS seams) enabling a Portfolio-layer (Enterprise)
  consumer.
- **Affected packages:** `api` (EP1 contract policy, EP2 grouping hook), `web`
  (EP3 slot-consumer wiring).
- **Migration required:** No. EP2 introduces no OSS model/table (membership lives in
  enterprise). EP1 freezes existing shapes. EP3 is frontend wiring.
- **API changes:** No new endpoints. EP1 declares existing endpoints contract-tier;
  the only additive field is the #1161 forecast `basis` discriminator (tracked in
  #1161, referenced here as part of the contract).
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). The coordination layer that
  consumes these seams is **Enterprise** (`trueppm-enterprise`) — file it there, not
  in the OSS tracker. The OSS `enterprise`/`portfolio` issue labels are **not** applied
  to #1162 (they trip `boundary:check`).

### Boundary-compliance verification

- `grep -r "trueppm_enterprise" packages/` MUST return zero results (CI `boundary:check`).
- No OSS model gains an FK or column referencing an enterprise table (EP2 keeps the
  dependency one-way: enterprise → OSS).
- `group_memberships_for()` and all `registry.get(slot)` consumers return a safe
  community default (`[]` / empty) with no enterprise package installed — the
  community edition stays fully functional standalone.

## Resolved decisions (2026-06-14)

- **Q1 — Contract versioning signal: RESOLVED → add `contract_version`.** OSS adds a
  machine-checkable `contract_version` integer to the `GET /api/v1/edition/` response;
  enterprise refuses to run against a higher version than it understands. Detailed in
  Extension Point 1. `server_version` stays a per-row sync counter, not the contract
  version.
- **Q2 — ADR-0029 wiring scope: RESOLVED → split into its own dependency issue.** The
  four unwired consumer seams (`main.tsx` import, `routes`, `nav.portfolio_section`,
  settings-nav injection) become a dedicated ADR-0029-completion issue that #1162
  depends on, **conforming to the v2 (navy/sage) design system** (`/brand` +
  `ux-review` gated). Detailed in Extension Point 3.
- **Q3 — Milestone: RESOLVED → 0.4.** #1162 and the EP3 split-out issue both target
  **0.4**.
- **Q4 — `group_kind` typing: RESOLVED → fully opaque.** OSS enforces **no**
  enum/validation on `group_kind`; the community edition treats all group kinds as
  opaque pass-through. This is the methodology-lock-in guard.
