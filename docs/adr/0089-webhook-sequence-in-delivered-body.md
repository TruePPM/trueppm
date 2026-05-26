# ADR-0089: Webhook delivery sequence number in the delivered body

## Status
Accepted

## Context
ADR-0083 (#664) added a monotonic, per-subscription delivery sequence number
(`Webhook.delivery_sequence`, allocated once per `WebhookDelivery` under
`select_for_update`, stable across retries, surviving the retention purge). It
is surfaced **only** in the `X-TruePPM-Webhook-Sequence` response header, and
ADR-0083 explicitly recorded "no body envelope."

#664's acceptance criterion was "header sent **+ body envelope updated**." The
body half was never delivered: the outbound POST body is the raw rendered
payload, so a consumer doing **self-contained, in-body** gap detection (one that
persists only the JSON body, not the headers) cannot see the sequence. #715
closes that gap and reverses the "no body envelope" sub-decision of ADR-0083.

The delivered body differs by format (ADR-0083): `generic` is the raw event
payload — a **flat** task dict (`{id, project, name, status, duration, assignee,
planned_start, …, source}`, from `_task_webhook_payload`); `slack` is a Slack
incoming-webhook message (`{text, attachments}`). Any in-body sequence must work
for both without breaking either, and must preserve ADR-0083's invariant that
**the delivery row is the audit record of exactly what was sent**.

This is a refinement of a shipped contract, not a new feature — keep it minimal.

P3M layer: Programs and Projects (project- and program-scoped webhooks). OSS.

## Decision
Carry the sequence in the delivered body under a **reserved top-level `_meta`
object**: `{ …rendered…, "_meta": { "sequence": N } }`. The
`X-TruePPM-Webhook-Sequence` header stays unchanged for back-compat.

- **Additive, not an envelope.** The rendered domain content keeps its existing
  top-level shape; `_meta` is added alongside it. This does not break #664's
  just-shipped `generic` body, and Slack ignores the unknown `_meta` key, so the
  `slack` body still renders. One uniform rule for every format — no per-format
  special-casing.
- **`_meta` namespace, not a bare `sequence` key.** Because the `generic` body
  is a *flat* domain dict, a bare top-level `sequence` would sit among domain
  fields and could collide with a future event field of the same name.
  Underscore-prefixed `_meta` is a reserved delivery-metadata namespace that
  cannot collide with a domain field, and is the natural home if later deliveries
  need `delivery_id`/`event` in the body too (today it holds `sequence` only).

**Injection point and the render/allocate ordering.** `render()` runs in
`dispatch_webhooks()` *before* the `WebhookDelivery` row exists, so the sequence
is not known at render time. The number is therefore **pre-allocated** with
`_next_delivery_sequence(webhook.id)` and injected by a provider-agnostic
post-render step (`{**rendered, "_meta": {"sequence": seq}}`, a fresh dict so the
shared input `payload` is never mutated), then passed into `create()` as both
`payload=` and `sequence_number=`. `WebhookDelivery.save()`'s existing guard
(`adding and not self.sequence_number`) skips its own lazy allocation when the
number is preset — so this stays a **single write**, the stored payload equals
the wire body (audit invariant preserved), and the HMAC signature authenticates
the sequence.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **`_meta.sequence`, additive (chosen)** | No break to #664 or Slack; collision-proof against the flat domain namespace; uniform across formats; extensible | One extra nesting level for consumers (`body._meta.sequence`) |
| Bare top-level `sequence`, additive | Simplest consumer access | Collides with the flat `generic` domain namespace; a future `sequence` event field would clash |
| Full envelope `{sequence, event, data}` | Clean/unambiguous for generic | **Breaks Slack** (requires `text`/`attachments` at top level); breaking change to #664's generic body |
| Format-aware injection (envelope for generic, native for slack) | Most "correct" per format | Most code; non-uniform contract along a second axis |
| Inject only at POST time in `deliver_webhook` (not stored) | No second field on create | Stored `delivery.payload` ≠ wire body — violates ADR-0083's audit-record invariant |

## Consequences
- **Easier:** consumers that persist only the JSON body can do gap detection
  without capturing headers. The delivery log row now shows the exact bytes sent,
  sequence included.
- **Harder / risks:** `_meta` is now a reserved top-level key in every delivered
  body — documented as such. Low risk: it is additive and underscore-namespaced.
- **Found en route:** `docs/features/integrations.md` described the `generic`
  body as an envelope `{event, project_id, timestamp, data}` — stale; the real
  body is the flat task dict. Corrected in the same change.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: api
- Migration required: **no** — `sequence_number` already exists; it is now set
  explicitly on `create()` instead of lazily in `save()`. No schema change.
- API changes: the **delivered webhook body** now includes `_meta.sequence`. No
  REST endpoint/serializer/permission change (the deliveries inspection endpoint
  already exposes `sequence_number`).
- OSS or Enterprise: OSS.

### Durable Execution
1. Broker-down behaviour: unchanged. `dispatch_webhooks` still writes the
   `WebhookDelivery` row and attempts `deliver_webhook.delay()`; on broker error
   the row stays PENDING and `drain_webhook_queue` retries it. No new dispatch
   path is introduced.
2. Drain task: reuses the existing `drain_webhook_queue` — semantics are
   identical (the rendered body, now with `_meta`, is frozen on the row).
3. Orphan window: unchanged (existing 5-minute webhook drain window).
4. Service layer: `dispatch_webhooks()` is the existing entry point; no new
   `services.py` function.
5. API response on best-effort dispatch: N/A — dispatch is internal
   (`transaction.on_commit`), not a user-facing endpoint returning a task id.
6. Outbox cleanup: unchanged — the retention purge (ADR-0081) deletes terminal
   delivery rows on the existing schedule; the counter lives on the subscription
   and is unaffected.
7. Idempotency: the sequence is allocated once per delivery row under
   `select_for_update` and injected from that single allocated value, so retries
   re-send a byte-identical body. Pre-allocating before `create()` (vs. lazily in
   `save()`) does not change this — the row keeps its number across retries.
8. Dead-letter / failure handling: unchanged — `deliver_webhook` retries with
   backoff up to 5 attempts, then marks the row `FAILED` (ADR-0083/#664).
