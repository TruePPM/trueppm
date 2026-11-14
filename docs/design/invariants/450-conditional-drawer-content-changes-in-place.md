# Rule 450 — Conditional drawer content changes in place

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text (#4892). Binding on every surface it names.

Conditional drawer content changes in place: a section that stops qualifying mid-session (a task leaving the critical band) shows a "no longer" state until the drawer closes or the task changes; it is never unmounted under the reader (#4892).

**Origin.** Written with the Schedule drawer's "Why critical" section (#4892), whose design (ux-design, 2026-11-14) surfaced it. It applies to any later surface of the same shape, not only that one.
