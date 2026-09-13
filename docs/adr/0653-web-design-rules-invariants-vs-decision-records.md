# ADR-0653 — Split the web design rules into invariants and decision records

- **Status:** Accepted
- **Date:** 2026-07-26
- **Issue:** #2433
- **Supersedes:** nothing (this is the first structural decision about `packages/web/CLAUDE.md` itself)

## Context

`packages/web/CLAUDE.md` is 1151 lines, 98 sections, 285 numbered rules, referencing
73 of the repo's 283 ADRs. Nearly every rule is titled with the issue number that
produced it — `Issue #1305`, `Issue #1770`, `Issue #2365`.

It is a bug-fix ledger wearing a design system's clothes, and the evidence is not
that it is long — length alone would be tolerable — but that its coverage is
shaped by history rather than by risk:

- It exhaustively governs *novel* decisions. There is a codified rule for when a
  junction dot renders where three or more arrow lines converge (rule 75).
- Until #2424 there was **no rule anywhere** saying "a value renders once per
  surface" — the most basic redundancy invariant a UI can have.

That gap is how three defects shipped in one release and were found by a UX red
team rather than by review: the task drawer rendered Status, Finish and Float
twice (#2424); six of nine settings rows shared an icon (#2425); three identical
forecast chips implied a distribution that did not exist (#2426). All three are
trivially visible. None was covered by a rule, because no prior issue had produced
one.

A precedent-based system catches the last bug and misses the next class of it.

There is a second, quieter cost. At 285 rules the document has passed the point
where a contributor can hold it in their head, so compliance depends on
grep-and-hope — and grep only finds a rule you already suspect exists.

## Decision

Split the corpus by **what kind of claim a rule makes**, not by subject area.

### 1. Invariants stay in `packages/web/CLAUDE.md`

An **invariant** is a rule that is (a) generalisable beyond the surface that
produced it, and (b) still correct for a surface that does not exist yet. **62 of
the 290 qualify**: token discipline (8/8a/8b/8c), the focus-ring form matrix
(4/214), the surface-state quartet (248 / 177 / 246 / 224), canvas channel
orthogonality (235), the `useAnchoredPopover` contract (260), the dialog
commit/discard contract (217), the redundancy rule (284).

They are regrouped under 13 concept-titled sections — Foundations, Accessibility
floors, Color and tokens, Signal encoding, Redundancy, Surface states, Motion,
Controls and composition, Dialogs/focus/keyboard, Canvas, Iconography,
Placeholders and operator surfaces, Product boundary. The original headings were
themselves issue-titled (`Issue #1464`, `Issue #1339`) — the ledger symptom
reproduced in the table of contents, so keeping them would have preserved the
shape this ADR exists to change.

These are the design system. They must be short enough to read in one sitting,
because a rule nobody reads is not a rule.

### 2. Case notes move to `docs/design/decisions/`

A **decision record** is a rule bound to one surface and one issue: valuable as
precedent, not as mandatory reading. It moves to its own individually-linkable
file and is referenced *from* the invariant it illustrates.

Nothing is deleted. The reasoning that took an issue to discover is preserved and
made addressable — a decision record can be linked from an MR, an ADR, or a code
comment, which a line number in a 1151-line file cannot.

### 3. A rule a human must remember is a rule that will eventually be violated

Every invariant is assessed for machine-checkability, and the ones that can be
checked are promoted out of prose:

| Rule class | Mechanism |
|---|---|
| No duplicate icon within a nav group | `settingsNavIcons.test.tsx` (#2425) |
| Sub-floor type outside `features/settings` | `check-design-system-v2.sh` check 4b |
| Bare text node as a Suspense fallback | `check-design-system-v2.sh` check 4c |
| Query value gating a loading skeleton with no error read | `check-design-system-v2.sh` check 4f (#3351) |
| Hex literals, arbitrary colors, off-token shadows | `check-design-system-v2.sh` checks 1–3 |
| Dead TS initializers | `no-useless-assignment` (eslint) |
| Unawaited Playwright promises | `no-floating-promises` on `e2e/**` |

The icon-uniqueness check is deliberately a **test**, not a lint rule: it runs the
real nav builders (`buildProjectSettingsNav`, `buildProgramSettingsNav`,
`buildWorkspaceNavGroups`) and compares actual component identities. A regex over
JSX would be weaker and would rot the first time a rail is refactored.

## Consequences

**Good.** A contributor can read the invariant set. New rules land in the right
place by construction, because the question "is this generalisable?" is asked at
authoring time. Machine-checked rules stop depending on reviewer memory.

**Cost.** Two homes means a rule can be filed in the wrong one. Mitigated by the
single test above: *would this rule be correct for a surface that does not exist
yet?* If no, it is a decision record.

**Not addressed here.** This ADR does not change any rule's content. The relocation
is lossless — every moved rule keeps its number, so an existing `rule 176`
reference in code, an ADR, or an MR description still resolves.

**One collision surfaced and was resolved.** The source file used `122.` twice:
the `SettingsShell` scrollbar-gutter rule and the disabled-placeholder recipe. So
"rule 122" was ambiguous in every citation — a defect a 1151-line file hides and
the split makes obvious, which is itself evidence for the change. Every `rule 122`
reference in the codebase means the disabled-placeholder recipe, so that rule keeps
the number and the scrollbar-gutter rule became **288** — 286 (#2447) and 287
(#2389) were claimed by rules that landed on `main` while this split was open.

## Amendment — 2026-09-13 (#3744): invariant bodies move out; the file becomes an index

The invariant set did not stay "short enough to read in one sitting". By September
it was 173 rules and **457 KB** — and the harness loads that file whole into every
session that reads anything under `packages/web/`. It was also the second-most-touched
file on `main` (112 of 545 merges in 30 days), because every UI branch that surfaced a
rule appended to it; rules 411 and 412 had even landed below the decision-record
pointer at the foot of the file.

§1 is amended, not reversed. What an invariant *is* does not change, and neither does
the test for one. What changes is where its text lives:

- `packages/web/CLAUDE.md` holds **one line per invariant** under the same 13
  sections: its bold headline — plus the operative clause, where the headline is only
  a label — and a link to its body.
- The full text moves verbatim to `docs/design/invariants/<N>-<slug>.md`, mirroring
  §2's decision records. Rule numbers are unchanged, so every citation still resolves.
- `.gitattributes` merges the index with `merge=union`, so concurrent additions no
  longer conflict. `check-web-rule-numbers.sh` now also fails on an index line with no
  body and on a body no line indexes; its existing duplicate-number check is what
  catches union's one failure mode (both sides edited the same line, so both are kept).

**Cost, stated plainly.** §1 argued an invariant must be *held*. A contributor now
holds the headline and must open the body before touching the surface a rule governs
or citing one of its lettered clauses. For most rules the headline *is* the rule. For
a minority — where the operative detail is a list (rule 7's health encoding) or a set
of lettered obligations — it is not, and the link is the price of an index that fits
in context.

## Alternatives considered

- **Delete the case notes.** Rejected: the reasoning is the expensive part, and
  each was written because something broke.
- **Split by subject** (canvas / board / settings / …). Rejected: it keeps the
  document exhaustive-by-history and does nothing about the missing-rule-class
  problem, which is the actual finding behind #2424–#2426.
- **Leave it and lint harder.** Rejected: most invariants are not mechanically
  checkable, so the readable set has to exist regardless.
