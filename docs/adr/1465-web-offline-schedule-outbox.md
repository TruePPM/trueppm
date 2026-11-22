# ADR-1465: Web offline schedule outbox — queued structural edits replayed with base versions

## Status

Proposed (2026-11-22)

> **Implementation status (2026-11-22):** design only. Verified on `main`: the schedule
> discards offline structural edits with a toast (#3045). Two narrow IndexedDB queues exist,
> for card status (ADR-0220) and blocker flags (ADR-0247), and both replay `PATCH` last-write-wins.
> ADR-0217 field-level merge (`X-Base-Version`, `sync/conflict.py`, structured 409
> `MergeConflict`) exists for `Task`, `Project` and `Risk`. `tasks/bulk` (ADR-0772) takes
> client-minted ids, returns 207, and has **no** base-version precondition.
> `IDEMPOTENCY_RETENTION_HOURS` is 24. There is no service worker in `packages/web`.

## Context

Layer: **Programs and Projects**. #3045 covers offline structural schedule edits in the installable PWA (ADR-0026).

Pass 4 (canvas section 6) defines the edit states (◷ Queued, ↻ Syncing, ⇄ Conflict, ✕ Failed, ✓ Saved), a queue review, and the rule that the server wins on reconnect, with old and new dates and the reason.

`threat-model` raised two problems:
- A replay past the 24 h idempotency window can blindly overwrite newer data.
- The queue must never carry authority.

## Decision

1. **One schedule outbox in IndexedDB.** It generalizes ADR-0220 and ADR-0247 instead of adding a third bespoke queue.
   - Entries are ordered per project and bound to the user ID.
   - Each entry is one of: `create_task`, `update_task` (fields such as duration or dates), `reparent`, or `link` (dependency create).
   - **Delete is not queueable** (Q6.4 resolved). It stays online-only with today's message.
   - ADR-0220 and ADR-0247 migrate onto this outbox later. Until then they keep working as they are.
2. **Replay paths reuse existing contracts.**
   - Creates and links go through `POST /projects/{pk}/tasks/bulk/` with client-minted UUIDs and an `Idempotency-Key` (ADR-0772). A create has no conflict base. Its replay safety is the client ID: if a create is replayed after the key expired, it hits the primary-key uniqueness constraint, and the client treats that as already saved after a GET confirms the row.
   - Updates and reparents go through `PATCH /tasks/{id}/` with **`X-Base-Version`** set to the row's `server_version` at edit time (ADR-0217).
     - Disjoint concurrent fields merge server-side.
     - Overlapping fields return the existing **409 `MergeConflict`** body, which becomes the ⇄ Conflict state with both named values.
     - The 409 shows the other writer's value and name only if the caller can read them (threat model §3.4).
3. **D2, resolved.** Overwrite protection comes from `X-Base-Version`, **not** from idempotency retention. So `IDEMPOTENCY_RETENTION_HOURS` stays at 24, and the **queue TTL is 72 h**. Entries older than that are marked “✕ Expired — not sent”, shown in the review sheet, and can be retried by hand, which re-runs the base-version check. They are never replayed silently. The sheet offers **Retry all** and **Discard all** for expired and failed entries, and each retry still goes through the base-version check (VoC round 3).
4. **Authority is never cached.**
   - Every replay is re-authorized server-side. A role lost while offline yields “✕ Failed · you no longer have edit access”.
   - The queue isn't offered to roles that can't author the plan: ADR-0773 excludes `Role.SCHEDULER` from plan authoring. For those users, the web shows the online-only message instead of queuing an edit that will 403.
   - Replay needs the same user's live session, so an agent or token caller can never replay a human's queue.
   - The queue is purged on logout and on user switch.
5. **Preview (Q6.1, resolved).** Queued rows show dates from the existing client CPM worker (`workers/cpmEngine.ts`), labeled “≈ preview”.
   - Preview dates are never exported, printed or sent to the server.
   - If the worker can't compute (a known calendar-fidelity gap, #1777), the dates show “—”.
   - After replay, the server recompute wins, and the UI shows the preview-to-server delta and the remote change that caused it (the ExplainedChange primitive, using the recompute `run_id`).
6. **At rest (Q6.5, resolved).** The “encrypted at rest” claim is **dropped**. The protections are user binding, purge on logout and the TTL, plus the existing CSP against XSS. Revisit only with a non-exportable WebCrypto key and a documented threat case.
7. **Service worker.** The outbox is owned by the page and replayed when connectivity returns. Background Sync is used where the browser supports it.
   - The outbox shares the ADR-1463 service worker.
   - Entries stamp the API contract version, and replay refuses to cross an incompatible change. Those entries are marked Failed with “TruePPM was updated; review this edit”.
   - The server kill-switch header unregisters the worker.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Replay everything through `tasks/bulk` with a new base-version precondition | One endpoint | Invents a second conflict contract, when ADR-0217's merge already exists on PATCH |
| Use the WatermelonDB sync upload (`POST /projects/{pk}/sync/`, ADR-0082) | Atomic batches and a conflict model | Built for the native client (ADR-0191), which is off the roadmap. The web would have to adopt the full pull/push protocol. |
| Raise idempotency retention to 7 days | Fewer duplicate edge cases | A bigger key table, and it still wouldn't stop a blind overwrite. The base version does that. |
| Keep discarding offline edits | No new code | Silent loss, the main trust failure (VoC, and category evidence) |

## Consequences

- Easier: edits survive no signal, conflicts are explicit, and the server stays authoritative (ADR-0599 boundary).
- Harder: a client store, ordering and dependency between entries (a link after a create, Q6.3: when a dependency fails, the entries that depend on it fail with it), and three e2e paths: replay, conflict and expiry.
- Risks:
  - Preview dates leaking into conversations. Mitigated by the label and by never exporting them.
  - Service-worker version skew during upgrades. Mitigated by the ADR-1249 window, the contract stamp and the kill switch.

## Implementation Notes

- P3M layer: Programs and Projects.
- Affected packages: web (outbox, service worker, UI states), api (verify `X-Base-Version` on the task PATCH paths used, and add `reparent` to merge coverage if missing), docs.
- Migration: no.
- API changes: none new. Existing contracts are reused, and the `MergeConflict` body is documented in OpenAPI if it isn't already.
- OSS.

### Durable Execution
1. Broker-down behavior: N/A server-side. The queue is client-side, and the server writes are synchronous. The recompute triggered by a replayed edit goes through `enqueue_recalculate()` as for any edit.
2. Drain task: N/A on the server. The client drains on reconnect, or through Background Sync.
3. Orphan window: N/A.
4. Service layer: the existing task write services. No new server path.
5. API response: unchanged. 207 for bulk, 200 or 409 for PATCH.
6. Outbox cleanup: the client purges entries on success, on logout, and at the 72 h TTL (expired entries are shown, not dropped silently).
7. Idempotency: creates use the client UUID primary key plus `Idempotency-Key`. Updates use `X-Base-Version`, so a duplicate replay after success merges as a no-op or reports the overlap.
8. Dead-letter: the review sheet is the dead-letter view. Failed and expired entries stay until the user retries or discards them. Retries back off exponentially on 429 and 5xx.

### AI-review amendments (2026-11-22)
- **API-first:** the outbox is client state by design. Preview dates are the ADR-0599 sanctioned preview path, never persisted. Every persisted outcome is a server write through existing endpoints, so MCP and API clients see the same results with no new surface.
- **Provenance:** the 409 `MergeConflict` body and the post-replay recompute carry the `run_id`, so the “why it moved” explanation is server-derived, not client prose.
- **Decision memory:** N/A (deliberate non-goal). Offline edits are ordinary edits, and they produce no decision distinct from an online edit.

### VoC round 3 amendments (2026-11-22)
Surfaced by a simulated persona panel (VoC round 3, evidence tier E0). It is not user research. Each change is adopted on its merits.
- **Bulk retry and discard** of expired and failed entries (Decision 3).
- **Upgrade notes:** each release's `getting-started/upgrade.md` entry states what happens to queued offline edits across that upgrade, including the contract-version refusal.

### On Acceptance
- [ ] Sweep `--adr 1465` (#3045, #2951) and record the count.
- [ ] Mark ADR-0220 and ADR-0247 “to be migrated onto ADR-1465”, without superseding them yet.
