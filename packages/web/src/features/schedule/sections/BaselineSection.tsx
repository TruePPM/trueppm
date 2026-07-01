import type { DrawerSectionProps } from '@/lib/widget-registry';
import { useSurfaceVisibility } from '@/hooks/useSurfaceVisibility';
import { BaselineTab } from '../BaselineTab';

/**
 * Baseline — wraps the existing BaselineTab; baseline vs current comparison.
 *
 * Gated by the per-project `baselines` leaf-surface toggle (ADR-0193, issue 956):
 * when an ADMIN hides the surface, the section renders nothing so the drawer's
 * Activity tab drops the Baseline block. Hide-only (ADR-0041) — the baseline API
 * and data are untouched and the section returns the moment the toggle flips back.
 * The section owns the gate (rather than a registry `canRender`) because it already
 * receives `projectId`, and `canRender`'s context carries only `{ user, task }`.
 */
export function BaselineSection({ taskId, projectId }: DrawerSectionProps) {
  const surfaces = useSurfaceVisibility(projectId);
  if (!surfaces.baselines) return null;
  return <BaselineTab projectId={projectId} taskId={taskId} />;
}
