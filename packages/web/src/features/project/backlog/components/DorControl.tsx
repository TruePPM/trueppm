/**
 * Definition-of-Ready control for the story drawer (#1043). A 3-state segmented
 * radiogroup (Idea · Refine · Ready) — richer than the row's 2-state toggle.
 * Changes mutate immediately (the server owns the readiness gate). "Ready" is
 * pre-checked client-side from the live AC list + estimate so it disables with a
 * plain-English reason before the user clicks; ticking the last criterion or
 * setting points re-enables it in real time without a save.
 */

import { WarningIcon } from '@/components/Icons';
import type { DorState } from '@/types';

const OPTIONS: { value: DorState; label: string }[] = [
  { value: 'idea', label: 'Idea' },
  { value: 'refine', label: 'Refine' },
  { value: 'ready', label: 'Ready' },
];

interface DorControlProps {
  dor: DorState;
  onChange: (dor: DorState) => void;
  /** Whether the story currently satisfies the readiness gate (drawer-computed). */
  canBeReady: boolean;
  /** Plain-English reasons the story can't be Ready (shown when canBeReady is false). */
  blockerReasons: string[];
  disabled?: boolean;
}

export function DorControl({
  dor,
  onChange,
  canBeReady,
  blockerReasons,
  disabled = false,
}: DorControlProps) {
  return (
    <section aria-labelledby="drawer-dor-heading" className="flex flex-col gap-1.5">
      <h3
        id="drawer-dor-heading"
        className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
      >
        Readiness
      </h3>
      <div
        role="radiogroup"
        aria-label="Definition of Ready"
        aria-describedby={!canBeReady ? 'drawer-dor-blockers' : undefined}
        className="inline-flex w-fit rounded-control border border-neutral-border p-0.5"
      >
        {OPTIONS.map(({ value, label }) => {
          const selected = dor === value;
          const optDisabled = disabled || (value === 'ready' && !canBeReady && !selected);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={optDisabled}
              onClick={() => !selected && onChange(value)}
              className={[
                'min-h-[36px] rounded-control px-3 text-xs font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                selected
                  ? value === 'ready'
                    ? 'bg-semantic-on-track-bg text-semantic-on-track'
                    : value === 'refine'
                      ? 'bg-semantic-warning-bg text-semantic-warning'
                      : 'bg-neutral-surface-sunken text-neutral-text-primary'
                  : optDisabled
                    ? 'cursor-not-allowed text-neutral-text-disabled'
                    : 'text-neutral-text-secondary hover:text-neutral-text-primary',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
      {!canBeReady && blockerReasons.length > 0 && (
        <p id="drawer-dor-blockers" className="text-xs text-semantic-at-risk">
          <WarningIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
          Can&apos;t mark Ready: {blockerReasons.join('; ')}
        </p>
      )}
    </section>
  );
}
