import { useMemo, useState } from 'react';
import type { Task, TaskStatus } from '@/types';
import { formatShortDate } from '@/features/schedule/scheduleUtils';

interface PhaseMilestoneRailProps {
  milestones: Task[];
  columns: { status: TaskStatus; label: string }[];
  onOpenTask?: (task: Task) => void;
}

type MilestoneTone = 'hit' | 'missed' | 'upcoming';

interface MilestoneState {
  task: Task;
  tone: MilestoneTone;
  label: string;
}

function classifyMilestone(task: Task): MilestoneState {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const planned = task.start ? new Date(task.start) : null;

  if (task.status === 'COMPLETE') {
    if (task.actualFinish && planned) {
      const actual = new Date(task.actualFinish);
      const tone: MilestoneTone = actual > planned ? 'missed' : 'hit';
      return { task, tone, label: tone === 'hit' ? 'Hit' : 'Late hit' };
    }
    return { task, tone: 'hit', label: 'Hit' };
  }

  if (planned && planned < today) {
    return { task, tone: 'missed', label: 'Missed' };
  }

  return { task, tone: 'upcoming', label: 'Upcoming' };
}

function diamondClass(tone: MilestoneTone, isHovered: boolean): string {
  const ring = isHovered ? 'ring-2 ring-brand-primary ring-offset-1 ring-offset-neutral-surface' : '';
  switch (tone) {
    case 'hit':
      return `bg-semantic-on-track text-semantic-on-track ${ring}`;
    case 'missed':
      return `bg-semantic-critical text-semantic-critical ${ring}`;
    case 'upcoming':
      return `bg-transparent border border-neutral-text-disabled text-neutral-text-disabled ${ring}`;
  }
}

const MAX_VISIBLE_PER_COLUMN = 5;

interface DiamondProps {
  state: MilestoneState;
  onOpenTask?: (task: Task) => void;
}

function Diamond({ state, onOpenTask }: DiamondProps) {
  const [open, setOpen] = useState(false);
  const { task, tone, label } = state;
  const dateText = task.start ? formatShortDate(task.start) : 'Date TBD';

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => onOpenTask?.(task)}
        aria-label={`${label} milestone ${task.name}, target ${dateText}`}
        className="block relative w-3 h-3 rotate-45 rounded-[2px] focus-visible:outline-none before:absolute before:inset-[-16px] before:content-['']"
      >
        <span
          aria-hidden="true"
          className={[
            'absolute inset-0 rounded-[2px] transition-colors',
            diamondClass(tone, open),
          ].join(' ')}
        />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-20 left-1/2 -translate-x-1/2 top-[calc(100%+6px)]
            whitespace-nowrap bg-neutral-surface border border-neutral-border rounded-card
            px-2 py-1 text-xs shadow-none
            text-neutral-text-primary"
        >
          <span className="block font-medium">{task.name}</span>
          <span className="block tppm-mono text-neutral-text-secondary">
            {dateText} · {label}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * 24px milestone rail rendered above each phase swimlane (issue #187).
 *
 * Diamonds are pinned to the status column matching the milestone task's
 * current status — the board has no time axis, so date-pinning isn't possible
 * (ADR-0035 §Q4).  Hover reveals name + target date.  Color encodes status:
 *   hit (green, filled), missed/late hit (red, filled), upcoming (neutral, outlined).
 *
 * Renders nothing when the phase has zero milestones.
 */
export function PhaseMilestoneRail({ milestones, columns, onOpenTask }: PhaseMilestoneRailProps) {
  const byColumn = useMemo(() => {
    const map = new Map<TaskStatus, MilestoneState[]>();
    for (const task of milestones) {
      const list = map.get(task.status) ?? [];
      list.push(classifyMilestone(task));
      map.set(task.status, list);
    }
    return map;
  }, [milestones]);

  if (milestones.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Phase milestones"
      className="grid gap-[var(--board-col-gap,0.5rem)] px-2 py-1.5 border-b border-neutral-border/30 bg-neutral-surface-sunken"
      // Board zoom (issue 379): inherits --board-phase-col / --board-col-gap from the
      // board grid container so the rail stays column-aligned with the lanes.
      style={{
        gridTemplateColumns: `var(--board-phase-col,188px) repeat(${columns.length}, minmax(0, 1fr))`,
      }}
    >
      {/* Lane meta filler */}
      <div className="text-xs text-neutral-text-disabled italic">Milestones</div>

      {columns.map((col) => {
        const all = byColumn.get(col.status) ?? [];
        const visible = all.slice(0, MAX_VISIBLE_PER_COLUMN);
        const overflow = all.length - visible.length;
        return (
          <div
            key={col.status}
            className="flex items-center justify-center gap-1.5 min-h-[20px]"
            role="listitem"
          >
            {visible.map((state) => (
              <Diamond key={state.task.id} state={state} onOpenTask={onOpenTask} />
            ))}
            {overflow > 0 && (
              <span
                className="text-xs tppm-mono text-neutral-text-secondary px-1 py-px
                  rounded-chip bg-neutral-surface border border-neutral-border"
                aria-label={`${overflow} more milestones in ${col.label}`}
              >
                +{overflow}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
