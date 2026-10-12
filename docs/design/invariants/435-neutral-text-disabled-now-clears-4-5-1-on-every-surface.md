# Rule 435 — `--neutral-text-disabled` now clears 4.5:1 on every surface, in both themes; it is no longer AA-exempt

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Accessibility floors*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`--neutral-text-disabled` was darkened/lightened (#4379) specifically because it was being used as an informational/muted-text color — not only on genuinely disabled controls — in 156 component files, and WCAG 1.4.3's "inactive user interface component" exemption does not cover that usage.** Rules 87 and 169 prohibited the token below `bg-neutral-surface` and reserved it for disabled-only affordances because, at `#A09D99` light / `#64748B` dark, it failed the 4.5:1 AA floor on every surface darker than pure white/the darkest dark surface. Both rules are **superseded** by this one, not deleted — they document the trap this fix closes.

The token is now `#686663` light / `#7F93B0` dark:

| Surface | Light `#686663` | Dark `#7F93B0` |
|---|---|---|
| `--app-canvas` | 4.94:1 | 5.77:1 |
| `--neutral-surface` (white / navy-800) | 5.72:1 | 5.06:1 |
| `--neutral-surface-raised` | 5.39:1 | 4.54:1 ← binding |
| `--neutral-surface-sunken` | 4.55:1 ← binding | 5.98:1 |

Both themes clear 4.5:1 on every neutral surface — rule 87's prohibition ("never on anything darker than white") and rule 169's restriction ("disabled affordances only") no longer have a contrast justification, and `--neutral-text-disabled` is safe to use for de-emphasized but readable informational text directly, without routing it through `--neutral-text-secondary` as rules 87/169 required.

**It is still the more muted of the two tokens, in both themes** — by design, not by accident: the token was deliberately picked as the *lightest* (light theme) / *darkest* (dark theme) value that still clears 4.5:1 everywhere, so it reads as a shade more washed-out than `--neutral-text-secondary` rather than converging on it. That margin is narrow (1.06:1 self-contrast light, 1.22:1 dark) — expected, since `--neutral-text-secondary` was itself darkened to a tight 4.85:1-on-sunken floor by #2265, and AA's 4.5:1 line only leaves so much luminance room between two tokens that both have to clear it on the same worst-case surface. Do not read "narrow margin" as a defect to re-litigate; it is the mathematical consequence of two independent tokens both being AA-bound on the same darkest common surface.

**Disabled controls still need a non-color cue.** Removing the "disabled-only" restriction does not mean color contrast *is* the disabled signal again — a genuinely inert control must still be conveyed via `disabled`/`aria-disabled`, `cursor-not-allowed`, and/or reduced opacity on the control itself, independent of which text token labels it. This token no longer *has* to be sub-AA to look muted, so there is no remaining tension between "looks disabled" and "passes AA" — but the non-color cue requirement (rule 302, WCAG 1.4.1) is unchanged.

**Machine-checked.** `packages/web/src/styles/tokenContrast.test.ts` parses the real `:root, .theme-light` and `.dark` token blocks out of `globals.css` and asserts every text token (`neutral-text-primary`, `neutral-text-secondary`, `neutral-text-disabled`) clears 4.5:1 against every neutral surface token, in both themes. A future edit that re-lightens (light) or re-darkens (dark) `--neutral-text-disabled` below the floor fails that test, not just a manual ux-review pass. The allowlist mechanism in that file (`DISABLED_ONLY_ALLOWLIST`) is for a future token that is genuinely legal only on inert controls under WCAG 1.4.3's exemption — it is empty today because no current token needs it.
