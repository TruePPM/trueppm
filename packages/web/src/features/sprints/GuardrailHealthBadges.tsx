import type { Task, ApiSprint } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  /** All tasks in the current project. */
  tasks: Task[];
  /** The currently active sprint, if any. Drives the "spans N phases" badge. */
  activeSprint: ApiSprint | null;
}

/**
 * Tier-3 health badges (ADR-0101 §4).
 *
 * Read-only signals on planning surfaces — never blocks anything. Audience is
 * the team and the agile coach: each badge surfaces a *symptom* the team can
 * choose to act on, never a "you are wrong" verdict.
 *
 * Computed entirely from data already loaded for the Sprints view (tasks +
 * active sprint), so this adds no network round trip. Renders nothing when
 * every count is zero — the goal is to fade away when the project is healthy.
 *
 * Velocity numbers are *never* added to this surface — per ADR a PMO surface
 * never sees auto-exposed velocity, and this row is consumed by both team and
 * coach in the existing Sprints workspace.
 */
export function GuardrailHealthBadges({ tasks, activeSprint }: Props) {
  const itl = useIterationLabel();
  // "No sprint and no phase": a task with no sprint membership and no phase
  // ancestor (`wbs` lacks a dot — anything like "3.1" or deeper has a phase;
  // "3" *is* the phase; empty means unrooted). Recurring tasks and summary
  // tasks are excluded because both are exempt from the sprint/phase hygiene
  // rules (ADR-0090 / annotation-only summary state).
  const orphanCount = tasks.filter((t) => {
    if (t.isSummary || t.isMilestone) return false;
    if (t.sprintId != null) return false;
    const wbs = t.wbs;
    if (wbs && wbs.includes('.')) return false;
    return true;
  }).length;

  // "Sprint spans N phases": distinct WBS L1 roots across active-sprint tasks.
  // Tasks without a wbs_path or assigned to a phase that is also their L1
  // root contribute their own phase number; absence contributes nothing.
  let activeSprintPhaseSpan = 0;
  if (activeSprint) {
    const phases = new Set<string>();
    for (const t of tasks) {
      if (t.sprintId !== activeSprint.id) continue;
      const wbs = t.wbs;
      if (!wbs) continue;
      const root = wbs.split('.')[0];
      if (root) phases.add(root);
    }
    activeSprintPhaseSpan = phases.size;
  }

  // "Summary tasks in sprints": annotation-only `isSummary` (RawSQL ltree on
  // the API) reaches the web client via TaskSerializer; assignments that
  // double-count velocity show up here even when each one passed the warn.
  const summaryInSprintCount = tasks.filter(
    (t) => t.isSummary && t.sprintId != null,
  ).length;

  const items: { key: string; label: string; tone: 'warn' | 'info' }[] = [];
  if (orphanCount > 0) {
    items.push({
      key: 'orphan',
      label: `${orphanCount} task${orphanCount === 1 ? '' : 's'} in no ${itl.lower} and no phase`,
      tone: 'info',
    });
  }
  if (activeSprintPhaseSpan >= 3) {
    items.push({
      key: 'span',
      label: `Active ${itl.lower} spans ${activeSprintPhaseSpan} phases`,
      tone: 'info',
    });
  }
  if (summaryInSprintCount > 0) {
    // ADR-0101 §2: never WBS jargon ("summary task" is explicitly forbidden).
    // "Parent task" is the term the rest of TruePPM uses for a task with children.
    items.push({
      key: 'summary',
      label: `${summaryInSprintCount} parent task${summaryInSprintCount === 1 ? '' : 's'} in a ${itl.lower}`,
      tone: 'warn',
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${itl.singular} health signals`}
      className="flex flex-wrap items-center gap-1.5"
    >
      {items.map((it) => (
        <span
          key={it.key}
          className={[
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs',
            it.tone === 'warn'
              ? 'border border-semantic-at-risk/40 text-semantic-at-risk bg-sem-at-risk-bg'
              : 'border border-neutral-border text-neutral-text-secondary bg-neutral-surface-raised',
          ].join(' ')}
        >
          <span aria-hidden="true">●</span>
          {it.label}
        </span>
      ))}
    </div>
  );
}
