# ADR-0072: Role Ordinals as an Enterprise Extension Point

## Status
Accepted (2026-05-31) — implemented in #508. First canonical RBAC contract ADR; supersedes the
ad-hoc Role-enum docstring in `apps/access/models.py` as the source of truth.

## Context

TruePPM's OSS edition ships exactly 5 named roles encoded as `Role(IntegerChoices)`
with sequential ordinals (`VIEWER=0`, `MEMBER=1`, `SCHEDULER=2`, `ADMIN=3`, `OWNER=4`).
Permission checks are scattered across `access/permissions.py`, `views.py`, and
sync/workshop consumers, and use a mix of `>= Role.X` (inequality / threshold),
`== Role.OWNER` (singular-tier equality), and a small number of raw integer
comparisons (`role < 1`).

Two forces pull on this design:

1. **Enterprise needs custom roles.** Marcus (PMO Director persona) cites custom-role
   support as an evaluation criterion. ADR-0037 explicitly flagged that inserting a new
   role between MEMBER and ADMIN would force an ordinal renumber and a breaking change
   across every `role >= X` comparison. ADR-0037 deferred this to "a v2 RBAC ADR."
   Custom roles themselves are Enterprise scope (CLAUDE.md Two-Repo Rule and
   `enterprise-check` classification on 2026-05-18).
2. **OSS adoption keeps adding consumers.** Every new mobile fixture, integration, and
   test that hardcodes a role literal raises the cost of any future renumber. Doing the
   renumber **now**, while the consumer surface is small, is materially cheaper than
   doing it after custom roles are actually built.

This ADR addresses force (1) by re-spacing the existing 5 OSS ordinals (`0/100/200/300/400`),
opening four 99-unit slot bands for Enterprise to register custom roles between OSS tiers
via the ADR-0029 slot-registration pattern. It addresses force (2) by doing the renumber
in 0.2 — before the consumer surface widens.

**P3M layer**: Programs and Projects / Operations (the role values themselves are
single-project-and-program scope; the extension point is cross-cutting infrastructure).

**Boundary classification** (`/enterprise-check` 2026-05-18): **OSS** — this is structural
plumbing analogous to ADR-0029 (slot registration) and ADR-0030 (edition-based routing).
The Enterprise consumer (custom roles) remains Enterprise scope and is not part of this
change.

## Decision

Re-space the OSS `Role` enum ordinals to `0/100/200/300/400` and formally establish the
**band-boundary contract** for permission checks. The OSS edition continues to ship the
same 5 named roles with identical user-visible behavior; this is pure plumbing.

### The band-boundary contract

OSS permission checks fall into three categories with different extension semantics:

| Check style | Example | Semantics | Custom role at 250 (Enterprise) |
|---|---|---|---|
| `role >= Role.X` (inequality) | `role >= Role.SCHEDULER` | "At least the X-band" — **extensible** | Passes (250 ≥ 200) — inherits scheduler-band capabilities |
| `role == Role.X` (singular-tier equality) | `role == Role.OWNER` | "Specifically the OSS X tier" — **NOT extensible** | Fails — custom role does not silently absorb OSS-specific equality matches |
| Raw integer literal (`role < 1`) | (none after this MR) | Ordinal-coupled — **fragile, prohibited** | Forbidden going forward |

**The contract is**: a custom Enterprise role registered at an intermediate ordinal
inherits inequality-based capabilities of its enclosing band, but does NOT inherit
behaviors gated by equality on a specific OSS tier. If Enterprise wants a custom role
to also match an OSS equality check, it must override that check via slot registration
(ADR-0029) — never by changing the OSS code.

### Ordinal layout and reserved slots

```
Ordinal | OSS Role        | Reserved band for Enterprise custom roles
--------|-----------------|------------------------------------------
0       | VIEWER          |
        |                 | 1–99   (4 OSS slots reserved between VIEWER and MEMBER)
100     | MEMBER          |
        |                 | 101–199  (Enterprise custom roles here inherit MEMBER-band)
200     | SCHEDULER       |
        |                 | 201–299  (Enterprise custom roles here inherit SCHEDULER-band)
300     | ADMIN           |
        |                 | 301–399  (Enterprise custom roles here inherit ADMIN-band)
400     | OWNER           |
        |                 | 401+     (RESERVED — no role above Owner; OSS contract)
```

**OSS reservations** (cannot be claimed by Enterprise custom roles):
- `0`, `100`, `200`, `300`, `400` exactly — these are OSS-tier identities
- `401+` — no role above Owner; this preserves the `== Role.OWNER` ceiling invariant

**Enterprise extension space**:
- `1–99` (between VIEWER and MEMBER) — for read-augmented roles (e.g., "Auditor" at 50)
- `101–199` (between MEMBER and SCHEDULER) — for contributor extensions (e.g., "Senior Team Member" at 150)
- `201–299` (between SCHEDULER and ADMIN) — for resource-management extensions (e.g., "Senior Scheduler" at 250)
- `301–399` (between ADMIN and OWNER) — for project-lead extensions (e.g., "Delivery Lead" at 350)

Why 100-unit gaps and not 10 or 1000:
- **100 is enough** — 4 custom-role slots per band is more than any real customer has
  asked for; a custom role taxonomy with > 4 tiers in one band is almost certainly
  a sign the band itself is wrong
- **100 is small enough** — fits comfortably in `SmallIntegerField` (max 32767),
  leaves DB-storage headroom unchanged, doesn't require schema changes
- **100 is human-readable** — `250` reads as "between 200 and 300" without needing
  to compute against a wider gap; aids debugging and grep

### Public API surface

The numeric `role` and `my_role` fields continue to be the wire format. The OpenAPI
`RoleEnum` regenerates from `[0,1,2,3,4]` to `[0,100,200,300,400]`. External consumers
that hardcoded `role == 3` or `role >= 3` will break — release notes call this out
prominently for the 0.2 release.

A textual `role_name` field ('VIEWER' / 'MEMBER' / 'SCHEDULER' / 'ADMIN' / 'OWNER') is
**proposed as a future-proofing direction but explicitly out of scope for #508**. Once
introduced, it will be the canonical API surface; the integer becomes an implementation
detail. Tracked as a follow-up issue, not this MR.

### Required code changes (in scope)

1. **`Role` enum** (`packages/api/src/trueppm_api/apps/access/models.py`) — values
   `0/1/2/3/4` → `0/100/200/300/400`, with a docstring pointing to this ADR
2. **Raw-integer comparisons** — two regressions MUST be converted to symbolic:
   - `apps/sync/consumers.py:65` — `role < 1` → `role < Role.MEMBER`
   - `apps/workshops/consumers.py:49` — `role < 1` → `role < Role.MEMBER`
3. **Equality and inequality checks against `Role.X`** — **no change** to comparison
   style. They are correct as-is under the contract above. The 6 `== Role.X` checks
   stay equality. The ~22 `>= Role.X` checks stay inequality. Django's
   `IntegerChoices` compares by value, so all symbolic comparisons just work.
4. **Data migration** — single Django migration `apps/access/migrations/0006_role_ordinal_spacing.py`
   that (a) `AlterField`s both `ProjectMembership.role` and `ProgramMembership.role`
   with the new choices, and (b) `RunPython` multiplies existing values by 100 in one
   atomic transaction. Reversible via integer division.
5. **Frontend shared module** — introduce `packages/web/src/lib/roles.ts` with named
   exports (`ROLE_VIEWER=0, ROLE_MEMBER=100, ROLE_SCHEDULER=200, ROLE_ADMIN=300, ROLE_OWNER=400`).
   Replace all 9+ local `OWNER_ROLE = 4` / `SCHEDULER_ROLE = 2` literal constants
   (audited in `MembersTab.tsx`, `MemberRow.tsx`, `ProgramMembersTab.tsx`,
   `ProgramMemberRow.tsx`, `ResourceView.tsx`, `ViewTabs.tsx`, `BottomNav.tsx`,
   `TaskFormModal/index.tsx`, `EstimatesSection.tsx`).
6. **`RolePicker.tsx`** — `ROLES` array value literals updated to `0/100/200/300/400`.
7. **OpenAPI regen** — `docs/api/openapi.json` `RoleEnum` regenerates.
8. **Test fixtures** — all vitest + Playwright + pytest fixtures with hardcoded role
   numerics updated (audit complete; ~25 files).
9. **Stale comments/docstrings** — `useCurrentUserRole.ts` JSDoc, `history/views.py:137`,
   `history/serializers.py:32`, various pytest test docstrings.
10. **Changelog fragment** with prominent breaking-change call-out.

### Out of scope (explicit non-goals)

- The `role_name` textual API field (future-proofing direction; separate issue)
- Custom roles themselves (Enterprise feature; built in `trueppm-enterprise`)
- Enterprise slot-registration plumbing for custom roles (separate Enterprise work item)
- `SmallIntegerField` migration (current `IntegerField` has ample headroom; no benefit)
- Request-caching `_program_membership_role` parity with `_membership_role` (separate perf issue)

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **(A) 100-unit gaps (chosen)** | 4 slots per band; SmallIntegerField-safe; human-readable; matches the user's intuition | One-time data migration + breaking API change for external consumers |
| **(B) 10-unit gaps** | Same shape, smaller numbers | Only 9 slots per band — adequate but no real benefit vs. 100; less readable in logs |
| **(C) 1000-unit gaps** | Maximum extension space | Excessive; readability hit; suggests false flexibility |
| **(D) Defer until custom roles are built** | YAGNI; avoids breaking change now | The breaking-change cost grows with adoption. Doing the renumber pre-custom-roles is a one-step migration; doing it post-custom-roles is a two-step migration. Strictly more expensive. |
| **(E) Promote `role_name` as canonical now** | Future-proof; never need to renumber again | Doubles the scope; OpenAPI consumers still see the integer; adds API surface this MR is not designed for. Tracked as separate follow-up. |
| **(F) Refactor `== Role.SCHEDULER`/`MEMBER` to band-inequality** (original proposal) | "More extensible" if Enterprise custom roles should inherit OSS-tier equality matches | Wrong by design — equality checks should NOT silently absorb custom roles into OSS-specific behavior. If Enterprise wants override semantics, it uses slot registration. |

## Consequences

### Becomes easier
- **Enterprise custom-role implementation** — when the feature ships in `trueppm-enterprise`,
  it slots cleanly into the reserved bands without touching OSS code
- **Renumber resistance** — the next custom role doesn't trigger a chain renumber across
  every `>=` comparison (the ADR-0037-flagged risk)
- **Permission audit clarity** — the equality vs inequality distinction is now codified
  and reviewable, not implicit
- **External API stability** going forward — once 0.2 ships, no further role renumbers
  are anticipated

### Becomes harder
- **External API consumer migration** — anyone reading the numeric `my_role` value
  must update their hardcoded comparisons. Mobile clients, integrations, internal
  scripts. Release notes must surface this prominently.
- **Schema-drift surface** — `RoleEnum` in `openapi.json` is now a breaking change
  vector if it drifts from `models.py`; the existing `api:schema-drift` CI gate
  catches this but reviewers need to be aware

### Risks
- **Forgotten raw-integer comparisons** — the audit found 2 in production (`< 1`) and a
  handful in comments/docstrings. If another exists that grep missed, it would silently
  widen or narrow permissions. **Mitigation**: `/security-review` and `/rbac-check`
  before merge; in the longer term, a CI grep for `role\s*[<>=!]+\s*[0-4]\b` would
  catch regressions.
- **Migration reversibility** — the RunPython multiplies by 100; reversal divides by 100.
  If the migration is partially applied and rolled back mid-way, integer division would
  recover the original values. Low risk; standard precedent.
- **Frontend constant drift** — the new `packages/web/src/lib/roles.ts` is the only
  place ordinals are spelled. A future engineer might introduce a new local constant
  out of habit; the shared module needs a clear docstring and the audit findings should
  be revisited in the next `/rbac-check`.

### Threat model — no permission widening
The re-spacing is a renumbering with identical semantics. The 2 raw-integer `< 1`
guards in sync/workshop consumers continue to mean "Viewer only" under both schemes
(under old: `role < 1` matches role=0; under new: `role < 1` matches role=0 only —
because the next role is now 100). Converting them to `< Role.MEMBER` is a
robustness improvement, not a semantic change. **No permission widening occurs at
migration time.** `/threat-model` recommendation: standard `/security-review` and
`/rbac-check` suffice; no STRIDE-level review needed for this structural change.

## Implementation Notes

- P3M layer: **Programs and Projects / Operations** (cross-cutting infrastructure)
- Affected packages: `api`, `web` (no `scheduler`, no `mobile`, no `helm` changes)
- Migration required: **yes** — `apps/access/migrations/0006_role_ordinal_spacing.py`
- API changes: **yes — breaking** for external consumers reading the integer `role` /
  `my_role` field. `RoleEnum` in OpenAPI regenerates from `[0,1,2,3,4]` to
  `[0,100,200,300,400]`.
- OSS or Enterprise: **OSS** (`trueppm-suite`) — extension-point work analogous to
  ADR-0029 / ADR-0030
- Boundary verification: `grep -r "trueppm_enterprise" packages/` must continue to
  return zero results in executable code

### Durable Execution

1. **Broker-down behaviour**: **N/A** — this is a pure data migration + code refactor.
   No new async dispatch is introduced. Existing async dispatch already uses the
   transactional-outbox pattern (memory: `project_durable_execution`).
2. **Drain task**: **N/A** — no new async work.
3. **Orphan window**: **N/A** — no new async work.
4. **Service layer**: **N/A** — the change is at the model/permission layer. Existing
   `scheduling/services.py::enqueue_recalculate` (the canonical async wrapper) is
   unaffected.
5. **API response on best-effort dispatch**: **N/A** — synchronous endpoints only.
6. **Outbox cleanup**: **N/A** — no new outbox writes.
7. **Idempotency**: **The data migration itself must be idempotent under retry.**
   `RunPython` operations are wrapped in a transaction by Django; if the migration
   fails mid-way, the transaction rolls back and `migrate` can be re-run safely.
   The multiply-by-100 operation is **not** idempotent if re-applied without a rollback
   (would produce 10000s instead of 100s), so the migration must check for the marker
   `current_max(role) <= 4` before applying — guarded by a `MIGRATION_GUARD` value
   stored in a `RunPython` callable's reverse function.
8. **Dead-letter / failure handling**: **N/A for async**. For the migration: standard
   Django migration failure means the `migrate` command exits non-zero and the
   transaction rolls back. CI gates (`/migration-check`) verify reversibility.

## Acceptance criteria

- [ ] `Role` enum values updated to `0/100/200/300/400` with docstring linking this ADR
- [ ] Two raw-integer `role < 1` regressions converted to `< Role.MEMBER` (sync,
      workshops consumers)
- [ ] Data migration applies cleanly forward, reverses cleanly back
- [ ] `packages/web/src/lib/roles.ts` introduced with named exports
- [ ] All ~9 frontend components updated to import from the shared module (audit list
      in research notes)
- [ ] `RolePicker.tsx` value literals updated
- [ ] OpenAPI regenerated; `api:schema-drift` CI gate passes
- [ ] All ~25 vitest + Playwright + pytest test fixtures updated to new ordinals
- [ ] Stale comments/docstrings in `useCurrentUserRole.ts`, `history/views.py`,
      `history/serializers.py`, test docstrings updated
- [ ] Changelog fragment with prominent breaking-change call-out
- [ ] `/migration-check`, `/security-review`, `/rbac-check` gates green
- [ ] Boundary check `grep -r "trueppm_enterprise" packages/` returns zero in
      executable code

## Related ADRs

- **ADR-0029** — Frontend Slot Registry: the canonical extension-point pattern this ADR
  mirrors for backend roles
- **ADR-0030** — Edition-based routing: companion pattern at the navigation layer
- **ADR-0033** — Resource Pool: uses `CanAssignResource` (`>= Role.SCHEDULER`) which
  remains correct under re-spacing
- **ADR-0037** — Hybrid PM Philosophy: explicitly flagged the renumber-breakage risk;
  this ADR resolves it
- **ADR-0042** — Wave 6 Resources Heatmap: uses `role >= Role.SCHEDULER` for tab
  visibility; remains correct
- **ADR-0061** — Project Members Management UI: references `OWNER` ordinal 4 in copy;
  needs ordinal reference updated as a doc follow-up
- **ADR-0070** — Program Entity (OSS): `ProgramMembership` shares the `Role` enum;
  the same migration touches both tables atomically

## Tracking

Tracking: implemented in #508. The follow-up `role_name` textual API field is a
design-only extension-point note (no implementation issue) — it is a forward contract
for Enterprise custom-role naming, not yet scheduled OSS work.
