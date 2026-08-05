import {
  gutterBackground,
  isModeVisible,
  modePresentation,
  type RowMode,
} from './deliveryModePresentation';

/**
 * Delivery-mode indicators on a Schedule outline row (#2737).
 *
 * Two marks carrying one fact, so it survives a color-vision deficiency and a
 * monochrome print (WCAG 1.4.1): a 3px gutter at the row's left edge, and a
 * text chip beside the task name. The timeline's bar texture (`drawDeliveryModeMark`,
 * #2727) is the third. None of them is load-bearing alone.
 */

/**
 * The 3px left-edge gutter.
 *
 * Absolutely positioned rather than a border, because the row's own
 * `border-l-2 border-brand-primary` already encodes selection — two competing
 * left borders on one row would make the selected state and the mode
 * indistinguishable. `left-0` resolves to the padding edge, i.e. just inside
 * that selection border, so the two stack instead of colliding.
 *
 * A `mixed` row is drawn from the hues actually present in its subtree, so
 * `scrum + kanban` and `gated + scrum` are visibly different branches.
 */
export function ModeGutter({ mode }: { mode: RowMode | undefined }) {
  if (!isModeVisible(mode)) return null;
  const { colors } = modePresentation(mode);
  return (
    <span
      aria-hidden="true"
      data-testid="mode-gutter"
      data-mode={mode.kind}
      className="absolute left-0 top-0 bottom-0 w-[3px] pointer-events-none"
      style={{ background: gutterBackground(colors) }}
    />
  );
}

/**
 * The mode chip.
 *
 * Passive, not a control — activating it would have to mean *something*, and
 * the act of changing a classification is `⌘⇧M` / the row menu, which already
 * previews what it will do. A chip that silently opened an editor from a
 * read-looking label would be the worse of the two affordances.
 *
 * The accessible name is the full sentence, not the token: `SCRUM` read aloud
 * on its own tells a screen-reader user which word is on screen and nothing
 * about what it governs.
 */
export function ModeChip({ mode }: { mode: RowMode | undefined }) {
  if (!isModeVisible(mode)) return null;
  const { label, description, colors } = modePresentation(mode);
  return (
    <span
      data-testid="mode-chip"
      data-mode={mode.kind}
      title={description}
      aria-label={description}
      className="inline-flex shrink-0 items-center rounded-chip border px-1 py-px
                 font-mono text-xs leading-4 tracking-wide text-neutral-text-secondary"
      style={{ borderColor: colors[0] }}
    >
      {label}
    </span>
  );
}
