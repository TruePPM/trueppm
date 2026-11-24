# Rule 466 — A refused agent verdict is a neutral outline chip, never red; a control the server enforces is shown, not decided, by the UI

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#4814).

**An agent verdict renders as glyph + word. "Refused" is a neutral outline chip with ⊘ and the word, and names the guard that fired when one is known ("Refused · paused"). It is never red: red is critical or blocked only (Pass 2), and a refusal is the system working. Where the server enforces a limit — an agent's pause, its capability scope, a level not grantable in this release — the UI shows the server's state and sends the request; it never hides the control as the enforcement, and a disabled cell carries a visible reason ("Write · ◌ Ships in 0.6").**

**Why.** A red refusal reads as an outage, which teaches people to fear the guard that protected them. A UI that decides an authorization question locally drifts from the server that actually decides it, and the drift is invisible until someone crafts the request by hand.

**How to apply.**

- (a) Use `VerdictChip` (`src/features/agents/agentWords.tsx`); do not hand-roll a verdict color.
- (b) A disabled grant cell keeps its column header's reason in its `aria-describedby`.
- (c) Mutations show the server's refusal message verbatim and say "Nothing was changed" when the server refused.

Reference: `src/features/agents/AgentsPage.tsx`, `packages/api/src/trueppm_api/apps/projects/agent_scope.py`.
