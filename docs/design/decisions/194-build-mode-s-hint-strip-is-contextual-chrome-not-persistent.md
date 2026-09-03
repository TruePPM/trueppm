# Rule 194 — Build-mode's hint strip is contextual chrome, not persistent chrome — mount it only while the user is engaged (focus.state.mode !== 'NoSelection'); the always-on discovery affordance is the toolbar pill, not the strip

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Mobile board reflow (Issue #853, v3 case 8)*
>
> **Superseded in part — 2026-08-31, !2263 (#3263).** The reveal policy stands
> unchanged. What no longer holds is the record's *reason* for the strip carrying
> no live region: it rests on "the AT signal for build mode is the always-on
> pill", and #3263 deleted `BuildModePill`. `ScheduleModeChip` replaced it and
> deliberately says nothing about build mode — build mode is `!isMobile`, a
> constant, not a mode a person chooses — so the standing AT signal that a
> keyboard-authoring surface exists is now the chip's `Keyboard shortcuts…` row
> plus the cheatsheet, not a pill's `aria-label`. The conclusion (no live region
> on ephemeral chrome) survives on its own merits; the premise named here does
> not, and is recorded rather than quietly rewritten because the old belief is
> why this paragraph reads the way it does.

**Build-mode's hint strip is contextual chrome, not persistent chrome — mount it only while the user is engaged (`focus.state.mode !== 'NoSelection'`); the always-on discovery affordance is the toolbar pill, not the strip.** `BuildModeHintStrip` shares the Schedule's bottom band with `ScheduleForecastBar` (the P50/P80/P95 signal). An always-on 28px strip of static `↑↓ Select row` hints stacked above the forecast was poor real estate (#1250, VoC avg 4.0/10) — discoverability chrome must not permanently subordinate a headline signal. So `ScheduleView` gates the strip on focus state: idle (`NoSelection`) renders no strip and the Forecast bar sits flush; focusing a row (`RowFocused`) or editing a cell (`CellEdit`) reveals it with that mode's three contextual hints. Discoverability is preserved by the **always-on `BuildModePill`** in the toolbar (keyboard glyph + click → cheatsheet) — that is the persistent "build mode exists" signal for first-time users, so the strip is free to be ephemeral. Keep the reveal **policy in the caller**: `BuildModeHintStrip` stays total over `FocusMode` (it still renders `NoSelection` hints when unit-tested directly); only `ScheduleView` decides when to mount it. Two consequences of mounting-on-focus: (a) the strip carries **no live-region semantics** — a `role="status"`/`aria-live` here would re-announce on every `NoSelection→RowFocused` / `RowFocused↔CellEdit` transition (aria-live churn for decorative chrome); the AT signal for build mode is the always-on pill (clear `aria-label`) + the accessible cheatsheet, so the strip stays in the reading order (cheatsheet button keeps its name) but is never auto-spoken; (b) it enters with `motion-safe:animate-save-bar-slide` (the docked-bottom-bar vocabulary, rule 70) so the reveal slides up rather than popping. The general principle: a discoverability surface that competes with a data signal for the same band must yield the band when idle.
