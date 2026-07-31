import { useProject } from '@/hooks/useProject';
import { formatStoryPoints, storyPointsUnit } from '@/lib/storyPoints';
import { ABBREVIATIONS } from '@/lib/abbreviations';
import { Tooltip } from '@/components/Tooltip';
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

/** One-clause reading of each readiness word, for the tooltip on the pointed
 *  branch (#2662) — the bare label alone answers "what stage" but not "what does
 *  that stage mean", which is exactly the gap the chip's tooltip exists to close. */
const READINESS_MEANING: Record<TaskReadiness, string> = {
  idea: 'not yet sized or refined',
  estimated: 'sized, not yet marked ready for a sprint',
  ready: 'sized and ready to pull into a sprint',
  baselined: 'sized and locked into a committed baseline',
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
 *
 * Both branches carry a `Tooltip` (#2662, web-rule 287): on a Hybrid project the
 * amber "Unestimated" chip can sit right above a fully populated PERT estimate in
 * the `ESTIMATES` section, which reads as a contradiction unless the chip can
 * explain that it means *story points specifically*, separate from the duration
 * estimate. The explanation was previously carried only in `aria-label` — visible
 * to screen readers, invisible to sighted mouse/touch users. `describe={false}`
 * on both because the tooltip sentence restates the trigger's own `aria-label`
 * (the `MethodologyIndicator` "WF" precedent) — the panel renders `aria-hidden` so
 * assistive tech hears the explanation once, from the label, instead of twice.
 */
export function HeaderEstimateChip({ task, projectId }: { task: Task; projectId: string }) {
  const { data: project } = useProject(projectId);
  const scale = project?.effective_estimation_scale ?? 'fibonacci';
  const usesPoints =
    project?.effective_methodology === 'AGILE' || project?.effective_methodology === 'HYBRID';
  const readinessLabel = task.readiness ? READINESS_LABEL[task.readiness] : null;
  const readinessMeaning = task.readiness ? READINESS_MEANING[task.readiness] : null;

  // Estimated — a concrete point value: "{pts} · {Readiness}".
  if (task.storyPoints != null) {
    const pts = `${formatStoryPoints(task.storyPoints, scale)}${storyPointsUnit(task.storyPoints, scale)}`;
    // Single sentence carried as both the accessible name and the visible
    // tooltip (#2662) — the bare "{pts} · {Readiness}" chip compounds two ideas
    // (a point value on the project's scale, and a grooming-stage word) with no
    // reading available for either.
    const explanation = `${pts} on this project's estimation scale — ${ABBREVIATIONS.STORY_POINTS_PURPOSE}.${
      readinessLabel ? ` ${readinessLabel}: ${readinessMeaning}.` : ''
    }`;
    return (
      <Tooltip content={explanation} describe={false}>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-px rounded-chip bg-neutral-surface-sunken border border-neutral-border text-xs text-neutral-text-secondary"
          aria-label={explanation}
        >
          <span className="tppm-mono font-medium text-neutral-text-primary">{pts}</span>
          {readinessLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span>{readinessLabel}</span>
            </>
          )}
        </span>
      </Tooltip>
    );
  }

  // Points-based leaf task with no estimate → the explicit amber prompt.
  if (usesPoints && !task.isSummary && !task.isMilestone) {
    return (
      <Tooltip content={ABBREVIATIONS.UNESTIMATED} describe={false}>
        <span
          className="inline-flex items-center px-1.5 py-px rounded-chip border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-xs font-medium text-semantic-at-risk"
          aria-label={ABBREVIATIONS.UNESTIMATED}
        >
          Unestimated
        </span>
      </Tooltip>
    );
  }

  // Waterfall / non-points context (or a rollup) → the plain readiness chip.
  return task.readiness ? <ReadinessChip readiness={task.readiness} /> : null;
}
