# ADR-0844: Declare the role, derive the math

## Status
Accepted

## Context

ADR-0843 made the board render one object one way. It did not give the object an
identity it can keep.

`task_is_phase()` (`apps/projects/models.py`) is a live probe for structural children,
so a row's identity is **retroactive and silent**:

- a card now, a lane once someone drops work under it, a card again when that work is
  deleted;
- its **own status and estimate stop belonging to their author** the moment someone else
  adds a child — the values are simply gone, with no way back;
- a row a user created *as* a phase is indistinguishable from a task until something is
  put inside it, which is why "an empty container is legal and visible" could not ship
  with ADR-0843.

Issue #2950, from `design_handoff_trueppm_v4/` case 16.

## Decision

**Declare the role. Derive the math.**

`Task.structure_role` — `work` (default) | `container` | `milestone` — is declared by the
author and governs **rendering, board grouping, creation affordances and vocabulary. And
nothing else.**

The line that makes this safe: **the derived fact wins for every computation.**

- `is_summary` / `is_phase` stay derived from structural child count and stay the only
  input to rollup. This ADR moves no rollup code.
- Declared `work` that has children **is** a container for the math. The declaration is a
  display claim, never a lever over the schedule — so the server returns **`409`** rather
  than storing a declaration it will contradict.
- A declared `container` with no children computes as a leaf with nothing to roll up —
  **empty, not zero** — so it never drags a rollup down or reports false health.

### `own_status` / `own_estimate` — a transition, not a data loss

Server-managed shadow values, parked when a row gains its first child, restored when it
loses the last. Read-only on the API: a writable `own_estimate` would let a client
resurrect a stale number over a live rollup, which is the loss the field exists to prevent.

### `auto_container` — why the reverse is safe to automate

The asymmetry that matters:

- A row that became a container **by gaining a child** reverts when it loses the last one,
  and gets its own estimate back.
- A row that was **declared** a container stays declared and becomes an empty lane.
  Reverting is *offered* to the user, never applied.

Silently un-declaring somebody's phase because its last task moved is the same class of
silent identity change this ADR exists to remove. `auto_container` records which happened.

## Consequences

**A structural create now bumps its parent's `server_version`.** This inverts a
pre-existing assertion (`test_non_subtask_does_not_bump_parent_version`) and it is
correct: the parent genuinely changed, and a sync client that never learns its
`structure_role` renders it as work forever.

The write fires on the **transition only** — parking is idempotent — so a paste-many
creating forty rows under one parent bumps it once, not forty times.

**`409`, not `400`.** The payload is valid and the value is legal; it is the current state
of the *tree* that forbids it, and that state can change without the client doing anything
wrong. A `400` would tell an integrator to fix a payload that is fine. The body carries the
derived `structure_role` so the refusal is recoverable in one round trip.

The body carries **strings only**. DRF wraps every value in an exception detail as an
`ErrorDetail` (a `str` subclass), so a boolean `is_phase: true` would reach an integrator
as `"True"`. A field that lies about its own type is worse than one that is absent.

**What this unblocks:** the `⇥` container-plus-first-child gesture (#2951), the surface
demotions and vocabulary lock (#2952), board lanes as a server fact (#2953), and the
"empty containers are legal and visible" half of #2956 that ADR-0843 had to defer.

## Alternatives considered

**Keep deriving, and fix presentation only.** This is ADR-0843, and it is why this ADR
exists — the rendering rule removed the visible duplicate but left the cause, so a
declared-but-childless phase still renders as a card and nobody's parked estimate survives.

**Store the declaration and let it win.** Rejected outright. Rollup is server-enforced;
a declaration that overrode the derived fact would let a client detach a phase's status
from its children, and every number downstream would become unfalsifiable.

**Reset `own_*` on every child change instead of parking once.** Rejected: the second
child would overwrite the author's values with whatever the rollup had just written, which
is the data loss with extra steps. Parking is idempotent for exactly this reason.

**Auto-revert every childless container.** Rejected — it cannot tell a phase someone
declared from one that happened. That is the whole point of `auto_container`.
