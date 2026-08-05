# ADR-0809: The Refusal Taxonomy on the Wire, Behind a Disclosure Allow-List

## Status

Accepted — 2026-08-05, implemented by #2689 in the same MR (verified: the
`refusal` envelope built in `apps/agents/refusal.py` and attached in
`core/exception_handlers.py`, the guard marks in `apps/access/permissions.py`
and `apps/projects/authentication.py`, and the client-side `Refusal` on
`packages/mcp/src/trueppm_mcp/client.py`, covered by
`tests/apps/agents/test_refusal_disclosure.py` and `packages/mcp/tests/test_refusal.py`).

For 0.4. Extends ADR-0112 (the agent-action record) and ADR-0421 (the non-hashed
refusal side-car) to the one party neither of them reached: the caller that was
refused.

## Context

The API models a genuine two-axis refusal taxonomy and records it on every
refused agent call:

- `AgentActionRefusalReason` — the coarse axis, `identity` | `policy`
- `RefusalConstraint` — the finer axis, which specific guard fired

Both are written, hash-chained, and queryable. Neither reached the caller. The
guards return `False`, DRF renders `PermissionDenied.default_detail`, and the
operator sees a bare HTTP status. To learn the actual reason they had to make a
**second, separate call** to `GET /agent-actions/?constraint=…` — not an
ergonomic wart, but the only channel that existed.

This is load-bearing for the 0.4 positioning. "Computed, not guessed" names
**refuse** as one of its four parts. For the persona the release is sold on, a
system that fails without saying why is the worst outcome — and an agent cannot
correct a call it was not told the shape of.

The issue as originally filed said "no API change required — the data is already
in the response." It is not. Both live `record_agent_action` call sites pass the
verdict and constraint as arguments to the **audit writer only**; nothing
serializes them into any HTTP response. The API half is the larger half.

## Decision

**1. A `refusal` envelope on 401/403, for token callers only.**

```json
{
  "detail": "You do not have permission to perform this action.",
  "refusal": { "verdict": "refused", "reason": "policy", "constraint": "capability_scope" }
}
```

`verdict` is included although it is constant for a refusal, so a client branches
on one field across the whole taxonomy rather than inferring the verdict from the
presence of the envelope — and so the wire shape lines up with the `AgentAction`
row it describes.

**Scoped to token callers.** A human JWT/session 403 is byte-identical to before.
This is therefore not a contract change for the web client, and it does not put
an agent-governance concept in front of a person who is not an agent.

**2. The guards keep returning `False`; they *mark* the request.**

A denying guard records `(reason, constraint)` on the request and returns `False`
as before; the envelope is attached centrally in the DRF exception handler. Three
reasons:

- the guards are fail-closed by construction, and a richer body is not worth
  restructuring them for;
- a guard that forgets to mark still refuses — it refuses with the generic
  detail, which is exactly the pre-existing behavior, so the failure mode of this
  mechanism is *less* explanation, never less enforcement;
- one attachment point means one place to audit for leaks.

The mark is also what the audit hook now reads, replacing its hardcoded
`capability_scope` for any 4xx. **The wire and the hash-chained record are built
from the same tuple**, so they cannot disagree about why a call was refused — and
the record is the one that has to be defensible.

**3. Disclosure is an allow-list, and it is the security decision here.**

Only `TOKEN_IDENTITY` and `CAPABILITY_SCOPE` are serialized. Both describe the
**caller's own credential** and disclose nothing about any resource — the caller
supplied the token, so naming it tells them nothing new.

The four reserved constraints — `GRAPH_VALIDATION`, `SPRINT_SOVEREIGNTY`,
`ROLLUP_LOCK`, `ENGINE_REFEREE` — describe the **plan**. A constraint naming a
sprint or a rollup the caller may not read is an information leak. They have no
producer today (they are reserved for the 0.6 gated-write surface, ADR-0362 §7),
so this costs nothing now and forces the question to be answered per constraint
when 0.6 wires them. A withheld constraint degrades to reason-only, never to
silence.

The `detail` string is unchanged, so enumeration resistance is preserved: a
revoked token, an expired token and a token that never existed remain
indistinguishable.

**4. The client raises with the refusal attached, and tolerates its absence.**

`ApiError`/`AuthError` gain a common base carrying `refusal: Refusal | None`, and
the message gains a suffix (`… — policy refusal (capability_scope)`). Parsing is
total: a body that is not JSON, not an object, or carries no usable `refusal`
yields `None`. A malformed envelope must never turn a clean 403 into a
client-side crash — the status is still the answer, and the envelope is
additional explanation. `None` means "no reason given", which is also what an
older server produces.

## Alternatives considered

| Option | Why not |
|---|---|
| Have the guards `raise PermissionDenied(detail={...})` | Restructures every fail-closed guard for a body, and moves leak review from one place to many. The marking approach gets the same wire result with the guards untouched. |
| Disclose every constraint | Four of the six describe the schedule. Wiring them in 0.6 would then leak plan structure by default, and the leak would arrive in an unrelated MR. |
| Withhold everything on a non-disclosable constraint | Loses the coarse axis for no gain — `reason` is already implied by the status code, and dropping it would leave 0.6's engine refusals as unexplained as today's. |
| Add the envelope to every 401/403 | A contract change for the web client, and it hands an anonymous prober a slightly better oracle for nothing. |
| Leave it to the client to make the second `/agent-actions/` call | The status quo. It requires a second round-trip, a second capability, and knowledge of which row corresponds to the call that just failed. |

## Consequences

- **Easier:** an agent operator learns why a call was refused from the refusal
  itself. The MCP client surfaces it in the raised exception, so it reaches the
  model's context without a second tool call.
- **Easier:** the audit row and the response can no longer diverge, because they
  read the same marks.
- **Harder:** the error body is now something clients depend on. Adding a
  constraint to the allow-list is a disclosure decision, and the test that
  enumerates the withheld four is written to fail when one is added — deliberately,
  so the decision is made rather than inherited.
- **Unchanged:** enforcement. Nothing about who is refused changes; only what
  they are told. The guards' return values, the fail-closed ordering, and the
  audit's replay bounds are all as before.
- **Limit worth stating:** only the two token-shaped constraints have producers,
  so the taxonomy an operator can actually observe is two codes, both about the
  credential, neither about the schedule. Wiring the four schedule constraints is
  separate work and must not be read off this record.

## References

- ADR-0112 — the agent-action record and its refusal vocabulary
- ADR-0421 — the constraint/impact side-car, and why it sits outside the hash
- ADR-0362 §4/§7 — the 0.6 refusal engine that will produce the reserved four
- #2689 — this change; #2642 — the provenance envelope, deliberately separate
- #2749 — the ungoverned `legacy:full` write path, which produces no record at all
