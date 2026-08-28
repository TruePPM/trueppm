# ADR-0914: Presence means "here", not "busy" — no row-level soft locks on the Schedule outline

## Status

Accepted (2026-08-28)

Answers the open question in issue #2721 — *"whether this is worth building at all,
or whether the honest 0.4/0.5 behavior is presence-only"* — with **presence-only**.
Follows [ADR-0046](0046-board-workshop-mode.md) §1, which already made the
advisory-edit-state-not-a-lock call for the Board workshop surface.

## Context

Case 07 of the Project Designer v5 handoff draws a row that someone else is editing
carrying a violet ring and their name. The lock is held on the text field only,
expires after 30 s of inactivity or on disconnect, and structure operations —
select, indent, delete — remain legal around it.

No such mechanism exists. `apps/sync/consumers.py` implements **project-scoped**
presence in a Redis hash under a 60 s TTL re-armed by a per-socket keepalive, and
its own docstring states the semantics: the roster reflects *"who is connected
rather than who is generating traffic"*. There are no row-level locks, no per-field
holds, and no lock expiry. `ProjectConsumer` is deliberately **receive-only** —
client→server frames are silently discarded, and no client sends any.

This is a new subsystem, not a rendering detail, and #2721 notes correctly that it
is absent from the design's build order — which is how it reaches implementation as
a surprise. The decision therefore has to be recorded somewhere the next
implementer will actually meet it, rather than inferred from the absence of code.

Three facts frame the choice:

1. **A soft lock is advisory by construction.** It expires on inactivity, it
   expires on disconnect, and it does not gate the write. A second client can always
   PATCH the row the ring is drawn around. So the ring cannot prevent the conflict it
   appears to prevent — it is a *prediction* that a conflict is unlikely, rendered in
   the visual language of a guarantee.
2. **The real guarantee already exists and is not a lock.** `server_version`
   optimistic locking returns 409 on a stale write, and ADR-0046 §1 fixed the
   handling: *"No automatic merge."* That protection is unaffected by whether a ring
   is drawn, and unimproved by drawing one.
3. **TruePPM already has an accepted design for "who is editing what".** ADR-0046 §1
   is an advisory **edit-state** broadcast — `{"state": "editing" | "idle"}` keyed by
   element id, on a socket where a session was deliberately convened. It is
   explicitly *not* modeled as a lock, and it was chosen over a CRDT precisely because
   the collaborative-editing problem here is small.

**P3M layer:** Programs and Projects.

## Decision

**1. Presence stays project-scoped and keeps meaning "here". No row-level locks ship
in 0.4 or 0.5.** The violet ring in Case 07 is cut, not deferred to a backlog where
it reads as agreed-and-pending.

**2. The honest signal is post-hoc, not predictive.** A planner is told *that a date
changed under them*, after it changed, by the ADR-0784 reconciliation markers —
which state an observed fact and can be evidenced. #3041 extends exactly that
surface to rows the user never touched, which is the same user need Case 07 was
reaching for, answered with something that cannot be wrong.

**3. The data-integrity guarantee is unchanged and is not a lock.** `server_version`
+ 409 + "someone else updated this" is the mechanism. Nothing in this ADR weakens
it, and a soft lock would not have strengthened it.

**4. If Schedule-outline edit-awareness is ever built, it is ADR-0046 §1's advisory
edit-state — not a lock, and never described as one.** Same `state: editing | idle`
shape, same fan-out pattern, riding its own message type rather than the presence
payload so that "who is here" and "what someone is touching" remain separately
truthful. UI copy must not imply exclusivity: "Dana is editing" is a claim we can
support; a lock icon is not.

**5. `ProjectConsumer` stays receive-only.** Row locks require making the project
socket bidirectional, and every open project socket then becomes an unauthenticated-
at-the-frame-level write path into Redis for any Member. That is a real cost that
Case 07's rendering-level framing hides, and it is not being paid for a decoration.

**6. What would reopen this.** Not a design refresh, and not the ring's reappearance
in a handoff. This decision inverts on evidence that concurrent same-row editing is
a *frequent* occurrence rather than an imagined one — a 409 rate on task PATCH high
enough to be a user-visible nuisance, or beta reports of two people repeatedly
overwriting each other on the same outline row. Absent that, the ring is solving a
problem the telemetry does not show.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Presence-only, no locks** (chosen) | Nothing new to be wrong. The roster's claim ("here") is one the server can actually verify. Zero new subsystem, zero new socket surface, zero new failure modes. The real conflict protection is untouched. | The designer's Case 07 does not render as drawn, and two people *can* still edit the same row without any forewarning. |
| **B. Full soft-lock subsystem as drawn** | Matches the handoff exactly. Feels collaborative. | Every failure mode is **silent and wrong in the reassuring direction**: a lock that expired mid-edit shows no ring while the user is still typing; a dropped release leaves a ring on an idle row; a partitioned client holds a ring nobody can clear. A ring that is sometimes wrong is worse than no ring — a planner who once sees a stale ring stops believing every ring after it. Requires a bidirectional project socket, per-row Redis keys, expiry reconciliation, and the partial-lock rule (structure ops legal around a locked row), which is a second correctness problem stacked on the first. |
| **C. Narrow version — text-field lock only, riding the presence payload, no partial-lock rule** | Smaller than B. | Strictly worse than B on the axis that matters: the same silent-staleness failures, plus "who is here" and "what is locked" now share one payload and one TTL, so a presence refresh and a lock expiry cannot be reasoned about separately. It is the cheap version of a thing whose cost is correctness, not code. |
| **D. Advisory edit-state per ADR-0046 §1, now** | Honest framing, existing precedent, no exclusivity claim. | Still needs the bidirectional socket, and still renders a signal that goes stale on disconnect. Worth doing *if* condition 6 fires; not worth doing on a designer's drawing. Recorded as decision 4 rather than rejected outright. |

## Consequences

**Easier**
- `apps/sync/consumers.py` keeps its single, verifiable claim, and stays receive-only.
- No per-row Redis keys, no lock TTL reconciliation, no partial-lock rule, no new
  message type, and no new failure mode to debug in a beta.
- The collaboration story stays coherent: presence answers *who is here*,
  reconciliation markers answer *what moved under you*, `server_version` answers
  *whose write won*. Three mechanisms, three separate questions, none of them
  pretending to answer another's.

**Harder**
- Two planners editing the same row get no forewarning — they get a 409 and a
  reload prompt. That is the pre-existing behavior, not a regression, and it is the
  cost being accepted.
- The Project Designer's Case 07 will not be implementable as drawn, and this needs
  to reach whoever maintains the handoff.

**Risks**
- *The ring returns in a future design revision with no memory of this decision.*
  This is the entire failure mode #2721 identifies — a subsystem reaching
  implementation as a surprise. Mitigated by putting the decision in the consumer's
  own docstring and in the published real-time docs, so it is met by anyone reading
  either, not only by someone who searches the ADR corpus.
- *"Presence-only" gets read as "collaboration is unsolved."* It is not: decision 2
  names the surface that answers the underlying need, and it is shipping.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api` (docstring only), `website` (published real-time docs)
- Migration required: no
- API changes: **no** — this ADR is the decision not to add a WebSocket message type
- OSS or Enterprise: **OSS**. Team-level collaboration on one project is the
  adoption surface; nothing here is cross-program or org-governance.

### Durable Execution

1. **Broker-down behaviour:** N/A — no dispatch is added or changed. This ADR removes
   a prospective subsystem from scope; the presence path it leaves in place is a
   direct Redis hash write inside the consumer, not a queued task.
2. **Drain task:** N/A — no async work introduced, so no new drain and no reuse.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** N/A — no dispatch path added. Presence continues to be handled
   inline in `ProjectConsumer`, which is where it already lives.
5. **API response on best-effort dispatch:** N/A — no endpoint added or changed.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** N/A for new work. The existing presence operations this ADR
   preserves are already idempotent by construction: join is an `HSET` of the same
   field to the same value, leave is an `HDEL`, and the keepalive is an `EXPIRE`
   re-arm — each safe to repeat, which is why a duplicated frame or a replayed
   reconnect needs no guard.
8. **Dead-letter / failure handling:** N/A — no task to fail. The one failure this
   ADR is *about* — a lock that never releases — is avoided by not having locks; the
   presence TTL remains the backstop for a socket that dies without `disconnect`.
