# Rule 436 — A navigation surface holds a fixed number of items at rest; a surface that needs more folds behind one control

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text (#3744). Binding everywhere, not only on the surface that produced it.

**A navigation surface (a rail, a tab row, a bottom bar) holds at most N items at rest, and a surface that needs more folds the overflow behind exactly one control. It never grows another row.** The budgets are:

| Surface | At rest | Overflow |
|---|---|---|
| Global rail (shell v2) | 5 destinations (Home, Inbox, Work, People, Agents) + the person's pins, **<= 7** | Pins are capped; an eighth is refused, not scrolled |
| Context-header tabs | **<= 5** (Overview, Plan, Deliver, Risks, People) | One **More** control |
| Phone bottom bar | **5** | One **More** control |

**Why.** The v1 rail reached 18-22 rows because each feature added its own entry and nothing said no (Pass 1 audit; ADR-1298). The visible set was then filtered six ways, so no two users saw the same nav. A hard cap turns "add a nav row" from a free decision into a design question: what leaves, or what folds. Five is also the number a person can hold while scanning, and the phone bar cannot hold more at the 44px touch floor (rule 5) on a 320px screen.

**How to apply.**

1. Counting is at rest, per breakpoint: the same item count must hold at the widest and narrowest layout, so the budget cannot be met by hiding rows with CSS at one width.
2. The fold is **one** control (More). Two overflow controls, or a More that itself contains a second More, is a violation.
3. Methodology, role or edition may change *which* items exist, never *how many are visible at rest* beyond the cap, and never move an item between groups (ADR-1298 section 1).
4. Raising a budget is an ADR amendment, not a code review comment.

**Scope.** Navigation surfaces only. Action toolbars, filter rows and tables are governed by rule 290 (overflow) and their own design, not this budget. The rule applies to shell v2 (ADR-1298) and binds any later shell; the v1 shell is the known exception while `shell_v2` is off, and is not a precedent.
