# Rule 471 — A shell v2 screen composes the Pass 3 primitives; a non-human actor is never drawn as a person, and a stepper at its limit stays focusable

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Controls and composition*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**A shell v2 screen takes these shapes from `src/components/page2/` (#4802) and does not re-implement them.**

| Shape | Owner | The obligation it carries |
|---|---|---|
| Agent, service, job or modeled resource | `NonHumanTile` | Square tile, tool icon (bot, cpu, cog, hard-hat), `role="img"` and a label. Never initials in a circle, never a face |
| Percent up / down | `Stepper` | 44px buttons; at a bound the button is `aria-disabled`, never `disabled`, so the press that reaches the bound does not drop focus |
| Capacity share | `SplitBar` | The text line names every share; the bar is `aria-hidden` |
| Person x 13 weeks | `HeatGrid13` | Banding, ink and legend are the People heat map's (rule 464); a modeled seat is outlined and says so in words; the start week is dashed and says "Starts"; both marks carry a sheet-colored backing so they read on every band; it has an empty line and takes the server's definition and "as of" |
| History of changes | `TrailTimeline` | Immutable: no action or edit slot. No entries renders a line, not an empty list |
| Why-reason choice | `ReasonRadioGroup` | Native radios, nothing preselected by the component |
| Area x read / propose / write | `ScopeMatrix` | A grant that is never offered reads "Never", not as an unticked box. A grant that is not offered *yet* is a column with a `disabledReason`: disabled, unchecked, reason in the header |
| Modal | `ModalDialog` | Trap and restore, Escape, scrim; `busy` blocks all three dismissals. Rule 217 (dirty guard) stays with the caller |
| RAG call, engine facts, page-level message | `RagRadio`, `SnapshotPanel`, `Banner` | `Banner` goes in `PageFrame`'s `toolbarOverride`, at the toolbar row's height |

**How to apply.** The fixture at `/shell2/kit?ff=shell_v2&p3=1` mounts each primitive; `e2e/shell-v2-pass3-kit.spec.ts` runs axe on it in both themes and pins the dialog, banner and trail behavior jsdom cannot.
