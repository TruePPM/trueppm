/**
 * Shared atoms for the product-backlog surfaces (ADR-0105 DA-10/11/14), mapped from
 * the design prototype onto the real navy/sage design-system tokens (NOT the
 * prototype green): semantic-on-track for "ready/met", semantic-warning/at-risk for
 * "refining/partial", neutral-text-secondary for "idea/none".
 */

import type { DorState, Task } from '@/types';
import { PendingAcceptanceChip } from '@/features/board/PendingAcceptanceChip';

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

/**
 * Sprint-commitment read-state for a backlog story (1223, web-rule 180).
 *
 * Three mutually-exclusive states, by precedence:
 *  - sprintPending → the shared {@link PendingAcceptanceChip} (ADR-0102, rule 149): a
 *    task injected into an ACTIVE sprint after activation, not yet accepted. It is the
 *    more specific state and wins, so the two pills never double up on one row.
 *  - sprintId set → "Pulled" (committed to a sprint). Brand-accent tint — deliberately
 *    NOT semantic-on-track, which would collide with the green DoR "Ready" chip in the
 *    adjacent Readiness column (rule 7/8: two greens on one row read as a single cue).
 *  - otherwise → "Proposed" (a backlog candidate, not yet committed): a recessive
 *    dashed-outline neutral pill — it is the common/default state, so it stays quiet.
 *
 * The text label is the WCAG 1.4.1 signal — never color alone (rule 7/120).
 */
export function SprintCommitmentChip({ story }: { story: Task }) {
  if (story.sprintPending) return <PendingAcceptanceChip />;
  if (story.sprintId) {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap rounded bg-brand-primary/10 px-2 py-0.5 text-[11px] font-semibold text-brand-primary"
        title="Committed to a sprint"
      >
        Pulled
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded border border-dashed border-neutral-border px-2 py-0.5 text-[11px] font-semibold text-neutral-text-secondary"
      title="A backlog candidate — not yet committed to a sprint"
    >
      Proposed
    </span>
  );
}

/** First+last initials, max two chars, uppercased; falls back to "?" for a blank name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Story assignee avatar (1223). Shows the first assignee's initials; 2+ assignees stack
 * the first avatar with a "+N" overflow; unassigned renders a dashed placeholder. The
 * circles are decorative (rule 6) — the accessible name (the assignee list, or
 * "Unassigned") is carried on the wrapper as aria-label + a hover title.
 */
export function AssigneeAvatar({ assignees }: { assignees: Task['assignees'] }) {
  if (!assignees || assignees.length === 0) {
    return (
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-neutral-border text-[11px] text-neutral-text-secondary"
        aria-label="Unassigned"
        title="Unassigned"
      >
        <span aria-hidden>–</span>
      </span>
    );
  }
  const names = assignees.map((a) => a.name).join(', ');
  const extra = assignees.length - 1;
  return (
    <span className="flex items-center" aria-label={`Assigned to ${names}`} title={names}>
      <span
        aria-hidden
        className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-primary/10 text-[11px] font-semibold text-brand-primary"
      >
        {initials(assignees[0].name)}
      </span>
      {extra > 0 && (
        <span
          aria-hidden
          className="-ml-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-surface bg-neutral-surface-sunken px-1 text-[11px] font-semibold text-neutral-text-secondary"
        >
          +{extra}
        </span>
      )}
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
