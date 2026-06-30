# ADR-0156: Program split into sub-programs

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: def split_program)

## Context
`POST /api/v1/programs/{id}/split/` has shipped since #530 as a **501 stub** that
validates the payload contract (`{"splits": [{"name": str, "project_ids": [uuid]}]}`)
and the Owner role, then returns `501 Not Implemented` with `{detail, tracking_issue}`.
The web `useSplitProgram` hook already posts to it; the `ProgramArchivePage`
"Split into sub-programs" `LifecycleCard` is disabled with a `#967` callout.

#967 (follow-up to #530) tracks turning the four descoped lifecycle actions into real
implementations. Two of the four — project transfer-ownership and program
transfer-sponsorship — already shipped. This ADR covers the **program split backend
only**. The web wiring (a redistribution dialog) is deferred to a follow-up MR because
the program-settings web files (`ProgramArchivePage.tsx`, `useProgramMutations.ts`,
`ProgramArchivePage.test.tsx`) are currently being edited by three other in-flight
branches; landing the backend first is collision-safe and makes the endpoint
API-first usable and tested before the UI lands.

**P3M layer**: Programs and Projects (OSS). Splitting a program produces *independent
OSS programs* in the same single workspace — it is program management, not cross-program
or portfolio governance. No Enterprise surface is touched (no portfolio, no cross-program
rollup, no org policy). Confirmed against the Two-Repo Rule.

## Decision
Replace the 501 stub with a real, atomic, Owner-only split implemented in a new
`access.services.split_program()` service function (heavy lifting lives in the access
services module, matching `create_program` / `delete_program_cascade` /
`transfer_program_sponsorship`).

Semantics:
1. **Each split entry creates one new sub-program** via the existing
   `create_program(name=split.name, description="", methodology=parent.methodology,
   created_by=actor)`. The actor becomes OWNER of every sub-program (atomic OWNER
   membership is the whole point of `create_program`). Sub-programs leave all
   inheritable override fields NULL → they inherit workspace defaults (ADR-0135/0144/
   0151/0153). Methodology is copied from the parent so the new programs keep the
   parent's planning style by default.
2. **Listed projects are reassigned** — `Project.program` is set to the new sub-program
   for each `project_id` in that split. Project rows, tasks, dependencies, baselines,
   memberships, and history are untouched (only the `program` FK moves), satisfying the
   card's "all project links, dependencies, and baselines are preserved" promise.
3. **The original program is closed** (`is_closed=True`, `closed_at`, `closed_by=actor`)
   after redistribution, matching the card copy "Original program is archived after
   split." Projects *not* listed in any split remain attached to the now-closed parent
   (a closed program is a read-only shell; its member projects keep their own lifecycle,
   per the existing `close` semantics). Full coverage is **not** required — the PM
   chooses what moves; the remainder stays with the retired parent and can be reassigned
   later. This keeps the operation predictable and avoids silently orphaning projects.

Validation (returns `400` with an actionable `detail`, before any writes):
- `splits` must be a non-empty array; each entry needs a non-empty `name` and a
  `project_ids` array (already enforced by the stub — kept).
- Every `project_id` must reference a non-deleted project that belongs to **this**
  program. A foreign or unknown project id is rejected.
- A project id may appear in **at most one** split (no duplicate assignment).
- Empty `project_ids` is allowed (creates an empty sub-program shell) — symmetric with
  `create_program`, which permits a program with no projects.

Response: `200` with `{program: <closed parent>, sub_programs: [<ProgramSerializer>...]}`
so the client can route the user to the new programs. A single `program_split` WS event
is broadcast on the parent channel after commit.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Require full project coverage (every program project must land in a split) | No "leftover on a closed program" state | Forces the PM to place projects they may want to leave behind; more rigid; bigger UI burden |
| Keep parent open after split | Parent stays writable | Contradicts shipped card copy ("archived after split"); ambiguous "what is the original now?" |
| Move projects but don't create OWNER membership for actor | Fewer rows | Sub-programs could end up with no Owner if actor isn't auto-added → unmanageable program (the exact orphan `create_program` exists to prevent) |
| Implement inline in the viewset | Less indirection | Violates the module's "thin viewset, services do the work" contract; harder to unit-test the transaction |

## Consequences
- **Easier**: PMs can divide an over-grown program into focused OSS programs via API
  today; the web dialog lands next without backend risk. The endpoint is fully tested
  and API-first.
- **Harder**: Split is not a one-click undo — reversing it means reopening the parent and
  reassigning projects back. Documented in the action's docstring and (later) the dialog
  copy. Acceptable: it mirrors `transfer-sponsorship`, which is also not auto-reversible.
- **Risks**: A partial/incorrect reassignment would scatter projects. Mitigated by full
  upfront validation and a single `@transaction.atomic` wrapper — all sub-programs +
  reassignments + parent close commit together or not at all.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api (no web in this MR — deferred)
- Migration required: **no** — only `Program` row inserts and `Project.program` FK
  updates; no schema change.
- API changes: yes — `POST /programs/{id}/split/` goes from `501` to `200`; new
  `program_split` WS event registered in `FROZEN_WS_EVENT_TYPES` and the websockets
  taxonomy doc.
- OSS or Enterprise: **OSS** (trueppm-suite).

### Durable Execution
1. Broker-down behaviour: N/A for the DB mutation — it is synchronous and atomic. The
   only async side effect is the post-commit `program_split` WS broadcast, dispatched via
   `transaction.on_commit()` exactly like every other program lifecycle event
   (`program_closed`, `program_sponsorship_transferred`). A dropped broadcast degrades to
   a client refetch; it never corrupts state.
2. Drain task: N/A — no Celery work is enqueued. CPM recalculation is not triggered
   (reparenting a project under a different program does not change any schedule).
3. Orphan window: N/A — no outbox row, no drain.
4. Service layer: new function `access.services.split_program(program, splits, actor)`.
5. API response on best-effort dispatch: synchronous `200` with the serialized parent +
   sub-programs (not `202`/`queued` — the work is fully done at response time).
6. Outbox cleanup: N/A — no outbox row.
7. Idempotency: the operation is **not** naturally idempotent (a second identical call
   would create a second set of sub-programs). It is guarded by the same `IdempotencyMixin`
   that the rest of `ProgramViewSet` uses (`Idempotency-Key` header dedupes retries), and
   by the `IsProgramNotClosed` gate — once the parent is closed by the first call, a
   replayed split returns `403` (closed program cannot be split), so a broker/network retry
   cannot double-split.
8. Dead-letter / failure handling: N/A — synchronous. A `ValidationError` returns `400`
   and writes nothing (atomic); an unexpected exception rolls the whole transaction back.
