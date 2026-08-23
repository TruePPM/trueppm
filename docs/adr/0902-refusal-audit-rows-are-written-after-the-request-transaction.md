# ADR-0902: Refusal audit rows are written after the request transaction, not inside it

## Status
Accepted

## Context

Issue #3017. The agent-action audit log — the answer to *"what did this agent try?"* —
contained **only successes**. Measured against `main`:

| Request | Status | `AgentAction` rows |
|---|---|---|
| `GET /projects/{id}/overview/`, project opted out (`McpProjectEnabled`) | 403 | **0** |
| `GET /programs/{id}/export/`, child opted out (`McpProgramExportConsent`) | 403 | **0** |
| `GET /projects/{id}/overview/` with a **revoked** token | 401 | **0** |
| `GET /me/work/` (allowed) | 200 | 1 |

The third row is not in the issue — it was found while fixing it, and it matters because
`_audit_identity_refusal`'s docstring asserted the opposite: *"DRF turns that into a 401
response, so the transaction still commits and the audit log row survives."* It does not.
Both refusal producers were broken, by one mechanism.

**The mechanism.** `DATABASES["default"]["ATOMIC_REQUESTS"] = True` wraps every view in a
transaction, and DRF's `exception_handler` calls `set_rollback()` for **every**
`APIException`. Both producers run inside that block — `finalize_response` for a policy
denial, the authenticator for an identity denial — so each executed its `INSERT` and then
had it discarded when the request unwound. Nothing failed, nothing logged: the write
simply did not survive.

**What this falsified.** Three documented properties, each stated somewhere a reader would
trust:

- **ADR-0112 RC1** — "an `allowed` read and a `policy` refusal are both audited exactly once".
- **ADR-0678 T8** — the consent-scoped / refusal audit trail.
- **ADR-0809 (#2689)** — the refusal *taxonomy*. Its caller-facing half works: the 403 body
  carries `{"refusal": {"verdict": "refused", "reason": "policy", "constraint":
  "capability_scope"}}`, so the agent is told why. Only the durable operator-side record
  was lost — the half an auditor reads.

An operator reviewing the log saw a clean record of permitted reads and no evidence
whatsoever that an agent had repeatedly probed projects which had closed themselves to it,
which is precisely the behavior the log exists to make visible.

**P3M layer:** cross-cutting audit substrate — OSS. The Enterprise counterpart is the
notarized/signed archive (#146), which is unaffected by this and would have notarized an
incomplete log.

### The constraint that rules out the obvious fixes

`AgentAction` is **hash-chained**: each row carries `prev_hash` and a `record_hash`
computed over its predecessor's hash and its own canonical body, and `audit_verify` walks
the chain asserting the sequence is gap-free and every link recomputes. Two writers racing
on that chain is a correctness problem, not a contention one.

`record_agent_action` is the single writer, and it stays single by taking
`select_for_update()` on a singleton `AgentActionChainHead` row for the duration of each
append. Any fix must not add a second writer, and must not weaken that lock.

## Decision

**Defer the refusal write to after the request transaction closes; keep the allowed write
inline.**

`queue_agent_action(request, **kwargs)` (`apps/agents/deferred.py`) stashes the
fully-resolved kwargs on the underlying Django `HttpRequest`.
`AgentActionAuditMiddleware` (`apps/agents/middleware.py`), placed **last** in
`MIDDLEWARE`, drains the queue on the way out.

This works because **`ATOMIC_REQUESTS` wraps only the view callable** — Django's
`BaseHandler._get_response` applies `transaction.atomic()` to the callback, not to the
middleware chain. By the time a middleware processes the response, the request transaction
has already committed or rolled back and the connection is back in autocommit, so
`record_agent_action`'s own `transaction.atomic()` opens a fresh transaction that commits
independently of whatever the request did.

Three properties this preserves deliberately:

1. **One writer, one lock.** `record_agent_action` is still the only writer and still
   serializes on the chain head. Deferring changes *which transaction* the append runs in,
   not *what orders* it. Two requests draining concurrently interleave exactly as two
   inline appends would.
2. **Allowed reads stay fail-closed.** An allowed read is written inline, inside the read's
   own transaction: if the audit cannot persist the exception propagates and the request
   500s, because an audit substrate must never serve a read it could not record.
3. **Refusals stay best-effort.** A refusal is already the safe outcome; a failed audit
   write must never convert a 401/403 into a 500. Failures are logged and swallowed.

**The asymmetry between 2 and 3 is forced, not stylistic.** An allowed read has something
to be atomic *with* — the data it served. A refusal served nothing, so there is nothing
for its audit row to be atomic with, and the only transaction it could join is the one
guaranteed to roll back.

## Alternatives considered

**A second database connection in autocommit.** Add a `DATABASES` alias pointing at the
same database and write the audit row through it, so the request rollback cannot reach it.
Rejected: it introduces a second writer to a hash-chained table. The row-level
`select_for_update` would still serialize the two connections at the database level, so it
is not *unsound* — but it doubles the connection pool for every request that refuses, and
it makes the "single writer" property an emergent consequence of Postgres locking rather
than something readable in the code. It also needs a `TEST: {"MIRROR": ...}` alias whose
behavior under `TestCase`'s transaction wrapping is a standing trap.

**A durable outbox drained by Celery.** Rejected outright: the outbox row would be written
in the same request transaction and rolled back with it. The pattern solves *delivery*
after commit; here there is no commit. Making it work needs an out-of-transaction write
first — which is this ADR, at which point the worker adds latency and a broker dependency
to an audit substrate for no gain.

**Suppress `set_rollback` for these paths.** Rejected: it is DRF-wide behavior reached
through the exception handler, and unwinding a refused request's writes is correct. The
audit row is the exception, not the rule.

## Consequences

- A refused agent call now leaves a durable, hash-chained row with its reason and
  constraint, so `GET /agent-actions/?constraint=…` and the Agents panel show refusals for
  the first time. The three ADR properties above become true rather than aspirational.
- Refusal rows land a few milliseconds after the response is generated (still within the
  same request). `occurred_at` is stamped by `record_agent_action` at write time; the
  middleware sits last in `MIDDLEWARE` so its response half runs first, keeping that gap
  as small as a middleware can.
- **A refusal audit is not durable across a process kill** between the response and the
  drain. This is a real narrowing versus a true outbox and is accepted: the alternative
  costs a broker round-trip on the refusal path, and the window is sub-millisecond.
- The identity-refusal DoS bounds (unknown hash → no write; a known dead token audited at
  most once ever via an indexed `exists()`) are unchanged — they gate *queueing*, and the
  gate reads committed state, which the deferred write still produces.
- `_audit_identity_refusal`'s docstring and `finalize_response`'s docstring both asserted
  the old, false behavior. Both are corrected in the same change; a docstring that
  confidently describes a property the code does not have is how this survived.

## Related

- ADR-0112 (agent-action audit, hash chain), ADR-0361 (chain-aware prune), ADR-0421
  (refusal detail side-car), ADR-0678 T8 (consent-scoped audit), ADR-0809 (refusal taxonomy)
- #3014 — where the defect was found; its test asserts the disclosure envelope rather than
  the audit row, with a pointer to #3017
- #3001, #2995 — the opt-out bypasses whose refusals this log was supposed to record
