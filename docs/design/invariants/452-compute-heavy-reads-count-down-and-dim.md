# Rule 452 — A compute-heavy read counts down on a 429 and never auto-retries; a refresh dims, never skeletons

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text (#4892). Binding on every surface it names.

Compute-heavy reads: a 429 shows a visible countdown from `Retry-After` and never retries automatically; a refresh dims stale content to 55% with its provenance line at full strength and never swaps in a skeleton (#4892).

**Relationship to rule 444.** This is the compute-heavy carve-out from [rule 444](444-a-failed-read-states-why-it-failed.md), whose "a 429 counts down and retries itself" is scoped to ordinary reads. A compute-heavy read (`cpm_on_read` throttle scope, `mcp_compute_heavy`) shows the countdown and a manual **Retry now**, but never fires `onRetry` on its own.

**Origin.** Written with the Schedule drawer's "Why critical" section (#4892), whose design (ux-design, 2026-11-14) surfaced it. It applies to any later surface of the same shape, not only that one.
