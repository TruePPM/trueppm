# ADR-0764: New project modal program picker — state ownership and RBAC data flow

## Status
Accepted

## Context

Issue #2673 (OSS, milestone 0.4), carried over from #2666's ask #2-3. `NewProjectModal`
(`packages/web/src/features/shell/NewProjectModal.tsx`) currently receives `programId` /
`programName` as **props**, resolved once by `CreateMenu.tsx` from route context
(`useProgramId()` → `useProgram(programId)`) and threaded through `createIntentStore` →
`CreateDispatcher.tsx` (#2666). Step 1 renders that program as a **read-only** identity
field; step 3's "Use program defaults" checkbox and its `inherit_program_defaults` payload
field are gated on the same `programId` prop.

The ask: make the program changeable — an explicit "None — standalone project" plus the
programs the user administers — and make everything downstream of the original inferred
program (the step-3 defaults affordance and its payload) follow the *picked* program
instead.

**P3M layer:** Programs and Projects (single project's creation flow, program is an OSS
entity per ADR-0070). **OSS**, no boundary question.

### RBAC constraint (ADR-0070)

The server 400s a project create naming a `program` the caller does not administer
(role `< ROLE_ADMIN`). `CreateMenu`'s "+ New project" button is already gated on
`program.my_role >= ROLE_ADMIN` for the *inferred* program — but a picker that offers
*other* programs must apply the same filter to every option, or it hands the user a
choice that 400s at submit.

### An existing precedent already answers the data-fetching question

`MoveToProgramModal.tsx` (#697, ADR-0171) solves the identical sub-problem — "pick a
program I administer" — for the reverse flow (attach an *existing* standalone project to
a program). It calls `usePrograms()` (`GET /api/v1/programs/`, cached under `['programs']`,
returns `Program[]` with `my_role` and `is_closed` per ADR-0070) and filters client-side:

```ts
const eligible = (programs ?? []).filter(
  (p) => !p.is_closed && p.my_role !== null && p.my_role >= ROLE_ADMIN,
);
```

This is the same query the `Sidebar` (always mounted in `AppShell`) already issues on
every authenticated route, so by the time a user opens "+ New project" the `['programs']`
cache is warm in the overwhelming majority of cases — a fresh fetch is the exception, not
the rule. There is no reason to invent a second query or a lazy/on-interaction fetch.

## Decision

### 1. Fetch `usePrograms()` unconditionally on modal mount

`NewProjectModal` calls `usePrograms()` the same way it already calls `useProjects()` for
the step-3 "Copy settings from" picker — unconditionally, every time the modal mounts. No
lazy/on-open-picker fetch. TanStack Query's cache dedup means this is free when `Sidebar`
already warmed `['programs']`, and cheap (one extra GET, `page_size=200`, ADR-0401) when it
hasn't. Filter to eligible programs with the exact `MoveToProgramModal` predicate:
`!p.is_closed && p.my_role !== null && p.my_role >= ROLE_ADMIN`.

### 2. State ownership: local `selectedProgramId`, prop becomes the initial value only

The `programId` prop stays exactly as-is — it is still how `CreateDispatcher` tells the
modal which program the route inferred. But the modal now owns a **separate piece of
local state**:

```ts
const [selectedProgramId, setSelectedProgramId] = useState<string | null>(programId ?? null);
```

Every read that currently branches on the `programId` prop (step-1 field render, step-3
"Use program defaults" render, the `inheritProgram` compute, the `program` key in the
create payload) switches to `selectedProgramId`. The prop is consulted in exactly one
place after mount: as the `useState` initializer. This is a controlled-to-uncontrolled
handoff, not a two-source-of-truth split — there is one live value (`selectedProgramId`)
and the prop only seeds it, matching the pattern the codebase already uses for "server
default, user can then diverge" fields (e.g. `defaultMemberRole` seeded from
`ROLE_MEMBER`).

Do **not** keep the prop as a second read path "for display" — that would let step 1 show
one program while step 3 or the payload act on another, which is precisely the bug #2673
exists to fix (the payload silently following route context instead of user intent).

The display name for the selected program is derived from the fetched list
(`programs?.find((p) => p.id === selectedProgramId)?.name`), falling back to the
`programName` prop **only** while `selectedProgramId === programId` and the list hasn't
resolved yet (avoids a flash of "Unnamed program" during the/ id`Sidebar`-already-warm
race). Once `usePrograms()` resolves, the list's own name always wins — it is the more
current source of truth for the same entity.

### 3. `useProgramDefaults` resets when the selection changes away from its seed value

```ts
function handleProgramChange(next: string | null) {
  setSelectedProgramId(next);
  if (next !== programId) setUseProgramDefaults(false);
}
```

An opt-in the user set while looking at Program A must not silently apply to Program B
the moment they change the picker — the checkbox's own label names the program
(`Use {name}'s defaults`), so leaving it checked across a program swap would apply a
defaults-copy the user never reviewed against the new target. Resetting on every change
(including a change *back* to the original program) is the simpler, safer rule and avoids
tracking "did we already reset once" state; ux-design owns the exact wording/timing of any
transition affordance, but the reset itself is a data-integrity decision, not a cosmetic
one, and is made here.

### 4. Layout: replace the step-1 read-only row; leave step 3 structurally alone

The step-1 static `<div>` (lines 242-254 today) becomes the picker. Step 3's "Use program
defaults" block keeps its current structure, only swapping its `programId`/`programName`
reads for `selectedProgramId`/the derived name. ux-design owns the concrete widget choice
(native `<select>` — matching the existing step-3 "Copy settings from" idiom in this same
modal — vs. a richer combobox) and copy; architecturally the only requirement is that the
options are `[{ id: null, label: 'None — standalone project' }, ...eligible programs]` and
selecting `null` must make the step-1 field, the step-3 defaults block, and the payload's
`program`/`inherit_program_defaults` keys all agree it's a standalone create.

### 5. Loading and empty states

- **Programs still loading:** picker shows a disabled control with a loading placeholder
  (mirrors `copySettingsFrom`'s `projectsLoading ? 'Loading programs…' : …` pattern). The
  route-inferred program (if any) stays selected and displayed via the prop-fallback in
  §2 so the control never flashes empty.
- **Zero eligible programs (beyond the inferred one, if any):** the picker still renders
  with just "None — standalone project" plus the inferred program if it is itself
  eligible. There is no empty state distinct from "only one option" — unlike
  `MoveToProgramModal`, standalone is always a valid choice here, so the list is never
  actually empty.
- **Inferred `programId` absent from the eligible list** (a defensive edge case — the
  program closed or the caller's role changed between `CreateMenu`'s gate check and modal
  open): keep it selectable via the prop-seeded fallback rather than silently dropping the
  selection out from under the user; the server remains the authority and will 400 on
  submit if the race is real, same as any other TOCTOU gap in this codebase's RBAC
  surfaces.

## Alternatives Considered

| Option | Verdict |
|--------|---------|
| **A. Local `selectedProgramId` seeded from the prop, `usePrograms()` fetched unconditionally, MoveToProgramModal's RBAC filter reused verbatim (chosen)** | Reuses a proven query + filter, single source of truth after mount, no new endpoint |
| B. Keep `programId` prop as the only source; add a second "override" state that step 3/payload check *in addition to* the prop | Rejected — reintroduces exactly the two-source-of-truth bug this ADR exists to close; every consumer would need an `override ?? programId` merge, and it's easy to miss one (the failure mode #2673 is about) |
| C. Fetch programs lazily only after the user opens the picker | Rejected — adds a loading flicker on first open for no real savings; the query is already warm from `Sidebar` in the common case, and TanStack Query dedupes regardless |
| D. New scoped endpoint `GET /programs/?my_role_gte=ADMIN` | Rejected — no server change needed; `usePrograms()` + client filter is already the established pattern (`MoveToProgramModal`) and the list is small (≤200, ADR-0401 pagination) |

## Consequences

- **Easier:** the modal's program-related state has one owner (`selectedProgramId`)
  instead of a prop read from multiple places; a future consumer of "which program is
  this create targeting" has one field to read.
- **Harder:** every existing `programId` read inside `NewProjectModal` must be
  audited and switched to `selectedProgramId` in the same change — a missed one
  reintroduces the exact prop/state split this ADR forbids (implementation must grep the
  file for `programId` post-change and confirm every remaining reference is either the
  prop declaration itself or the `useState` initializer).
- **Risk:** the defensive "inferred program absent from eligible list" case (§5) is
  untested against a live race in this MR (client-only feature, no new endpoint) — it is
  a straightforward extension of the existing TOCTOU posture the RBAC gate already
  accepts elsewhere (`CreateMenu`'s own gate has the identical window today).

## Implementation Notes

- **P3M layer:** Programs and Projects.
- **Affected packages:** `web` only — `NewProjectModal.tsx` (state + payload),
  `CreateDispatcher.tsx`/`CreateMenu.tsx` unchanged (still pass the route-inferred
  `programId`/`programName` as the initial seed).
- **Migration required:** no. **API changes:** no — reuses `GET /api/v1/programs/` and the
  existing `POST /api/v1/projects/` `program`/`inherit_program_defaults` fields verbatim.
- **OSS or Enterprise:** OSS.

### Durable Execution

N/A for all eight questions — this is a synchronous client-side form change against two
already-existing, already-synchronous REST endpoints (`GET /programs/`,
`POST /projects/`). No new async dispatch, no Celery task, no outbox row, no broker
interaction of any kind is introduced.
