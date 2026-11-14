# Rule 452 — A compute-heavy read counts down on a 429 and never auto-retries; a refresh dims, never skeletons

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text (#4892). Binding on every surface it names.

Compute-heavy reads: a 429 shows a visible countdown from `Retry-After` and never retries automatically; a refresh dims stale content to 55% with its provenance line at full strength and never swaps in a skeleton (#4892).

**Origin.** Written with the Schedule drawer's "Why critical" section (#4892), whose design (ux-design, 2026-11-14) surfaced it. It applies to any later surface of the same shape, not only that one.
