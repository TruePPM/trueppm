/**
 * Active-label chip for a view's filter strip — swatch · `Label: <name>` · ✕.
 * ADR-0620, #2383.
 *
 * Only the ✕ is focusable: the chip text is a restatement of state the panel
 * already announces, so making it a second tab stop per active label would
 * double the cost of tabbing past a multi-label filter for no added action.
 * Delete/Backspace on the focused ✕ removes too — a filter chip reads as a
 * deletable token, and both keys are what people try.
 *
 * `count` is rendered when supplied and is the whole reason a zero-result filter
 * is legible: `Label: Rework 0` in the strip explains an empty table without the
 * user reopening the panel.
 */

import type { Ref } from 'react';
import { XMarkIcon } from '@/components/Icons';
import { labelDotStyle } from '@/lib/labelColors';

interface LabelChipProps {
  name: string;
  color: string;
  /** Matching rows in the current view; omit to hide the badge. */
  count?: number;
  onRemove: () => void;
  /** Called after removal so the host can re-seat focus (next chip, else trigger). */
  removeRef?: Ref<HTMLButtonElement>;
}

export function LabelChip({ name, color, count, onRemove, removeRef }: LabelChipProps) {
  return (
    <span
      className="inline-flex h-6 items-center gap-1 rounded-full border border-brand-primary/40
        bg-brand-primary/10 px-2 text-xs text-brand-primary"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={labelDotStyle(color)}
      />
      Label: {name}
      {count !== undefined && (
        <span className="tppm-mono tabular-nums text-neutral-text-secondary">{count}</span>
      )}
      {/* `focus:` (not `focus-visible:`) so the ring shows on pointer-initiated
          focus in Firefox/Safari (rule 214, WCAG 2.4.7). `before:` grows the hit
          area to 44px without resizing the 24px chip, which must stay inline
          with its siblings (rule 208 / WCAG 2.5.8). */}
      <button
        ref={removeRef}
        type="button"
        onClick={onRemove}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onRemove();
          }
        }}
        aria-label={`Remove filter: label ${name}`}
        className="relative ml-0.5 rounded-full hover:text-brand-primary-dark
          focus:outline-none focus:ring-1 focus:ring-brand-primary
          before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11
          before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
      >
        <XMarkIcon aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}
