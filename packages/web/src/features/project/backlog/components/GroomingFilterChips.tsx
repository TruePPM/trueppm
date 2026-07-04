/**
 * Toggle chips for the grooming filter (issue 1044) — shared by the desktop bar
 * and the mobile toolbar.
 *
 * The DoR chips echo the DorChip color semantics (atoms.tsx) so the control
 * reads as the state it filters: sage for Ready, amber for Refine, neutral for
 * Idea. The active fill + `aria-pressed` carry the state; the label text is the
 * WCAG 1.4.1 signal, never color alone.
 */

import type { DorState } from '@/types';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

const BASE_CHIP =
  'inline-flex items-center whitespace-nowrap rounded-full px-3 text-xs font-semibold';

const INACTIVE =
  'border border-neutral-border bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised';

const DOR_ACTIVE: Record<DorState, string> = {
  ready: 'border border-transparent bg-semantic-on-track-bg text-semantic-on-track',
  refine: 'border border-transparent bg-semantic-warning-bg text-semantic-warning',
  idea: 'border border-neutral-border bg-neutral-surface-sunken text-neutral-text-primary',
};

const DOR_LABEL: Record<DorState, string> = {
  idea: 'Idea',
  refine: 'Refine',
  ready: 'Ready',
};

export function DorFilterChip({
  dor,
  active,
  onClick,
  size = 'sm',
}: {
  dor: DorState;
  active: boolean;
  onClick: () => void;
  /** `md` = the taller mobile tap target (h-8). */
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`${BASE_CHIP} ${size === 'md' ? 'h-8' : 'h-7'} shrink-0 ${
        active ? DOR_ACTIVE[dor] : INACTIVE
      } ${FOCUS_RING}`}
    >
      {DOR_LABEL[dor]}
    </button>
  );
}

/** Generic pressed-state chip — the mobile "Unestimated" toggle (brand tint when on). */
export function ToggleChip({
  label,
  active,
  onClick,
  size = 'sm',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`${BASE_CHIP} ${size === 'md' ? 'h-8' : 'h-7'} shrink-0 ${
        active
          ? 'border border-transparent bg-brand-primary/10 text-brand-primary'
          : INACTIVE
      } ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}

export const DOR_FILTER_ORDER: DorState[] = ['idea', 'refine', 'ready'];
