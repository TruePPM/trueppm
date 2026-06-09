import { useMemo } from 'react';
import { useProject } from './useProject';
import { useProjectId } from './useProjectId';
import {
  iterationLabelForms,
  DEFAULT_ITERATION_LABEL,
  type IterationLabelForms,
} from '@/lib/iterationLabel';

/**
 * Resolve the active project's iteration-container label into all display forms
 * (ADR-0111, #862). This is the single chokepoint every sprint-container surface
 * reads instead of the literal "Sprint" — so the relabel is configurable and the
 * grep gate ("no hard-coded container 'Sprint'") is mechanically verifiable.
 *
 * `projectId` defaults to the current route's project (`useProjectId`), so most
 * call sites use it with no arguments. While the project query is loading or
 * absent it resolves to the "Sprint" default, so copy never flashes empty.
 *
 * Display-only: this never gates tabs, routes, or behavior — that is
 * `effective_methodology` (ADR-0041/0107), a separate concern.
 */
export function useIterationLabel(projectId?: string | null): IterationLabelForms {
  const routeProjectId = useProjectId();
  const id = projectId ?? routeProjectId;
  const { data } = useProject(id);
  return useMemo(
    () => iterationLabelForms(data?.iteration_label ?? DEFAULT_ITERATION_LABEL),
    [data?.iteration_label],
  );
}
