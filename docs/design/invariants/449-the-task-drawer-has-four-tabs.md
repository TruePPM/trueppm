# Rule 449 — The task drawer has four tabs (Details · Subtasks · Activity · Files). A new drawer surface is a Details section unless an ADR adds a tab, so e2e tablist assertions stay state-independent

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text (#4892). Binding on every surface it names.

The task drawer has four tabs (Details · Subtasks · Activity · Files). A new drawer surface is a Details section unless an ADR adds a tab, so e2e tablist assertions stay state-independent (#4892).

**Origin.** Written with the Schedule drawer's "Why critical" section (#4892), whose design (ux-design, 2026-11-14) surfaced it. It applies to any later surface of the same shape, not only that one.
