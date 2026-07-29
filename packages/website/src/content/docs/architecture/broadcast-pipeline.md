---
title: Broadcast and webhook delivery pipeline
description: How a committed write becomes a WebSocket push and an outbound webhook — the outbox discipline, HMAC signing, retry and backoff, the drain for lost dispatches, and why webhook failure is a separate concept from the platform's generic dead-letter system.
---

[WebSocket event conventions](/architecture/websocket-events/) documents the
event-type naming rule, the envelope, and the frozen-contract guarantee for
real-time broadcasts — read that first if you haven't. This page covers what
that one doesn't: how a broadcast is actually dispatched under the hood, how
the same underlying event becomes a signed, retried, eventually-dead-lettered
outbound webhook, and why "a webhook delivery failed" and "a Celery task was
dead-lettered" are two different systems in this codebase, not one.

## The broadcast call: durable-first, delivery best-effort

`broadcast_board_event()` is the single function every mutation calls to push
a change to connected clients. Its contract is asymmetric on purpose: the
**event is durable**, but its **delivery is best-effort**.

1. It first writes a `BoardEvent` row — a bounded, per-project buffer — unless
   the event type is on a short denylist of high-frequency, pointless-to-replay
   events (presence pings, task-run progress ticks). This durable write happens
   *before* anything is pushed anywhere.
2. It then sends the envelope directly to the Channels layer's group —
   `channel_layer.group_send()` against Valkey pub/sub. This is not routed
   through Celery; it is a direct, synchronous call from whatever request or
   worker triggered the mutation.
3. If no channel layer is configured, or the send fails, the function logs and
   returns — it never raises. A client that missed the live push is expected
   to notice a gap (via the `seq` mechanism [WebSocket event
   conventions](/architecture/websocket-events/#reconnect-replay--sequence-numbers)
   describes) and reconcile by re-pulling, not to be guaranteed the push
   arrived.

The reason this asymmetry is safe: every event that matters for reconciliation
is already durable in `BoardEvent` (or, for the sync-cursor-relevant models,
in the row's own `sync_seq`) before the broadcast is even attempted. A dropped
WebSocket push is a staleness problem with a bounded fix — reconnect and
replay, or worst case, a `resync_required` full refetch — never a data-loss
problem.

**Every call site must be deferred with `transaction.on_commit()`**, so a
broadcast never fires for a mutation the database transaction goes on to roll
back. This is enforced socially rather than mechanically: there is no lint
rule or AST check that blocks an undeferred call from merging. What actually
keeps this discipline intact is two things working together — the
`broadcast-check` review gate that runs on every write-path change, and a
periodic manual audit of every `on_commit` call site in the codebase that
classifies each one as durably outbox-protected or deliberately best-effort.
The one thing that *is* mechanically enforced is a narrower, adjacent property:
a CI test AST-scans the source for every literal event-type string passed to
`broadcast_board_event()` and asserts it against a hand-maintained frozen set —
guarding the wire contract [WebSocket event
conventions](/architecture/websocket-events/#the-frozen-contract) describes,
not the `on_commit` discipline itself.

## `BoardEvent`: a bounded, replay-only buffer

The row `broadcast_board_event()` writes is deliberately minimal
infrastructure — a plain (non-`VersionedModel`) table, never synced to a
mobile client, existing purely so a client that missed a live push can ask for
"everything after sequence N." Its primary key doubles as the wire `seq`,
chosen specifically because Postgres assigns it atomically at insert time —
globally monotonic across concurrently committing transactions, with no
separate per-project counter to maintain.

A nightly job purges rows older than `TRUEPPM_BOARD_EVENT_RETENTION_HOURS`
(default 24 hours). This buffer is treated as internal transport plumbing, not
an operator-tunable durability setting the way the webhook retention window
below is — the assumption is that any client gone longer than a day falls back
to a full resync rather than a replay, so there is little reason to make the
window configurable.

## Outbound webhooks: the same commit hook, a different destination

Webhook dispatch (`dispatch_webhooks()`) is called from the *same*
`transaction.on_commit()` sites that already call `broadcast_board_event()` —
by design, so a new mutation that wants both a live push and a webhook does
not need two separate wiring points. It fans out to both project-scoped and
program-scoped subscriptions in one query, renders the payload per subscriber
according to that subscription's chosen format (a plain pass-through shape by
default, a Slack-attachment shape for Slack subscribers, extensible for future
formats without an OSS schema migration), and — this is the part that matters
for durability — writes a `WebhookDelivery` row **before** ever attempting to
send anything. That row is the outbox: it exists whether or not the
subsequent Celery dispatch succeeds, so a broker outage at the exact moment of
dispatch loses nothing but time.

### Signing

Every delivered body is HMAC-SHA256 signed over its exact serialized bytes,
using a secret unique to that webhook subscription, carried in an
`X-TruePPM-Signature: sha256=<hex>` header. A receiver verifies by recomputing
the same HMAC over the raw body it received and comparing in constant time —
the full verification recipe is in [Webhooks](/features/webhooks/#signature-verification).
Signing happens once, at send time, against the exact payload stored in the
outbox row — not re-rendered on each retry — so what a receiver's
signature check validates is provably identical to what was durably recorded,
which matters for anyone treating the delivery log as an audit trail.

### Retry and backoff

A delivery attempt that fails — network error, non-2xx response — is retried
up to five times with exponential backoff (30s, 60s, 120s, 240s, 480s). Retry
counting is tracked against the delivery row's own attempt count, checked
*before* the task ever asks Celery to retry, rather than against Celery's own
retry-exhaustion machinery — the task manages its own terminal state
(`FAILED`, after the fifth attempt) and returns cleanly rather than letting
Celery's `max_retries` machinery raise on its behalf. Two failure classes are
treated differently: a private or unroutable destination URL fails the
delivery **permanently** with no retry (see the SSRF re-check below); a DNS
resolution hiccup or connection error is treated as transient and retried
normally.

The delivery request itself is made through a redirect-disabled HTTP client, a
deliberate hardening step: a receiver could otherwise return a 307/308
redirect pointed at an internal address, and if the client silently followed
it, a signed payload — and the outbound request making it — would land
somewhere the original destination validation never covered. Refusing to
follow the redirect closes that window; the delivery simply surfaces the
redirect response as a failure instead.

**The destination is re-validated at delivery time, not only at registration
time.** An admin-configured webhook URL is user-supplied input, and the same
SSRF guard [Auth architecture](/architecture/auth/#outbound-requests-are-never-trusted-by-default)
describes for OIDC egress applies here — re-checked on every delivery attempt,
specifically to close a DNS-rebinding window between when a URL was approved
and when it's actually dialed.

### The drain: recovering from a lost dispatch

The one gap the outbox row doesn't close by itself is the moment between
"the row was written" and "the Celery task was actually accepted by the
broker." If the broker is unreachable at that exact instant, the row is
written, marked pending, and nothing dispatches it — until a periodic drain
task, running every 30 seconds, finds any `WebhookDelivery` row that is still
pending with zero delivery attempts and old enough to be considered orphaned,
and re-dispatches it. This is what makes the outbox pattern actually durable
rather than durable-in-the-common-case: the row surviving a broker outage is
only useful if something eventually notices it and tries again.

### Retention

Only **terminal** deliveries (`SUCCESS` or `FAILED`) are purged, on an
operator-configurable retention window — unlike the `BoardEvent` buffer above,
this window is meant to be tuned, because a webhook delivery log is something
an operator may want to keep considerably longer for audit purposes. A
`PENDING` row is never purged, since the drain task above may still need it.

## Two different "dead letter" concepts — don't conflate them

A permanently failed webhook delivery (`WebhookDelivery.status = FAILED` after
five exhausted retries) is **not** the same event, and does not feed the same
system, as the platform's generic Celery task dead-letter mechanism described
in [Dead-letter alerting](/administration/dead-letter-alerting/). That system
— a `FailedTask` row, a structured log line, a signal Enterprise can hook for
off-box alerting, and a Prometheus gauge on `/api/v1/health/dead-letter/` — is
wired from exactly one place today: the scheduling engine's own recompute
task, on exhausted retries. A webhook that fails all five attempts becomes a
row in its own table, visible through its own per-webhook delivery-history
endpoint, and nowhere else — it does not fire the dead-letter signal, does not
appear in the dead-letter gauge, and is invisible to the System Health
dead-letter inspector.

This split is deliberate rather than an oversight to unify: the two failure
domains have different audiences (a workspace admin debugging why their
Slack integration went quiet vs. an operator watching for stuck background
work generally) and different remediation paths (re-registering or fixing a
webhook endpoint vs. requeuing or dropping a dead-lettered background job).
But it is exactly the kind of thing a reader can reasonably assume is unified
when it isn't, so it's worth stating plainly here: **if you are building
operator tooling around failure visibility, a webhook's terminal failure
needs its own instrumentation — it will not show up in the generic
dead-letter surface.**

## Where to go next

- [WebSocket event conventions](/architecture/websocket-events/) — the naming
  rule, envelope, reconnect-replay mechanism, and frozen-contract guarantee
  this page's dispatch mechanism serves.
- [Webhooks](/features/webhooks/) — the subscriber-facing reference: the event
  catalog, payload shape, signature verification recipe, and delivery-history
  endpoint.
- [Dead-letter alerting](/administration/dead-letter-alerting/) — the
  *generic* Celery task dead-letter system this page explicitly distinguishes
  itself from.
- [Architecture Decision Records](/architecture/decisions/) — ADR-0019
  (outbound webhooks), ADR-0083 (format extension and the OSS event-count
  cap), ADR-0089 (the delivery sequence number in the body), ADR-0084 (the
  dead-letter alerting receiver), and ADR-0210 (dead-letter write actions —
  requeue and dismiss) are the primary records behind this page.
