# Rule 441 — A destructive zone keeps the existing danger (red) treatment; Pass 2 does not neutralize it

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**A destructive zone — a settings "Danger zone", a delete / archive / reset confirmation, an irreversible bulk action — keeps the existing danger treatment: the shared `Button` `variant="danger"` and the existing semantic-critical / danger tokens. No Pass 2 primitive invents a neutral or a new color for it.**

**Why.** The Pass 2 design proposed a neutral destructive zone. The maintainer overruled it on 2026-11-07 (#4795, recorded on the issue): red on an irreversible action is a warning people have learned across every product they use, and removing it trades a real safety cue for visual calm. This is the one place red appears that is not a status, and it is not a contradiction of rule 440: rule 440 governs *status chips*, and a destructive control is an *action*, not a status.

**How to apply.**

1. Use `Button variant="danger"` for the destructive action, and the existing danger tokens for the zone's border or heading. Do not restyle them on shell v2.
2. Do not reach for `StatusChip tone="critical"` to decorate a destructive zone — that would put a status where there is none.

Binds #4800 (settings). Reference: `src/components/Button.tsx`.
