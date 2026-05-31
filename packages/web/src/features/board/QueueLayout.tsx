/**
 * QueueLayout — single prioritised list view of every visible task on the
 * board, grouped *Next up · In flight · Backlog · Recently done* (epic #361
 * child D / issue #384, Claude Design `QueueLayout` / `QueueRow`).
 *
 * Replaces the phase grid + backlog rail/drawer when
 * `toolbarPrefs.layout === 'queue'`. Pull-mode IC surface: read-and-sort
 * v1, no drag affordance from rows. Promotion/demotion will land via the
 * row overflow menu in a follow-up — for now the menu button renders as a
 * disabled placeholder so keyboard tab order is preserved.
 *
 * Why a queue at all: phase-grid layouts force a contributor to scan four
 * status columns × N phases to find "what should I pick up next." The
 * queue collapses that into a flat priority-ordered list. Sarah and Marcus
 * (IC personas) have flagged this scan cost on every board VoC pass since
 * the rail design.
 */
import { useMemo, type ReactNode } from 'react';
import type { Task, TaskReadiness, TaskStatus } from '@/types';

const RECENTLY_DONE_WINDOW_DAYS = 14;

export type QueueGroupKey = 'nextUp' | 'inFlight' | 'backlog' | 'recentlyDone';

interface QueueGroup {
  key: QueueGroupKey;
  label: string;
  tasks: Task[];
  /**
   * Empty-state copy. Each group has its own — "nothing here" italic line is
   * the same lexical message but the *meaning* differs by section (no work to
   * pull vs. no in-flight vs. nothing recently shipped). The italic line is
   * deliberately neutral so empty groups do not feel like missing data.
   */
  emptyCopy: string;
}

const GROUP_LABELS: Record<QueueGroupKey, string> = {
  nextUp: 'Next up · ready to pull',
  inFlight: 'In flight',
  backlog: 'Backlog · needs decision',
  recentlyDone: 'Recently done',
};

const EMPTY_COPY: Record<QueueGroupKey, string> = {
  nextUp: 'Nothing ready to pull right now.',
  inFlight: 'No work in flight.',
  backlog: 'Nothing in the backlog.',
  recentlyDone: 'No tasks completed in the last 2 weeks.',
};

function comparePriority(a: Task, b: Task): number {
  // Lower priorityRank = higher priority. Undefined sorts last.
  const ar = a.priorityRank ?? Number.POSITIVE_INFINITY;
  const br = b.priorityRank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  const at = a.statusEnteredAt ?? '';
  const bt = b.statusEnteredAt ?? '';
  if (at === bt) return a.name.localeCompare(b.name);
  return at < bt ? 1 : -1;
}

function compareFinishDesc(a: Task, b: Task): number {
  const af = a.actualFinish ?? a.finish ?? '';
  const bf = b.actualFinish ?? b.finish ?? '';
  if (af === bf) return a.name.localeCompare(b.name);
  return af < bf ? 1 : -1;
}

/**
 * Partition tasks into the four queue groups.
 *
 * Group rules (ADR-0057 + Claude Design handoff):
 *   • NEXT UP — NOT_STARTED, sorted by priorityRank asc.
 *   • IN FLIGHT — IN_PROGRESS + REVIEW, sorted by priorityRank asc.
 *   • BACKLOG — BACKLOG status, sorted by statusEnteredAt desc (newest first).
 *   • RECENTLY DONE — COMPLETE within RECENTLY_DONE_WINDOW_DAYS, newest first.
 *
 * Summary tasks are always excluded — phases never appear as queue rows.
 * ON_HOLD is treated as inert (legacy; not in any group).
 */
export function groupTasksForQueue(tasks: Task[], now: Date = new Date()): QueueGroup[] {
  const cutoffMs = now.getTime() - RECENTLY_DONE_WINDOW_DAYS * 86_400_000;

  const nextUp: Task[] = [];
  const inFlight: Task[] = [];
  const backlog: Task[] = [];
  const recentlyDone: Task[] = [];

  for (const t of tasks) {
    if (t.isSummary) continue;
    switch (t.status) {
      case 'NOT_STARTED':
        nextUp.push(t);
        break;
      case 'IN_PROGRESS':
      case 'REVIEW':
        inFlight.push(t);
        break;
      case 'BACKLOG':
        backlog.push(t);
        break;
      case 'COMPLETE': {
        const finish = t.actualFinish ?? t.finish;
        const finishMs = finish ? Date.parse(finish) : NaN;
        if (Number.isFinite(finishMs) && finishMs >= cutoffMs) {
          recentlyDone.push(t);
        }
        break;
      }
      default:
        // ON_HOLD intentionally not surfaced.
        break;
    }
  }

  nextUp.sort(comparePriority);
  inFlight.sort(comparePriority);
  backlog.sort((a, b) => {
    const at = a.statusEnteredAt ?? '';
    const bt = b.statusEnteredAt ?? '';
    if (at === bt) return a.name.localeCompare(b.name);
    return at < bt ? 1 : -1;
  });
  recentlyDone.sort(compareFinishDesc);

  return (['nextUp', 'inFlight', 'backlog', 'recentlyDone'] as QueueGroupKey[]).map((k) => ({
    key: k,
    label: GROUP_LABELS[k],
    tasks: { nextUp, inFlight, backlog, recentlyDone }[k],
    emptyCopy: EMPTY_COPY[k],
  }));
}

// ---------------------------------------------------------------------------
// QueueRow — table-style row with priority dot, phase tag, name, readiness or
// status, duration + owner avatar, overflow menu.
// ---------------------------------------------------------------------------

const RESOURCE_COLOR_PALETTE = ['#1C6B3A', '#C17A10', '#0EA5E9', '#7C3AED', '#DC2626', '#0891B2'];

function colorForInitials(initials: string): string {
  let hash = 0;
  for (let i = 0; i < initials.length; i++) hash = (hash * 31 + initials.charCodeAt(i)) | 0;
  return RESOURCE_COLOR_PALETTE[Math.abs(hash) % RESOURCE_COLOR_PALETTE.length];
}

function ownerInitials(task: Task): string | null {
  const first = task.assignees[0];
  if (!first) return null;
  const parts = first.name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function PriorityBars({ rank }: { rank: number | undefined }) {
  // Mirrors BacklogBand's PriorityDot histogram so the queue and rail share a
  // visual vocabulary when both layouts are sampled side-by-side.
  const r = rank ?? 0;
  const litColor =
    r >= 5
      ? 'bg-semantic-critical'
      : r >= 4
        ? 'bg-brand-accent-dark'
        : r >= 3
          ? 'bg-neutral-text-secondary'
          : 'bg-neutral-text-disabled';
  return (
    <span
      title={rank ? `Priority ${rank}` : 'No priority'}
      className="inline-flex items-end gap-[1.5px]"
      style={{ height: 10, flexShrink: 0 }}
      aria-hidden="true"
    >
      {[1, 2, 3].map((b) => (
        <span
          key={b}
          className={r >= b * 2 ? litColor : 'bg-neutral-border'}
          style={{ width: 2, height: 4 + (b - 1) * 2, borderRadius: 0.5 }}
        />
      ))}
    </span>
  );
}

function PhaseTag({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-neutral-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-neutral-text-secondary max-w-[120px]"
      title={name}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

function ReadinessChip({ readiness }: { readiness: TaskReadiness }) {
  const styles: Record<TaskReadiness, string> = {
    idea: 'border border-dashed border-neutral-border text-neutral-text-disabled',
    estimated: 'bg-neutral-surface-sunken text-neutral-text-secondary',
    ready: 'text-brand-primary-dark dark:text-brand-primary',
    baselined: 'bg-neutral-surface-sunken text-neutral-text-secondary',
  };
  // brand-primary-light is now a channel-triple CSS var (ADR-0102); wrap in rgb().
  const inlineBg = readiness === 'ready' ? 'rgb(var(--brand-primary-light))' : undefined;
  return (
    <span
      className={`inline-flex items-center rounded-sm uppercase tracking-wider font-semibold ${styles[readiness]}`}
      style={{
        height: 16,
        padding: '0 6px',
        fontSize: '9.5px',
        letterSpacing: '0.06em',
        backgroundColor: inlineBg,
      }}
    >
      {readiness}
    </span>
  );
}

const STATUS_DOT_COLOR: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-secondary',
  IN_PROGRESS: 'bg-semantic-on-track',
  REVIEW: 'bg-semantic-at-risk',
  ON_HOLD: 'bg-neutral-text-disabled',
  COMPLETE: 'bg-semantic-on-track',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  NOT_STARTED: 'To do',
  IN_PROGRESS: 'In progress',
  REVIEW: 'Review',
  ON_HOLD: 'On hold',
  COMPLETE: 'Done',
};

function StatusBadge({ status, progress }: { status: TaskStatus; progress: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-neutral-text-secondary">
      <span
        aria-hidden="true"
        className={`inline-block rounded-full ${STATUS_DOT_COLOR[status]}`}
        style={{ width: 8, height: 8, flexShrink: 0 }}
      />
      <span className="truncate">{STATUS_LABEL[status]}</span>
      {status !== 'NOT_STARTED' && status !== 'BACKLOG' && (
        <span className="tppm-mono text-neutral-text-disabled">{progress}%</span>
      )}
    </span>
  );
}

function Avatar({ initials }: { initials: string | null }) {
  if (!initials) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-full border border-dashed border-neutral-border text-neutral-text-disabled"
        style={{ width: 18, height: 18, fontSize: 10, flexShrink: 0 }}
      >
        ?
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: 18,
        height: 18,
        backgroundColor: colorForInitials(initials),
        fontSize: 10,
        letterSpacing: '0.02em',
        flexShrink: 0,
      }}
    >
      {initials.slice(0, 2)}
    </span>
  );
}

export interface QueueRowProps {
  task: Task;
  phaseName: string;
  phaseColor: string;
  isFocused: boolean;
  onFocus: () => void;
  onClick: (anchor: HTMLElement) => void;
}

export function QueueRow({ task, phaseName, phaseColor, isFocused, onFocus, onClick }: QueueRowProps) {
  const isIdeaTone = task.status === 'BACKLOG';
  const readiness: TaskReadiness = task.readiness ?? 'idea';
  const initials = ownerInitials(task);
  const focusRing = isFocused ? 'ring-2 ring-brand-primary ring-inset' : '';

  // CP / risk / milestone affordances render inline next to the task name. CP
  // appears as a "CP" badge (rule 26 — colour alone is insufficient); risk as
  // a ⚠ glyph with title fallback; milestone as a ◆ diamond.
  const isCp = task.isCritical && !task.isComplete;
  const riskCount = task.linkedRisksCount ?? 0;
  const isMilestone = task.isMilestone;

  return (
    <div role="listitem">
    <button
      type="button"
      aria-label={`${task.name}, ${STATUS_LABEL[task.status]}, in ${phaseName}`}
      onFocus={onFocus}
      onClick={(e) => onClick(e.currentTarget)}
      data-testid={`queue-row-${task.id}`}
      className={`grid items-center gap-3 px-4 py-2 text-left w-full
        border-b border-neutral-border/40 hover:bg-neutral-surface-sunken
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset
        ${focusRing}`}
      style={{
        gridTemplateColumns:
          'minmax(14px, auto) minmax(80px, 130px) minmax(0, 1fr) minmax(120px, 160px) minmax(110px, auto) 28px',
      }}
    >
      <PriorityBars rank={task.priorityRank} />
      <PhaseTag name={phaseName} color={phaseColor} />

      {/* Name + inline affordances */}
      <span className="flex items-center gap-1.5 min-w-0">
        <span
          className={`flex-1 min-w-0 truncate text-xs font-medium ${
            isIdeaTone ? 'italic text-neutral-text-secondary' : 'text-neutral-text-primary'
          }`}
        >
          {task.name}
        </span>
        {isMilestone && (
          <span
            aria-label="Milestone"
            title="Milestone"
            className="text-brand-accent-dark"
            style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}
          >
            ◆
          </span>
        )}
        {riskCount > 0 && (
          <span
            aria-label={`${riskCount} linked risk${riskCount === 1 ? '' : 's'}`}
            title={`${riskCount} linked risk${riskCount === 1 ? '' : 's'}`}
            className="text-semantic-at-risk"
            style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}
          >
            ⚠
          </span>
        )}
        {isCp && (
          <span
            aria-label="On the critical path"
            title="On the critical path — a delay here delays the project end date"
            className="inline-flex items-center rounded-sm border border-semantic-critical/40 px-1 text-[9.5px] font-bold uppercase tracking-wider text-semantic-critical"
            style={{ height: 14, lineHeight: 1, flexShrink: 0 }}
          >
            CP
          </span>
        )}
      </span>

      {/* Status / readiness column */}
      {task.status === 'BACKLOG' ? (
        <ReadinessChip readiness={readiness} />
      ) : (
        <StatusBadge status={task.status} progress={task.progress} />
      )}

      {/* Duration + owner */}
      <span className="flex items-center gap-2 justify-end text-[11px] text-neutral-text-secondary">
        {task.duration > 0 && <span className="tppm-mono">{task.duration}d</span>}
        <Avatar initials={initials} />
      </span>

      {/* Overflow menu placeholder — promote / demote actions land in a
          follow-up (#388 queued); the disabled button keeps tab-order parity
          with the rail's capture CTA. */}
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center text-neutral-text-disabled"
        style={{ width: 24, height: 24, fontSize: 14, lineHeight: 1 }}
        title="Row actions land in a follow-up"
      >
        ⋯
      </span>
    </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueueLayout — sticky group headers, four sections, replaces the body.
// ---------------------------------------------------------------------------

export interface QueueLayoutProps {
  tasks: Task[];
  /** Resolves a phase summary task ID (or 'root') to a display name. */
  phaseNameFor: (parentId: string | null) => string;
  /** Resolves a phase summary task ID (or 'root') to a deterministic color. */
  phaseColorFor: (parentId: string | null) => string;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  /** Override "now" — used in tests to fix the recently-done window. */
  now?: Date;
  /** Optional content rendered inside the scroll container, above the group
      list. Used to host the active-sprint summary so its charts scroll with
      the queue rather than permanently consuming vertical space. */
  header?: ReactNode;
}

export function QueueLayout({
  tasks,
  phaseNameFor,
  phaseColorFor,
  focusedCardId,
  onCardFocus,
  onCardClick,
  now,
  header,
}: QueueLayoutProps) {
  const groups = useMemo(() => groupTasksForQueue(tasks, now), [tasks, now]);
  const totalVisible = groups.reduce((sum, g) => sum + g.tasks.length, 0);

  if (totalVisible === 0) {
    return (
      <div
        className="flex-1 overflow-auto min-h-0 bg-neutral-surface"
        data-testid="queue-empty-scroll"
      >
        {header}
        <div
          className="flex items-center justify-center py-16 text-neutral-text-secondary text-sm"
          role="status"
          data-testid="queue-empty"
        >
          No tasks yet. Create tasks to see them in the queue.
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-auto min-h-0 bg-neutral-surface"
      data-testid="queue-layout"
    >
      {header}
      {groups.map((group) => (
        <section
          key={group.key}
          aria-labelledby={`queue-group-${group.key}`}
          data-testid={`queue-group-${group.key}`}
          className="border-b border-neutral-border/60"
        >
          <header
            className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5
              border-b border-neutral-border bg-neutral-surface-raised"
          >
            <h2
              id={`queue-group-${group.key}`}
              className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary"
            >
              {group.label}
            </h2>
            <span
              className="inline-flex items-center justify-center rounded-full bg-neutral-surface-sunken
                text-xs font-semibold text-neutral-text-secondary tppm-mono"
              style={{ minWidth: 18, height: 16, padding: '0 6px' }}
              aria-label={`${group.tasks.length} ${group.tasks.length === 1 ? 'task' : 'tasks'}`}
              data-testid={`queue-group-count-${group.key}`}
            >
              {group.tasks.length}
            </span>
          </header>
          {group.tasks.length === 0 ? (
            <div
              role="status"
              className="px-4 py-3 text-xs italic text-neutral-text-disabled"
              data-testid={`queue-group-empty-${group.key}`}
            >
              {group.emptyCopy}
            </div>
          ) : (
            <div role="list" aria-label={group.label}>
              {group.tasks.map((task) => {
                const phaseId = task.parentId ?? 'root';
                return (
                  <QueueRow
                    key={task.id}
                    task={task}
                    phaseName={phaseNameFor(task.parentId)}
                    phaseColor={phaseColorFor(task.parentId)}
                    isFocused={focusedCardId === task.id}
                    onFocus={() => onCardFocus(task.id, task.status, phaseId)}
                    onClick={(anchor) => onCardClick(task, anchor)}
                  />
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
