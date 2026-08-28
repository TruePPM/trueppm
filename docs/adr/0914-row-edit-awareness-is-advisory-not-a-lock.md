# ADR-0914: Row edit-awareness on the Schedule outline is advisory, not a lock

## Status

Accepted (2026-08-28)

Answers the open question in issue #2721 — *"whether this is worth building at all,
or whether the honest 0.4/0.5 behavior is presence-only"* — with **neither of the two
options as posed**. Case 07's ring is worth building; the *hold* it draws around the
ring is not. This adopts [ADR-0046](0046-board-workshop-mode.md) §1's advisory
edit-state shape for a second surface rather than inventing a weaker one.

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

### The case draws two things, and only one of them is buildable

Case 07 renders a **signal** and a **guarantee** in a single visual:

- the *signal* — someone else is working on this row right now, and here is who;
- the *guarantee* — the field is held for them, and you cannot type into it.

The signal is a real need and it is cheap to state truthfully. The guarantee is not
buildable at this layer, and the reason is not cost:

1. **A soft lock is advisory by construction.** It expires on inactivity, it
   expires on disconnect, and it does not gate the write. A second client can always
   PATCH the row the ring is drawn around. So the ring cannot prevent the conflict it
   appears to prevent — it is a *prediction* that a conflict is unlikely, rendered in
   the visual language of a promise.
2. **The real guarantee already exists and is not a lock.** `server_version`
   optimistic locking returns 409 on a stale write, and ADR-0046 §1 fixed the
   handling: *"No automatic merge."* That protection is unaffected by whether a ring
   is drawn, and unimproved by drawing one.
3. **TruePPM already has an accepted design for the signal.** ADR-0046 §1 is an
   advisory **edit-state** broadcast — `{"state": "editing" | "idle"}` keyed by
   element id. It is explicitly *not* modeled as a lock, and it was chosen over a
   CRDT precisely because the collaborative-editing problem here is small.

Separating the two is what makes Case 07 shippable. The earlier draft of this ADR
cut the ring along with the hold, on the argument that *"a ring that is sometimes
wrong is worse than no ring."* Decision 5 below explains why that argument is sound
against the hold and unsound against the ring, and it is the reversal this ADR
turns on.

**P3M layer:** Programs and Projects.

## Decision

**1. The ring ships. Case 07 renders, with its violet ring and its name.** It is an
advisory edit-state signal on ADR-0046 §1's shape, on the Schedule outline.

**2. What is cut is the hold, not the ring.** Specifically, and these are the parts
an implementer must not restore from the case: the 30 s inactivity expiry described
as a *lock lifetime*; the per-field hold; and the partial-lock rule (*"select,
indent and delete remain legal, editing does not"*). The ring never gates a write.
No client-side code may refuse, disable, or defer an edit because a ring is present.

**3. Copy and affordance must not imply exclusivity.** *"Dana is editing"* is a
claim about the present that the server can support. *"Locked by Dana"* is not, and
neither is a padlock glyph or a disabled input. The partial-lock rule in the case
exists only to describe which operations the hold blocks; with no hold, it has
nothing to describe and its absence is not a gap.

**4. It rides its own message type, not the presence payload.** Same
`state: editing | idle` shape as ADR-0046 §1, keyed by row id. Keeping it off the
presence payload is what lets *"who is here"* (the 60 s roster) and *"what someone
is touching"* (a much shorter window) stay separately truthful and separately
expirable — the flaw that makes alternative C worse than B.

**5. Staleness is made cheap rather than prevented — and this is the reversal.**

The objection this ADR previously accepted was that a ring which is sometimes wrong
is worse than no ring. That is true of a ring that means *you may not edit this*,
and false of a ring that means *Dana was typing here a moment ago*. The distinction
is what the staleness misleads **about**:

- A stale **lock** misleads about *permission*. Its failure modes are silent in the
  reassuring direction and they change what the user believes they are allowed to
  do: a lock that expired mid-edit shows no ring while someone is still typing, so
  the absence of a ring implies a safety that was never held; a dropped release
  leaves a ring nobody can clear, so a planner waits for a hold that does not exist.
- A stale **signal** misleads about a *fact*, and the worst case is a name a few
  seconds out of date. Nothing the planner is permitted to do changes. This is the
  same contract every presence indicator in the product already ships — the roster's
  own 60 s TTL means it too is routinely a few seconds stale, and that has never
  been an argument against having a roster.

So the mitigation is not to prevent staleness but to keep the cost of it at zero:
the ring never gates a write (decision 2), the copy never claims exclusivity
(decision 3), and the window is short and self-clearing (decision 6).

**6. `ProjectConsumer` becomes bidirectional, and that is the real cost being
accepted.** Every open project socket becomes a Redis write path for any Member.
Case 07's rendering-level framing hides this and #2721 is right to call it a new
subsystem. It is accepted here under bound constraints, all of which the
implementing issue must carry:

- Connect-time auth is unchanged and is the only authorization gate — JWT, role
  ≥ MEMBER, already enforced. This ADR adds no new authz path.
- The consumer validates that the row id resolves to a task **in this project**. A
  frame naming a row outside it is dropped, never fanned out — otherwise the socket
  becomes the cross-project existence oracle that ADR-0772 removed.
- Frame rate is bounded per socket, and over-rate frames are dropped rather than
  queued.
- The payload is a fixed, size-bounded shape. Nothing free-text is fanned out.
- Nothing is persisted. Edit-state lives only in Redis under a short TTL and dies
  with the socket.
- Fan-out never leaves the `project_{pk}` group.

**7. `server_version` + 409 remains the only data-integrity guarantee, and is
unchanged.** Nothing in this ADR weakens it, and the ring does not strengthen it.
The post-hoc ADR-0784 reconciliation markers remain the mechanism that tells a
planner a date moved *under* them — #3041 extends that surface to rows the user
never touched. The ring is forewarning; the markers are evidence. They answer
different questions and neither substitutes for the other.

**8. This ADR decides; it does not implement.** The bidirectional consumer, its
frame validation, and the outline rendering are filed as **#3145** so they arrive with
their own `threat-model` and `security-review` gates rather than inside a docs
change. Nothing in this repository renders a ring until that issue lands.

**9. What would reopen this.** Evidence that the ring is read as a hold despite
decisions 2 and 3 — beta reports of planners *waiting* for a ring to clear before
editing, or support threads describing the outline as locking rows. That would mean
the exclusivity signal is carried by the visual rather than the copy, and the answer
would be to change the visual, not to add the hold.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Presence-only — ship nothing, cut the ring** (chosen in this ADR's first draft, now rejected) | Nothing new to be wrong. Zero new subsystem, zero new socket surface, zero new failure modes. | Leaves a real need unmet and Case 07 unimplemented with no signal at all in its place. Its central argument — *a ring that is sometimes wrong is worse than no ring* — turns out to be an argument against the **hold**, not against the ring (decision 5), so it proves less than it appeared to. |
| **B. Full soft-lock subsystem as drawn** | Matches the handoff exactly. | Every failure mode is silent and wrong in the **permission** direction: a lock expired mid-edit shows no ring while the user still types; a dropped release leaves a ring nobody can clear. Requires the partial-lock rule, which is a second correctness problem stacked on the first. Renders a guarantee the layer cannot make. |
| **C. Narrow — text-field lock only, riding the presence payload, no partial-lock rule** | Smaller than B. | Strictly worse than B on the axis that matters: the same silent-staleness failures, plus *"who is here"* and *"what is locked"* now share one payload and one TTL, so a presence refresh and a lock expiry cannot be reasoned about separately. The cheap version of a thing whose cost is correctness, not code. |
| **D. Advisory edit-state per ADR-0046 §1** (chosen) | Honest framing with an existing accepted precedent rather than a second, weaker invention. Renders Case 07's signal. No exclusivity claim, so staleness degrades to noise instead of to a false guarantee. | Still needs the bidirectional socket — the one genuine cost, accepted under decision 6's constraints. The signal still goes stale on disconnect; decision 5 is the argument that this is acceptable here and would not be for a lock. |

## Consequences

**Easier**
- Case 07 is implementable, so the handoff and the code stop disagreeing.
- The collaboration story stays coherent and each mechanism answers exactly one
  question: presence answers *who is here*, edit-state answers *what someone is
  touching now*, reconciliation markers answer *what moved under you*, and
  `server_version` answers *whose write won*. None of them pretends to answer
  another's.
- Reusing ADR-0046 §1's shape means the Board and Schedule surfaces share one
  protocol and one set of semantics rather than two.

**Harder**
- `ProjectConsumer` stops being receive-only, which is a genuine expansion of the
  socket's attack surface and the reason decision 6 binds constraints rather than
  waving at them.
- Two planners editing the same row still get a 409 and a reload prompt if they both
  commit. The ring reduces how often that surprises someone; it does not remove it,
  and copy must not suggest it does.
- The short edit-state TTL and the 60 s presence TTL are now two windows to reason
  about. Decision 4 keeps them separable, which is the mitigation, not a fix.

**Risks**
- *The hold returns in a future design revision with no memory of this decision.*
  This is the failure mode #2721 identifies — a subsystem reaching implementation as
  a surprise. Mitigated by putting the decision in the consumer's own docstring and
  in the published real-time docs, so it is met by anyone reading either, not only by
  someone who searches the ADR corpus. Decision 2 names the three specific pieces
  that must not come back.
- *The visual carries exclusivity even though the copy does not.* Decision 9 is the
  falsification line, and the remedy is the visual rather than the hold.
- *This ADR was written without access to the handoff itself.* Case 07 is described
  here from #2721's account of it, which is the code-verified scope rather than the
  screens. If the case's own copy says "locked" in words, decision 3 is a larger
  change to the design than it appears and should be confirmed with whoever maintains
  the handoff before implementation starts.

## Implementation Notes

- P3M layer: Programs and Projects
- Affected packages: `api` (docstring only in this change), `website` (published
  real-time docs)
- Migration required: no
- API changes: **no in this change.** The decided message type ships with the
  implementing issue, not here.
- OSS or Enterprise: **OSS**. Team-level collaboration on one project is the
  adoption surface; nothing here is cross-program or org-governance.

### Durable Execution

1. **Broker-down behaviour:** if Valkey is unreachable, edit-state frames are dropped
   and no ring renders — the surface degrades to exactly today's behavior. It must
   never block or delay the task write path, which does not consult it.
2. **Drain task:** N/A — fan-out is a synchronous channel-layer `group_send`, the
   same path presence already uses. No queued task is introduced.
3. **Orphan window:** N/A — no outbox rows. Edit-state is never persisted.
4. **Service layer:** handled inline in `ProjectConsumer` alongside presence, which
   is where the existing analogous code lives.
5. **API response on best-effort dispatch:** N/A — no endpoint added or changed.
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** a repeated `editing` frame for the same (user, row) is an `HSET`
   of the same field to the same value; a repeated `idle` is an `HDEL` of an absent
   field. Both are safe to repeat, so a duplicated frame or a replayed reconnect
   needs no guard.
8. **Dead-letter / failure handling:** no task to fail. A socket that dies without
   sending `idle` is cleaned by the same TTL mechanism that already backstops
   presence. Expiry here is a *correct* outcome rather than a failure — under
   decision 2 an expired ring costs nothing, which is the whole point of decision 5.
