# Rule 477 — A wide data grid collapses to a one-slice list on a phone, never to a horizontal scroll

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**A grid whose width comes from a column axis (days, sprints, resources) renders one slice of that axis at a time below `md`, with a stepper to move along it, rather than scrolling horizontally.** The weekly timesheet is the reference: seven day columns need ~50rem, so a phone gets the selected day's task list (`TimesheetDayList`) and a Previous/Next day stepper, and the grid component stays desktop-only.

- The phone view reuses the grid's cell component, so read-only reasons, inline server rejections and input parsing do not fork.
- Every control in the phone view, including the cell input and the stepper buttons, is at least 44px (rule on touch targets); a cell that is 36px on desktop gets `max-md:h-11`.
- Stepping past either end of the slice moves to the adjacent page of the axis (past Monday, to the previous week), so the stepper never dead-ends.
- A phone surface that writes while offline says what the write survives: TanStack mutations pause offline and resume on reconnect, but nothing persists across a reload, so the copy must not promise more.
- A top-bar control added for phones must be checked against `mobile-chrome-clip.spec.ts`: the v1 phone bar has no spare width, and a new control there overflows it at 375px. Put it in the v2 shell bar, or yield width from a named existing control.
