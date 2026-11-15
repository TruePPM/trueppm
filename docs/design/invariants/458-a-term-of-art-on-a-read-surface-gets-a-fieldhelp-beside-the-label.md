# Rule 458 — A term of art on a read surface gets a `FieldHelp` beside the label, never inside a sort button or tooltip wrapper

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Product boundary*. The index carries the rule's headline; this file carries its full text (#3714). Binding on every surface it names.

A column header, panel heading or cell label that names a number the reader consults repeatedly in a term of art (float, utilization, velocity, baseline variance) carries a `FieldHelp` popover as a **sibling** of the label, in the same row: never nested inside the sort button (a nested interactive control is invalid and Enter would sort), and never replacing the rule-287 `Tooltip` definition, which stays as the one-line reading. The copy states what the number means and how it misleads, lives in one component per term so every surface that shows the term imports the same words, and links to an existing docs anchor. Widen the column rather than clipping the trigger; its hit area is the 20px button plus the invisible 12px halo `FieldHelp` already carries (#3714).

**Origin.** Written with #3714, which found 28 of 35 `FieldHelp` mounts in settings and none on risk, reports, resource or grid.
