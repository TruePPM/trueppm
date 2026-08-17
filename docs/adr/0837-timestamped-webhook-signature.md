# ADR-0837: Timestamped Webhook Signatures, With the Body-Only Recipe Kept Through 1.0

## Status

Accepted — 2026-08-17, implemented by #2885 in the same MR (verified: `_sign()`
and the header construction in `apps/webhooks/tasks.py`, the published recipe in
`packages/website/src/content/docs/features/webhooks.md`, covered by
`tests/apps/webhooks/test_webhook_reliability.py`).

For 0.4. Relates to ADR-0049 (the integrations egress and credential-at-rest
chokepoint) and ADR-0083 (the outgoing format registry, which owns rendering while
this ADR owns signing).

## Context

Outbound webhook deliveries have been signed since 0.1 with

```
X-TruePPM-Signature: sha256=HMAC-SHA256(secret, raw_body)
```

The HMAC covers the serialized body and **nothing else**. No timestamp is sent in
any header. That signature is therefore valid forever: an attacker who captures one
delivery — from a proxy log, a misconfigured receiver, a TLS-terminating appliance
— can replay the exact bytes at the receiver at any point in the future and the
signature still verifies.

`X-TruePPM-Delivery` is a stable UUID across retries, which is genuinely useful: a
receiver that stores seen ids will not *process* a replay twice. But that is
idempotency, not replay *detection*, and it depends entirely on the consumer having
built a durable seen-id store. The docs pushed that burden onto the consumer without
saying so. Nothing in the protocol lets a receiver distinguish "TruePPM sent this
just now" from "somebody sent this back to me six months later".

The industry-standard remedy is well established (Stripe, GitHub, Slack): sign the
timestamp together with the body, publish it *inside* the signed value, and have the
consumer reject anything outside a tolerance window. Because the timestamp is part of
the signed material, an attacker cannot move it forward without the secret.

The timing forces the decision now. 0.4 is TruePPM's **first beta**. Whatever
verification recipe 0.4 publishes is what integrators will build against and what we
will be reluctant to change afterwards. Landing this in 0.5 means asking every
receiver written during the beta to be rewritten; landing it after 1.0 means a
breaking change to a stable contract.

## Decision

**Emit both signatures on every delivery. The timestamped one is the published
recipe; the body-only one is deprecated and removed at 1.0.**

Every delivery carries:

```
X-TruePPM-Signature-V2: t=<unix>,v1=HMAC-SHA256(secret, "<unix>.<raw_body>")
X-TruePPM-Signature:    sha256=HMAC-SHA256(secret, raw_body)     # deprecated
```

**The timestamp is published only inside the signed header.** An early draft of this
change also sent a standalone `X-TruePPM-Timestamp` as a convenience, and the docs
recommended reading it to bound the replay window before doing HMAC work. That is
the alternative this ADR's own table rejects, reintroduced: the copy is
unauthenticated, so whoever replays a capture edits that one header to "now", the
freshness check passes, and the HMAC still verifies over the original `t`. The entire
protection would be voided by a one-header edit. The header was removed before merge;
do not re-add it as an ergonomics improvement.

Five sub-decisions, each of which could have gone the other way:

1. **A new header name, not a new format in the old header.** Changing what
   `X-TruePPM-Signature` contains would break every existing receiver on the day
   0.4 lands — a silent, total verification failure with no diagnostic. A new
   header is inert to a receiver that does not read it.

2. **Stripe's `t=…,v1=…` grammar.** `v1` names the *HMAC scheme inside the header*;
   the header name carries the recipe version. This is mildly confusing read
   literally, and we accepted it anyway: an integrator who has written a Stripe
   verifier can transcribe it, and matching a grammar thousands of developers have
   already implemented is worth more than an internally tidier one nobody
   recognizes. The docs state the distinction explicitly.

3. **The timestamp is recomputed on every attempt, not once per delivery.** The
   five attempts execute at t = 0, 30, 90, 210, 450 seconds — a 450-second (7.5
   minute) span. A timestamp fixed at first-attempt time would put the final attempt
   150 seconds outside the recommended 300-second window, so that window would
   reject exactly the redeliveries that matter most. Per-attempt signing means the
   two mechanisms cannot fight, regardless of chain length, broker backlog, or
   worker starvation — the timestamp is stamped at execution, not at enqueue.

4. **A dual-emission window rather than a clean break.** Alternatives considered
   below.

5. **One key, two schemes, and no domain separation between them.** A captured V2
   signature is, by construction, a valid *legacy* signature for the body
   `"<t>.<original body>"`. This is accepted rather than fixed: the crossover runs in
   one direction only (a legacy signature can never become a V2 one, because a body
   never begins with a digit followed by `.`), that body is not valid JSON so a
   receiver rejects it at parse, and an attacker holding the V2 signature already
   holds the legacy one from the same capture. The fix — a per-scheme derived key —
   would break the recognizability that sub-decision 2 is spending its budget on.
   Revisit if a third scheme is ever added; three schemes on one key is a different
   risk profile from two.

**Tolerance is the consumer's to enforce; we recommend 300 seconds and document
it.** The server cannot enforce a window on its own outbound request. This is the
honest boundary: the timestamp makes replay *detectable*, and the consumer's window
is what makes it *rejected*. The docs say both steps are required, because a
consumer who implements only the HMAC half has gained nothing over the old recipe.

**Removal target: 1.0.** Named in the docs, not left open-ended. A deprecation with
no end date is a permanent second code path.

## Consequences

**Positive.** The replay window shrinks from "forever" to the consumer's tolerance.
The recipe integrators build against during the beta is the one that survives to
1.0. No existing receiver breaks — the deprecation window costs one extra header on
the wire and zero receiver changes.

**Negative.** Two HMACs are computed per attempt (negligible next to the HTTP round
trip) and two headers are sent. More importantly, for the duration of the window
V2's replay bound is **advisory rather than binding**: both signatures come from the
same key and the legacy one is valid forever, so whoever replays a capture can strip
the V2 header and present the legacy one. A receiver written in the shape
"V2 if present, else V1" — the natural shape for a migrating receiver, and the one
"no existing receiver breaks" invites — therefore gains nothing. There is no
server-side lever that closes this before 1.0 removes V1 (a per-webhook "V2 only"
opt-in was rejected above), so the mitigation is documentation: the docs carry an
explicit fail-closed caution telling a migrated receiver to reject any delivery
without V2, and never to fall back on the legacy header's presence. Stated plainly:
until 1.0, this change makes replay *detectable by a correctly-written receiver*; it
does not make it *impossible*.

**Follow-through this ADR commits to.** The removal at 1.0 is the whole basis for
"dual emission is not a permanent second code path". If 1.0 ships with
`X-TruePPM-Signature` still emitted, this decision quietly became "we support two
recipes forever" without anyone deciding that. The removal belongs on the 1.0
release checklist, and the deprecation table in `features/webhooks.md` is the thing
to grep for.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Replace the old header's contents in 0.4** | Cleanest end state, unacceptable transition. Every receiver written against 0.1–0.3 fails verification the moment the operator upgrades, and the failure surfaces as "webhooks stopped working" with nothing pointing at the signature. A beta is exactly when adopters are least equipped to debug that. |
| **Defer to 1.0** | The problem is not the change, it is *when*. Deferring means the first beta publishes a recipe we already know is replayable, integrators build against it for the whole beta cycle, and the breaking change lands on a stable contract instead of a pre-1.0 one. Strictly worse timing. |
| **Add `X-TruePPM-Timestamp` alone, leaving the HMAC over the body only** | Superficially attractive — one header, no second HMAC. But an unsigned timestamp is worthless: the attacker replaying the capture simply sets the header to now. The timestamp has to be *inside* the signed material or it protects nothing. This is worth reading twice, because the first implementation of this ADR shipped that header *alongside* the signed one as a convenience and the docs pointed consumers at it — which reproduces the flaw exactly. See the note under Decision. |
| **Per-webhook opt-in flag for the new recipe** | A migration switch, a settings surface, a serializer field, and a support question ("which mode is this webhook in?") — for a transition that dual emission handles with no state at all. Configuration that exists only to sequence a rollout tends to outlive the rollout. |
| **Rely on `X-TruePPM-Delivery` + consumer-side seen-id storage** | This is the status quo, and it is idempotency rather than replay detection. It requires every consumer to build durable storage, gives no signal at all to one who has not, and cannot distinguish a legitimate retry from a hostile replay — the delivery id is identical in both. |
