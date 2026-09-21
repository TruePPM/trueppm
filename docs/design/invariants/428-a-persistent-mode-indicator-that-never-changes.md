# Rule 428 — A persistent mode-indicator bar that never changes during a session carries no `aria-live`

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Accessibility floors*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**A banner that states a fixed property of the session — the deployment is a read-only demo, this build is a preview, this workspace is suspended — is an `<aside aria-label="…">`. It gets no `aria-live` and no `role="status"`.**

Two reasons, and the second is the one that gets missed. First, a live region announces *changes*, and this one has none: it is present from first paint to last, so the region can only ever fire on mount, where the page's own load announcement already covers it. Second, and more damaging: a live region on standing chrome **competes with the live region that carries the session's real announcements**. On the Schedule that is the assertive region `ScheduleView` owns, through which the demo's own refusal speaks ("Not saved. This is a read-only demo…"). Two regions racing is how an announcement gets dropped, and the one that gets dropped is the one that mattered.

`<aside aria-label>` is what replaces it: a landmark gives the bar findability in a landmark list without claiming it will speak again.

**Responsive copy stays in ONE text node.** Where a mode bar has a short base sentence and a longer pitch, the pitch is a `<span className="hidden md:inline">` *inside the same node*, not a second conditionally-rendered element. The truncation is then visual only — assistive technology reads the whole sentence at every width — and there is no breakpoint at which a screen-reader user hears less than a sighted one.

**Render nothing while the mode is unresolved.** Gate on the query's `isLoading` as well as the flag, so a normal install never flashes a banner it takes back on the next tick.
