# ADR-0599: The API-first boundary — where scheduling compute runs outside the API, and why

## Status

Accepted (2026-07-23)

> Narrows the absolutist phrasing of the API-first principle (CLAUDE.md #1, and
> the `#api-first` section of the website architecture overview) and the
> "no browser recompute" corollary asserted in
> [ADR-0218](0218-schedule-value-derivation-graph.md) and
> [ADR-0015](0015-wasm-cpm-engine.md). It changes no behavior and overturns no
> decision; it names the boundary those ADRs already draw so the exceptions read as
> one coherent rule rather than scattered one-offs. Issue #2311.

## Context

API-first is TruePPM's first design principle, and it is stated absolutely:

> Every feature is a REST or WebSocket endpoint first. Web and mobile are API
> consumers with no privileged access. **If it's not in the API, it doesn't exist.**

The corollary is restated as a hard rule across the scheduling ADRs — schedule
values are *"never recomputed in the browser"* ([ADR-0218](0218-schedule-value-derivation-graph.md)),
*"the server always has the last word"* ([ADR-0015](0015-wasm-cpm-engine.md)). The
rule exists for a real reason: a value computed in two places drifts, and a schedule
that says one thing in the browser and another on the server is a correctness bug,
not a cosmetic one.

But the codebase deliberately does **not** route one thing through the API: the
interactive Gantt drag and keyboard-reschedule **preview**. Dragging a bar
recomputes the affected downstream dates locally, in a Web Worker, with no API
round-trip — because a per-frame REST call would make 60fps interaction impossible.
That local compute is a *best-effort preview*, discarded and replaced by the
authoritative server result on commit. It is a genuine, intended exception to
"if it's not in the API, it doesn't exist," and nothing consolidates *where* the
line sits, *why* the exceptions are safe, or *what invariant* keeps them from
becoming the divergence the rule guards against. The reasoning is spread across
[ADR-0015](0015-wasm-cpm-engine.md), [ADR-0027](0027-incremental-cpm-recompute.md),
[ADR-0218](0218-schedule-value-derivation-graph.md), and
[ADR-0371](0371-wasm-scheduler-typed-array-drag-result.md).

This ADR draws the boundary once.

## Decision

**API-first is the default and it is not weakened. The authoritative value of any
persisted fact — including every scheduled date, float, and forecast — is produced
server-side and reached over the API. Three narrowly-scoped compute paths run
outside the API. Each is bounded by the same invariant: the server has the last
word.**

### What is API-first (the default — unchanged)

- **All state, collaboration, and persistence.** Every task, dependency, sprint,
  and board write is a REST `PATCH`/`POST`; every fan-out is a WebSocket broadcast.
- **The authoritative schedule.** The full-network CPM and all Monte Carlo run
  server-side in the Python `trueppm-scheduler` library, dispatched via the
  `ScheduleRequest` outbox and a Celery worker (`apps/scheduling/services.py`,
  `apps/scheduling/tasks.py`), and the computed dates are broadcast over WebSocket.
  A client never persists a schedule it computed itself.

### The three bounded exceptions

1. **Interactive schedule preview (drag / keyboard reschedule).**
   Recomputes the downstream subgraph locally with no API round-trip.
   *Why:* latency — an API call per pointer-move would destroy interactivity.
   *Shipped mechanism:* a hand-written TypeScript CPM forward pass in a Web Worker
   (`packages/web/src/workers/cpmEngine.ts`), deliberately lower-fidelity
   (approximates a Mon–Fri week; does not model custom calendars) and capped to a
   small number of preview bars.
   *Bounded by:* the preview is never persisted; on commit the write goes through
   the API and the server CPM reconciles the authoritative dates
   ([ADR-0027](0027-incremental-cpm-recompute.md)).

2. **On-device / offline recompute (future — mobile, #1777).**
   When there is no network, the API cannot be first, so the client will recompute
   locally.
   *Why:* offline is a first-class requirement for the mobile app; a plan must stay
   usable with no signal.
   *Planned mechanism:* the Rust + petgraph CPM engine (`packages/wasm-scheduler`),
   compiled to WASM. It is **built and held in conformance with the Python engine in
   CI today, but is not yet wired into any client** ([ADR-0015](0015-wasm-cpm-engine.md));
   the shipped browser preview above remains the TypeScript port until that swap
   lands.
   *Bounded by:* CI conformance to the Python source-of-record guarantees the
   offline result matches what the server would compute, and the server still
   reconciles on reconnect.

3. **The scheduling engine as a separable library.**
   `trueppm-scheduler` (PyPI) and the Rust crate are usable with no API — embedded
   in scripts, other tools, and the WASM build.
   *Why:* the engine is core IP shipped as a reusable Apache-2.0 package, decoupled
   from Django by design so its correctness can be validated without a database.

### The invariant that keeps the exceptions safe

**The server always has the last word, and no two engines are allowed to disagree.**
Client-side compute is only ever a preview (exception 1) or an offline approximation
(exception 2), never the source of truth; the authoritative value is always the
server's. A CI conformance suite pins the Rust/WASM engine to the Python
source-of-record so the offline path cannot silently drift. Monte Carlo has no
client implementation at all — it is server-only.

The test for whether a new client-side computation is permitted: **is its result
authoritative?** If a persisted value depends on it, it belongs server-side, behind
the API — the [ADR-0218](0218-schedule-value-derivation-graph.md) rule stands. If it
is a discardable preview or an offline stand-in that the server will reconcile, it
may run at the edge, subject to the invariant above.

## Alternatives Considered

| Option | Why not |
|---|---|
| **Leave the principle absolute, treat previews as undocumented exceptions.** | The status quo. Every scheduling ADR re-derives the same carve-out from scratch, and a reader of CLAUDE.md #1 or ADR-0218 alone would conclude the drag preview violates the architecture. The rule needs its boundary stated, not implied. |
| **Route the drag preview through the API for consistency.** | A REST round-trip per pointer-move cannot hit 60fps; this is exactly the interactivity the local worker exists to provide. It would trade the product's core interaction for doctrinal purity. |
| **Rewrite ADR-0015 / ADR-0218 to soften their language in place.** | ADRs are dated, accepted decision records; the convention is to narrow them with a new ADR, not edit the originals. Their strict phrasing is also correct *for authoritative values* — only the boundary needed naming. |
| **Make the client engine authoritative and treat the server as a validator.** | Inverts the invariant. The client engines are lower-fidelity (the TS port ignores custom calendars) or not yet client-wired (WASM); making them authoritative reintroduces exactly the server/client divergence ADR-0218 forbids. |

## Consequences

**Positive**

- The API-first principle now has an explicit, testable boundary: authoritative →
  API; discardable preview or offline stand-in → edge, server reconciles.
- New scheduling work has one place to check whether a client-side computation is
  allowed, instead of inferring it from four ADRs.
- The absolutist slogan can no longer be mis-read as forbidding the drag preview or
  future offline recompute.

**Negative / cost**

- One more ADR to keep aligned. Mitigated by making it a *pointer* to the load-bearing
  ADRs (0015, 0027, 0218, 0371) rather than restating their decisions.
- The boundary must be re-checked whenever the WASM engine is finally client-wired
  (#1777): exception 2 moves from "future" to "shipped," and the on-device fidelity
  claims in the website docs must switch from future to present tense at that point.
