# Rule 468 — On the shell v2 phone Board a card moves by a per-card "Move to…" disclosure, and the board mounts the offline driver

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Board*. The index carries the rule's headline; this file carries its full text (#5105).

**On the phone layout every card carries a 44px `Move to…` button that discloses the other columns as 44px buttons; choosing one calls the same `move` the keyboard pick-up uses (`useUpdateTaskStatus`). The button is absent on desktop and for roles that cannot write. Any board page that tells the user a move is "queued" must mount `useBoardOffline(projectId)`.**

**Why.** The phone has no drag and no hardware keyboard, so the Space-arrow pick-up was unreachable. The offline banner promised queued moves would sync on reconnect, but the v2 page did not mount the hook that hydrates and flushes the outbox, so a queued move never left the device until the v1 board was opened. A promise on the page needs the driver that keeps it.

**How to apply.** Route every new move entry point through the page's single `move` so the optimistic patch, rollback, queue and broadcast stay one path. Reference: `v2/Board2Card.tsx`, `v2/Board2Page.tsx`; the replay is asserted in `e2e/board-v2.spec.ts`.
