/**
 * Shared atoms for the product-backlog surfaces (ADR-0105 DA-10/11/14), mapped from
 * the design prototype onto the real navy/sage design-system tokens (NOT the
 * prototype green): semantic-on-track for "ready/met", semantic-warning/at-risk for
 * "refining/partial", neutral-text-secondary for "idea/none".
 */

import type { DorState } from '@/types';

const DOR_STYLE: Record<DorState, { cls: string; label: string }> = {
  ready: { cls: 'bg-semantic-on-track-bg text-semantic-on-track', label: 'Ready' },
  refine: { cls: 'bg-semantic-warning-bg text-semantic-warning', label: 'Refine' },
  idea: {
    cls: 'border border-dashed border-neutral-border text-neutral-text-secondary',
    label: 'Idea',
  },
};

export function DorChip({ dor }: { dor: DorState }) {
  const s = DOR_STYLE[dor];
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

/** Acceptance-criteria meter: segmented bar + met/total count (DA-10/DA-14). */
export function AcMeter({ met, total }: { met: number; total: number }) {
  const full = total > 0 && met === total;
  const none = met === 0;
  const color = full
    ? 'text-semantic-on-track'
    : none
      ? 'text-neutral-text-secondary'
      : 'text-semantic-warning';
  const fill = full ? 'bg-semantic-on-track' : 'bg-semantic-warning';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${met}/${total} acceptance criteria met`}
    >
      <span className="inline-flex gap-px" aria-hidden>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-3 w-1 rounded-[1px] ${
              i < met ? fill : 'border border-neutral-border bg-neutral-surface-sunken'
            }`}
          />
        ))}
      </span>
      <span className={`font-mono text-[11px] tabular-nums ${color}`}>
        {met}/{total}
      </span>
    </span>
  );
}

/** A single WSJF/RICE component cell with a mini value bar (DA-11). */
export function ScoreCell({
  value,
  max = 10,
  accent = false,
}: {
  value: number;
  max?: number;
  accent?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span
        className={`font-mono text-xs font-semibold ${
          accent ? 'text-brand-primary' : 'text-neutral-text-primary'
        }`}
      >
        {value}
      </span>
      <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-neutral-surface-sunken">
        <span
          className={`absolute inset-y-0 left-0 ${accent ? 'bg-brand-primary' : 'bg-neutral-text-secondary'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
