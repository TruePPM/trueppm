# ADR-1049: Schedule constraint types — ASAP, SNET, FNLT, MSO, MFO, plus a soft deadline; no ALAP, SNLT, or FNET

## Status

Proposed (2026-09-05). Resolves #3345. Extends ADR-0014 (which chose
`planned_start` as the single writable date and gave it start-no-earlier-than
semantics) and ADR-0021 (MS Project import/export). Re-homes #690 and #804 (the soft
deadline, 0.5) and narrows #1441 (0.6) from the full MS Project set to the set below.

## Context

TruePPM honors exactly one schedule constraint. `Task.planned_start` is a
start-no-earlier-than (SNET) floor in the forward pass
(`packages/scheduler/src/trueppm_scheduler/engine.py`, `_forward_pass`:
`es_constraints.append(_next_working_day(task.planned_start, cal))`). `planned_finish`
exists on both engines' `Task` models and is documented as **reserved and inert** —
the backward pass does not read it. There is no constraint-type field anywhere, no
finish-side constraint, no ALAP, and no deadline (`msproject/views.py`: "TruePPM has no
deadline field").

The MSPDI importer already knows the eight MS Project constraint codes
(`MSPDI_CONSTRAINT_NAMES`) and applies **two** of them as SNET — code 4 (SNET) exactly,
and code 2 (Must Start On) partially, as a floor without the ceiling. Every other code
is reported as a dropped constraint in the import warnings (#2891). The failure mode
the 2026-09-03 audit named is therefore already visible but not fixable: an imported
plan whose Must-Finish-On dates vanish with a warning the operator cannot act on.

Two facts bound the options:

- **Two engines must stay in conformance.** Any constraint the Python engine honors,
  the Rust engine must honor identically, with fixtures under `wasm:conformance`.
  Each type added is dual-engine work.
- **The target market is not P6's.** The ICP (`.claude/personas.md`) is
  sovereignty-constrained technology delivery, Jira Data Center refugees, and Project
  Online migrators; EPC, construction, and P6-scale schedules are explicitly out of
  scope. Project Online migrators arrive with MS Project habits: SNET (set implicitly
  whenever a start date is typed), Deadline (the soft marker), FNLT (the contractual
  finish), and MSO / MFO (fixed gates). ALAP, SNLT, and FNET are P6 idioms.

## Decision

**Option C from #3345 — "B-lite" — with the deadline kept as a separate soft marker.**

1. **Constraint model.** `Task` gains `constraint_type` (closed set, default `ASAP`)
   and `constraint_date` (nullable; required for every type except `ASAP`), on the
   Django model, the Python engine's `Task`, and the Rust engine's `Task`:

   | Type | Forward pass | Backward pass | Can create negative float |
   |---|---|---|---|
   | `ASAP` | none | none | no |
   | `SNET` | ES floor at `constraint_date` (today's `planned_start` behavior) | none | no |
   | `FNLT` | none | LF ceiling at `constraint_date` | **yes** — on this task and its predecessors |
   | `MSO` | ES pinned to `constraint_date` | LS pinned to `constraint_date` | **yes** — predecessors that finish later than the pin |
   | `MFO` | EF pinned to `constraint_date` | LF pinned to `constraint_date` | **yes** |

   `is_critical` becomes `total_float <= 0`. A pinned task never moves under a drag;
   the drag preview shows the pin and the resulting negative float on the affected
   chain, and the commit path writes `constraint_date` only when the type is `SNET`
   (the one type a drag semantically edits).

2. **Soft deadline stays separate.** `planned_finish` becomes the **deadline** field
   (#690): a non-constraining target. #804 feeds it into the backward pass as a
   *reporting* ceiling so `total_float` can go negative against it, without pinning
   dates. A PM can hold a hard `MFO` gate and a softer internal deadline on the same
   task, which is the MS Project shape and the one migrators expect.

3. **Omitted, and the workflow each omission breaks.** `ALAP` — just-in-time
   procurement and progress-payment tasks scheduled against their late dates; a P6 and
   EPC idiom, out of the ICP. `SNLT` — "start before the funding window closes"; rare in
   MS Project practice and expressible as `FNLT` on the same task with `constraint_date
   + duration`. `FNET` — "do not finish before the go-live window opens"; the usual
   modeling is `SNET` on the successor. If a real user asks for one of these three, the
   closed set widens by one migration; nothing in the model forecloses it.

4. **Import mapping** (MSPDI code → TruePPM), each dropped code a row-level warning
   naming the task, in the same warning surface the CSV wizard uses:

   | MSPDI | TruePPM | Warning |
   |---|---|---|
   | 0 ASAP | `ASAP` | — |
   | 1 ALAP | `ASAP` | "scheduled as soon as possible; ALAP is not supported" |
   | 2 MSO | `MSO` | — |
   | 3 MFO | `MFO` | — |
   | 4 SNET | `SNET` | — |
   | 5 SNLT | `ASAP` | "start-no-later-than dropped; consider FNLT on this task" |
   | 6 FNET | `ASAP` | "finish-no-earlier-than dropped; consider SNET on the successor" |
   | 7 FNLT | `FNLT` | — |
   | `<Deadline>` | `planned_finish` (deadline) | — |

   CSV gains optional `constraint_type` / `constraint_date` columns with the same
   closed set and the same row-level rejection for unknown values. Export writes the
   inverse mapping; the exporter emits code 0 for `ASAP`.

5. **Migration.** Existing rows with `planned_start` set become
   `constraint_type = SNET`, `constraint_date = planned_start`. `planned_start` is
   retained for one minor release as a **read-only alias** of `(SNET, constraint_date)`
   on the serializer, marked deprecated in `docs/api/stability.md`, and removed in the
   following release. The engines read only the new pair from the first release.

6. **Sequencing.** #690 and #804 (deadline and negative float) stay at 0.5 — the
   backward-pass plumbing they need is the same plumbing `FNLT` uses. #1441 at 0.6
   delivers the five-type set above in both engines with conformance fixtures per type
   and per negative-float case; its title and body are rewritten to this scope on
   acceptance.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. SNET-only plus a soft deadline** (#690 / #804 alone) | Cheapest; matches Planner Premium; no new engine semantics beyond one ceiling | Leaves MFO / MSO users with a warning instead of a schedule. A contractual go-live is the single most common hard date in the ICP's regulated programs, and a soft marker cannot express it. |
| **B. Full MS Project set** (eight types) | Lossless MSPDI import; no "unsupported" row ever | Three of the eight are P6 idioms outside the ICP; each is dual-engine work with its own fixture family, drag semantics, and derivation-explainer case. Roughly doubles the engine scope for types a Project Online migrator does not use. |
| **C. B-lite — five types plus the soft deadline (chosen)** | Covers every constraint an MS Project user sets deliberately; a closed set the derivation explainer can name; the three omissions each have a documented workaround; widening later is additive | Two MSPDI codes still import lossy (with a row-level fix suggestion). ALAP users get a warning. |
| **D. Deadline as a constraint** (fold `planned_finish` into `FNLT`) | One fewer field | Loses the hard-gate-plus-soft-target pairing MS Project users rely on; a deadline that pins dates surprises the PM who set it as a reminder. |

## Consequences

**Easier.** The import warning becomes actionable: "12 tasks carry Finish No Later
Than" turns into twelve honored constraints. The gaps page's "one type, not eight"
becomes "five types plus a deadline, and here is what the other three map to".
Negative float gives the PM the sentence they actually want — "N days behind the
committed date" — from the engine rather than from arithmetic.

**Harder.** Negative float changes the meaning of `is_critical` and touches every
consumer that assumed float is non-negative: the Schedule grid's float columns (#3344),
the criticality derivation, Monte Carlo's per-task sensitivity, and the WASM
conformance fixtures. `MSO` / `MFO` pins interact with the data-date floor (ADR-0752):
a pin in the past is honored as a pin and reported, never smoothed forward.

**Risks.** The `planned_start` alias period is where a client that still writes
`planned_start` silently loses the write. Mitigation: the serializer rejects a write to
the alias with a 400 naming the new fields from day one; only *reads* are aliased.

## Implementation Notes

- **P3M layer:** Programs and Projects (engine).
- **Affected packages:** scheduler, wasm-scheduler, api (model, serializer, MSPDI and
  CSV importers, exporter), web (drag preview, float columns, task drawer), docs.
- **Migration required:** yes (#1441) — additive columns plus a `RunPython` backfill
  of `SNET` from `planned_start`. Constraint safety: additive nullable columns, no
  `AddConstraint`.
- **API changes:** yes — two new task fields, one deprecated alias, new import
  warning codes; `docs/api/openapi.json` regenerated; `docs/api/stability.md` records
  the alias window.
- **OSS or Enterprise:** OSS. This is the core scheduling algorithm (boundary rule 8).

### Durable Execution

1. **Broker-down behaviour:** N/A — constraints are read by the synchronous CPM pass
   and by the existing import drains; no new async path.
2. **Drain task:** reuses the existing MSPDI and CSV import drains; the mapping runs
   inside them.
3. **Orphan window:** N/A — no new outbox rows.
4. **Service layer:** the constraint mapping is one pure function shared by the MSPDI
   and CSV parsers (`msproject/parser.py` and `csvimport`), so the two warning surfaces
   cannot disagree.
5. **API response on best-effort dispatch:** N/A — synchronous.
6. **Outbox cleanup:** N/A.
7. **Idempotency:** the `RunPython` backfill is idempotent (`WHERE constraint_type IS
   NULL AND planned_start IS NOT NULL`).
8. **Dead-letter / failure handling:** N/A.

### On Acceptance

- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1049`
- [ ] #1441 re-titled and re-scoped to the five-type set; #690 / #804 bodies cite
      this ADR for the soft-deadline half; record the count rewritten.
- [ ] `features/schedule.md` "separate mechanism" sentence and
      `overview/what-it-does-not-do.md` "one type, not eight" section updated to the
      decision (done in Proposed form by the MR that adds this ADR; re-check on acceptance).
