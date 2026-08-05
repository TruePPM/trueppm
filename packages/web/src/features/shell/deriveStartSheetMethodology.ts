import type { Methodology } from '@/types';
import type { ProjectTemplate } from '@/hooks/useProjectTemplates';

/** The three peer ways into a new project (#2728). A fourth, "Seed from a brief", is
 *  explicitly cut from this issue's scope — do not add it here without a new ADR. */
export type WayIn = 'template' | 'blank' | 'import';

/** Human label + which views each methodology shows, for the derived caption line. */
const METHODOLOGY_LABEL: Record<Methodology, string> = {
  WATERFALL: 'Waterfall',
  AGILE: 'Agile',
  HYBRID: 'Hybrid',
};

const METHODOLOGY_VIEWS: Record<Methodology, string> = {
  WATERFALL: 'Gantt, WBS, and critical path',
  AGILE: 'Board, velocity, and burndown',
  HYBRID: 'Every scheduling and delivery view',
};

export interface DerivedMethodology {
  methodology: Methodology;
  /** "Waterfall — Gantt, WBS, and critical path" */
  caption: string;
}

/**
 * Methodology is derived, never asked (#2728) — this is the one read-only line the
 * Start sheet shows for whichever way-in is currently selected. It states which
 * views the project will carry as a *consequence* of the structure chosen above; it
 * never enforces anything, and it stays changeable afterward in project settings
 * (ADR-0041).
 *
 * - **Template**: the source project's methodology at publish time
 *   (`ProjectTemplate.methodology`, ADR-0791) — never re-derived from the current
 *   program/workspace, because the template's own shape (a Gantt-heavy phase set, a
 *   sprint-shaped backlog, …) is what actually determines which views make sense.
 * - **Blank / Import**: neither carries a shape of its own, so the ADR-0107 chain
 *   applies — `program.effective_methodology` if a program is selected, else the
 *   workspace default. Both are already in flight for the sheet's other fields
 *   (the program picker's data, the calendar default's data), so this never costs an
 *   extra request.
 */
export function deriveStartSheetMethodology(params: {
  way: WayIn;
  template: ProjectTemplate | null;
  programEffectiveMethodology: Methodology | null;
  workspaceMethodology: Methodology | undefined;
}): DerivedMethodology {
  const { way, template, programEffectiveMethodology, workspaceMethodology } = params;
  const methodology: Methodology =
    way === 'template' && template
      ? template.methodology
      : (programEffectiveMethodology ?? workspaceMethodology ?? 'HYBRID');

  return {
    methodology,
    caption: `${METHODOLOGY_LABEL[methodology]} — ${METHODOLOGY_VIEWS[methodology]}`,
  };
}
