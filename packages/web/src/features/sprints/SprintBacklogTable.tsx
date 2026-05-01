import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { TaskStatus } from '@/types';
import type { SprintBacklogTask } from '@/hooks/useSprintBacklog';

interface Props {
  projectId: string;
  sprintId: string;
  tasks: SprintBacklogTask[];
}

/**
 * Order matters: the spec lists groups Done → In Review → In Progress →
 * Not Started → Backlog (right-to-left through the board status flow).
 */
const GROUP_ORDER: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: 'COMPLETE', label: 'Done' },
  { status: 'REVIEW', label: 'In Review' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'NOT_STARTED', label: 'Not Started' },
  { status: 'BACKLOG', label: 'Backlog' },
];

const STATUS_CHIP_STYLE: Partial<Record<TaskStatus, string>> = {
  COMPLETE: 'border-semantic-on-track/40 text-semantic-on-track',
  REVIEW: 'border-brand-accent-dark/40 text-brand-accent-dark',
  IN_PROGRESS: 'border-brand-primary/40 text-brand-primary',
  NOT_STARTED: 'border-neutral-border text-neutral-text-secondary',
  BACKLOG: 'border-neutral-border text-neutral-text-disabled',
  ON_HOLD: 'border-neutral-border text-neutral-text-disabled',
};

function persistKey(sprintId: string, status: TaskStatus): string {
  return `trueppm.sprintBacklog.collapsed.${sprintId}.${status}`;
}

/**
 * Bottom panel of the Sprints view (#229) — every task in the active sprint
 * grouped by board status. Each group header shows count + points subtotal
 * and is collapsible (state persists in sessionStorage so a tab swap does
 * not reset the user's view).
 */
export function SprintBacklogTable({ projectId, sprintId, tasks }: Props) {
  const groups = useMemo(() => {
    const byStatus = new Map<TaskStatus, SprintBacklogTask[]>();
    for (const t of tasks) {
      const list = byStatus.get(t.status) ?? [];
      list.push(t);
      byStatus.set(t.status, list);
    }
    return GROUP_ORDER.map((g) => ({
      ...g,
      rows: byStatus.get(g.status) ?? [],
    }));
  }, [tasks]);

  const totalPts = useMemo(
    () => tasks.reduce((sum, t) => sum + (t.story_points ?? 0), 0),
    [tasks],
  );

  return (
    <section
      aria-labelledby="sprint-backlog-heading"
      className="border-t border-neutral-border bg-neutral-surface px-6 py-4 flex flex-col gap-3"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2
            id="sprint-backlog-heading"
            className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
          >
            Sprint Backlog
          </h2>
          <p className="text-xs text-neutral-text-secondary">
            <span className="tppm-mono text-neutral-text-primary">{tasks.length}</span>{' '}
            task{tasks.length === 1 ? '' : 's'} · grouped by board status ·{' '}
            <span className="tppm-mono text-neutral-text-primary">{totalPts}</span> pts
            committed
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className="text-xs text-neutral-text-disabled hidden sm:inline-flex items-center gap-1"
            aria-label="Press cmd-K to add a task"
          >
            <kbd className="tppm-mono text-[10px] px-1.5 py-0.5 rounded border border-neutral-border bg-neutral-surface-sunken">
              ⌘K
            </kbd>
            to add task
          </span>
          <Link
            to={`/projects/${projectId}/board?sprint=${sprintId}`}
            className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Open in board ↗
          </Link>
        </div>
      </header>

      {tasks.length === 0 ? (
        <div
          role="status"
          className="rounded-md border border-dashed border-neutral-border bg-neutral-surface-raised p-6 text-center"
        >
          <p className="text-sm font-medium text-neutral-text-primary">
            No tasks committed to this sprint yet
          </p>
          <p className="mt-1 text-xs text-neutral-text-secondary">
            Plan the next sprint or add tasks from the board.
          </p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>ID</th>
              <th>Task</th>
              <th>Points</th>
              <th>Flags</th>
              <th>Owner</th>
              <th>Status</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <BacklogGroup key={g.status} sprintId={sprintId} group={g} />
          ))}
        </table>
      )}
    </section>
  );
}

interface GroupProps {
  sprintId: string;
  group: {
    status: TaskStatus;
    label: string;
    rows: SprintBacklogTask[];
  };
}

function BacklogGroup({ sprintId, group }: GroupProps) {
  const key = persistKey(sprintId, group.status);
  const [collapsed, setCollapsed] = useState<boolean>(false);

  // Hydrate from sessionStorage on mount.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === '1') setCollapsed(true);
    } catch {
      /* sessionStorage unavailable — default to expanded */
    }
  }, [key]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        sessionStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
  }

  const subtotalPts = group.rows.reduce((sum, t) => sum + (t.story_points ?? 0), 0);

  return (
    <tbody>
      <tr className="bg-neutral-surface-raised border-y border-neutral-border">
        <td colSpan={6} className="px-3 py-1.5">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={`backlog-group-${group.status}`}
            className="w-full flex items-baseline justify-between gap-2 text-left
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary flex items-center gap-2">
              <Chevron expanded={!collapsed} />
              {group.label}
              <span className="tppm-mono text-neutral-text-disabled">
                {group.rows.length}
              </span>
            </span>
            <span className="tppm-mono text-xs text-neutral-text-secondary">
              {subtotalPts} pts
            </span>
          </button>
        </td>
      </tr>
      {!collapsed &&
        group.rows.map((t) => (
          <tr
            key={t.id}
            id={`backlog-group-${group.status}`}
            className="border-b border-neutral-border/60 hover:bg-neutral-surface-raised"
          >
            <td className="px-3 py-2 align-top w-20 text-xs tppm-mono text-neutral-text-secondary">
              T-{t.short_id || t.id.slice(0, 6)}
            </td>
            <td className="px-3 py-2 align-top">
              <p className="text-sm text-neutral-text-primary truncate" title={t.name}>
                {t.name}
              </p>
            </td>
            <td className="px-3 py-2 align-top w-12 text-right text-xs tppm-mono text-neutral-text-primary">
              {t.story_points ?? '—'}
            </td>
            <td className="px-3 py-2 align-top w-12">
              {t.is_critical && (
                <span
                  className="tppm-mono text-[10px] border border-semantic-critical/40 text-semantic-critical bg-transparent rounded px-1 py-0.5"
                  title="This task is on the critical path — delays here delay the project end date"
                  aria-label="Critical path task"
                >
                  CP
                </span>
              )}
            </td>
            <td className="px-3 py-2 align-top w-20">
              <OwnerAvatars assignments={t.assignments} />
            </td>
            <td className="px-3 py-2 align-top w-32">
              <span
                className={`inline-flex items-center text-[11px] font-medium uppercase tracking-wide bg-transparent border ${STATUS_CHIP_STYLE[t.status] ?? 'border-neutral-border text-neutral-text-secondary'} rounded px-1.5 py-0.5`}
              >
                {prettyStatus(t.status)}
              </span>
            </td>
          </tr>
        ))}
    </tbody>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={`text-neutral-text-disabled transition-transform ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="M3 1.5 L7 5 L3 8.5" stroke="currentColor" fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function OwnerAvatars({ assignments }: { assignments: { resource_name: string }[] }) {
  if (assignments.length === 0) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] tppm-mono bg-neutral-surface-sunken text-neutral-text-disabled"
      >
        ?
      </span>
    );
  }
  return (
    <div className="flex -space-x-1">
      {assignments.slice(0, 3).map((a, idx) => (
        <span
          key={`${a.resource_name}-${idx}`}
          aria-label={a.resource_name}
          title={a.resource_name}
          className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-medium tppm-mono bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-surface"
        >
          {initials(a.resource_name)}
        </span>
      ))}
      {assignments.length > 3 && (
        <span
          className="tppm-mono text-[10px] text-neutral-text-disabled pl-2"
          aria-label={`${assignments.length - 3} more owners`}
        >
          +{assignments.length - 3}
        </span>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function prettyStatus(s: TaskStatus): string {
  switch (s) {
    case 'COMPLETE':
      return 'Done';
    case 'REVIEW':
      return 'In review';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'NOT_STARTED':
      return 'Not started';
    case 'BACKLOG':
      return 'Backlog';
    case 'ON_HOLD':
      return 'On hold';
    default:
      return s;
  }
}
