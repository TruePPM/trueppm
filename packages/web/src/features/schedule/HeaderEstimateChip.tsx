import { useProject } from '@/hooks/useProject';
import { formatStoryPoints, storyPointsUnit } from '@/lib/storyPoints';
import { ReadinessChip } from '../board/ReadinessChip';
import type { Task, TaskReadiness } from '@/types';

/** Sentence-case readiness word for the header chip (the pre-#2315 chip showed
 *  the bare lowercase state, e.g. a cryptic leading "· estimated"). */
const READINESS_LABEL: Record<TaskReadiness, string> = {
  idea: 'Idea',
  estimated: 'Estimated',
  ready: 'Ready',
  baselined: 'Baselined',
};

/**
 * Task-drawer header estimate chip (#2315, Drawer v2 slice 3).
 *
 * Replaces the cryptic unlabeled "· estimated" / bare points badge with a
 * labeled, scale-aware chip:
 *   - estimated → `2.5 pts · Estimated` (points via the project's estimation
 *     scale — a T-shirt "M" drops the " pts" unit; readiness sentence-cased);
 *   - a points-based (Agile/Hybrid) leaf task with no estimate → amber
 *     `Unestimated`, the explicit "needs an estimate" signal.
 *
 * "Unestimated" is **methodology-gated**: a Waterfall task estimates by duration,
 * not story points, so it must never be scolded for a missing point value — it
 * falls back to the plain readiness chip. Summary/milestone tasks (rollups /
 * zero-span markers) are never "unestimated" either.
 */
export function HeaderEstimateChip({ task, projectId }: { task: Task; projectId: string }) {
  const { data: project } = useProject(projectId);
  const scale = project?.effective_estimation_scale ?? 'fibonacci';
  const usesPoints =
    project?.effective_methodology === 'AGILE' || project?.effective_methodology === 'HYBRID';
  const readinessLabel = task.readiness ? READINESS_LABEL[task.readiness] : null;

  // Estimated — a concrete point value: "{pts} · {Readiness}".
  if (task.storyPoints != null) {
    const pts = `${formatStoryPoints(task.storyPoints, scale)}${storyPointsUnit(task.storyPoints, scale)}`;
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-chip bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary"
        aria-label={`Estimate ${pts}${readinessLabel ? `, ${readinessLabel}` : ''}`}
      >
        <span className="tppm-mono font-medium text-neutral-text-primary">{pts}</span>
        {readinessLabel && (
          <>
            <span aria-hidden="true">·</span>
            <span>{readinessLabel}</span>
          </>
        )}
      </span>
    );
  }

  // Points-based leaf task with no estimate → the explicit amber prompt.
  if (usesPoints && !task.isSummary && !task.isMilestone) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-px rounded-chip border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-xs font-medium text-semantic-at-risk"
        aria-label="Unestimated — no story-point estimate yet"
      >
        Unestimated
      </span>
    );
  }

  // Waterfall / non-points context (or a rollup) → the plain readiness chip.
  return task.readiness ? <ReadinessChip readiness={task.readiness} /> : null;
}
