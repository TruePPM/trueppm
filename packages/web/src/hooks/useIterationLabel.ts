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
 * reads instead of the literal "Sprint" — so the relabel is configurable. The
 * `no-restricted-syntax` iteration-label gate in eslint.config.js mechanically
 * enforces it: hard-coded "sprint" in JSX text or display attributes on the
 * container feature surfaces fails `web:lint` (#1287).
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
  // Read the server-resolved effective label (ADR-0116, #1106) — the workspace →
  // program → project inheritance is computed server-side, so the client never
  // re-derives precedence. Falls back to the raw override then the "Sprint" default
  // while the project query is loading or on a pre-#1106 payload.
  const effective =
    data?.effective_iteration_label ?? data?.iteration_label ?? DEFAULT_ITERATION_LABEL;
  return useMemo(() => iterationLabelForms(effective), [effective]);
}
