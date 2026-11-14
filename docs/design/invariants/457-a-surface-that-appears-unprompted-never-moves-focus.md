# Rule 457 — A surface that appears unprompted is a status region and never moves focus

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it (#4316).

**When the app changes state on its own (a session ending, a connection dropping, a sibling tab's message), the surface that reports it is a `role="status"` region and leaves focus where the user is; only a surface the user summoned, or one that blocks the screen behind a focus trap, takes focus.** The session-expired quiet banner is the case: with no write at stake the session ends under a user who may be mid-keystroke in a field, and moving focus to "Sign in again" would swallow their next keypress. The blocking modal may take focus because it traps it and says why. The banner re-seats focus only when the user chose it ("Continue viewing"), which is the `focusReadOnlyBar` flag, and a state applied from a sibling tab's broadcast never sets it.

A first refused action in a degraded mode gets a light cue (a toast), and only a repeat escalates to a blocking surface: a misclick on an editable cell must not snap a full-viewport modal over the screen.
