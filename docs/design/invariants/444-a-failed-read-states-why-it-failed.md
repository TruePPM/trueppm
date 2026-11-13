# Rule 444 — A failed-read state says WHY it failed: a 403 offers no Retry, a 429 counts down and retries itself, everything else keeps the generic message

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text (#3874, #3621). Binding everywhere a TanStack Query read can fail.

**Pass the query's `error` to `QueryErrorState`** (`error={error}`) wherever the surface has one. The component reads it through `classifyQueryError` (`lib/queryErrorKind.ts`) and renders the one honest state per server verdict:

| Failure | State | Why |
|---|---|---|
| 403 | "You don't have access to this." + the access-changed help line; **no Retry button** | The identical request fails identically forever; Retry is a false promise. |
| 429 | "Too many requests. Retrying in Ns." with a **Retry now** button; fires the caller's `onRetry` once at zero | It is a verdict about *now*. Auto-retry only through a caller-supplied `onRetry`: the default retry is a full page reload and never fires on a timer. `Retry-After` is honored (clamped to 60 s, default 5 s). |
| anything else (5xx, network) | The caller's `message` + Retry | Unchanged. |

A read whose 429 or 403 falls through to the empty branch is the rule-301 shape: a client-side reading of a server verdict taking the neutral branch.
