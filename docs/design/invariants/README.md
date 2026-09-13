# Web design invariants

The full text of every invariant indexed in
[`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md) — one file per rule,
named `<N>-<slug>.md`, where `N` is the rule number cited across the codebase
(#3744, ADR-0653 amendment).

An invariant is a rule that would be correct for a surface that does not exist
yet. Rules bound to one surface and one issue are decision records and live in
[`../decisions/`](../decisions/README.md) instead.

The index carries each rule's headline; this directory carries its obligations,
reasoning and references. Read the body before touching the surface a rule
governs, and before citing one of its lettered clauses.

## Adding one

1. `scripts/wt reserve rule` for the number.
2. Write `<N>-<slug>.md` here, copying the header of any sibling.
3. Append one index line to the end of its section in `packages/web/CLAUDE.md`.

`scripts/check-web-rule-numbers.sh` fails on a duplicate number, an index line
with no body, and a body with no index line.
