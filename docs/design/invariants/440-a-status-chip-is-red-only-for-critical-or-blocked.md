# Rule 440 — A status chip is red only for critical or blocked, amber for every "watch this", never brand, and always carries a glyph

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**On shell v2, a status is a `StatusChip` (`src/components/page2/StatusChip.tsx`) and its tone follows one contract:**

| Tone | Means | Glyph |
|---|---|---|
| `critical` (red) | On the critical path | ▲ |
| `blocked` (red) | Blocked | ■ |
| `risk` (amber) | At risk, near-critical, over-allocated, WIP over limit | ◆ |
| `ok` | Done, on track | ✓ |
| `info` | In progress, informational | ● |
| `neutral` | Not started, no status | ● |

1. **Red is critical or blocked, nothing else.** A failed request, a validation message, an overdue date that is not on the critical path: none of these is red on a status chip. The page error state is neutral for this reason (rule 439).
2. **Amber is every "watch this"**, so a person scanning a table learns one color for "not yet a problem, soon one".
3. **Brand is never a status.** `StatusTone` has no brand member, so `tsc` refuses a sage "On track" chip; the `ok` token exists so a sage button and a green status can never be mistaken for each other (the `--p1-*` token block's own contract).
4. **A glyph on every chip** (rule 120): the word carries the meaning, the glyph carries it without color, the tint carries it at a glance. `▲ ◆ ✓` match the Pass 1 shell health chip, so a glyph never means two things across the shell. The Pass 2 design drew the over-allocation badge with ▲; the shipped chip already spends ▲ on *critical*, so over-allocation (amber) wears ◆ — the code wins.
5. **No new color family.** Chips use the shipped `--p1-*` text and tint tokens. Each text-on-tint pair is pinned at >= 4.5:1 in light and dark by `src/styles/p1Tokens.test.ts`, with the tint composited over every ground a chip sits on (canvas, sheet, hovered row). Adding a ground means adding it to that test; Pass 2 found the dark critical chip at 4.45:1 on a hovered row and moved `--p1-critical` (dark) from L 0.76 to 0.78 rather than drop the ground.

**Why.** Pass 1 left the status vocabulary to each surface, and red drifted onto every kind of bad news until it stopped meaning "this moves the finish date". A chip whose tone set is a type cannot drift that way.

Reference: #4795; rule 442 (the RAG chip is the server band); rule 441 (destructive zones are the one other place red appears).
