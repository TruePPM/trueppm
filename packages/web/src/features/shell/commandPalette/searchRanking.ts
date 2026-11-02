/**
 * Pure ranking + fallback rules for the ⌘K palette (#4504).
 *
 * Kept free of React/router so the rules are unit-testable in isolation, like
 * `commandItems.ts`.
 */
import { groupedVisibleViews } from '@/features/shell/methodologyTabs';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { iterationLabelForms } from '@/lib/iterationLabel';
import { projectPath } from '@/lib/refPath';
import type { Methodology } from '@/types';
import type { CommandItem } from './commandItems';

/**
 * Entity precedence when a query is an exact or prefix match for a name:
 * Project > Program > View (> Task, which is never promoted and so always renders
 * below). Keyed by the chip tag the `jump` builders assign.
 */
const ENTITY_RANK: Record<string, number> = { Project: 0, Program: 1, View: 2 };

/**
 * Hoist `jump` rows whose name EXACTLY equals or STARTS WITH the query into a
 * leading `best` group, ordered Project > Program > View, exact before prefix within a kind.
 *
 * Why a group move and not a sort: the palette renders by group, and `task` rows
 * sit above `jump` in that order, so typing "Platform Core" put the task
 * "Platform Core GA" first and Enter opened it instead of the project. Substring
 * matches are deliberately not promoted: a project that merely contains the query
 * mid-name is no better a hit than a task that does.
 */
export function promoteTopMatches(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const promoted: { item: CommandItem; entity: number; exact: boolean; order: number }[] = [];
  const rest: CommandItem[] = [];
  items.forEach((item, order) => {
    const entity = item.group === 'jump' ? ENTITY_RANK[item.tag] : undefined;
    const name = item.label.trim().toLowerCase();
    if (entity === undefined || !name.startsWith(q)) {
      rest.push(item);
      return;
    }
    promoted.push({ item, entity, exact: name === q, order });
  });
  if (promoted.length === 0) return items;
  promoted.sort(
    (a, b) => a.entity - b.entity || Number(b.exact) - Number(a.exact) || a.order - b.order,
  );
  return [...promoted.map((p) => ({ ...p.item, group: 'best' as const })), ...rest];
}

/** Minimal project shape the fallback needs (a subset of the list payload). */
interface ViewSearchProject {
  id: string;
  name: string;
  code?: string;
  methodology?: Methodology;
  /** Server-resolved iteration term; names the `sprints` view (ADR-0203 §12). */
  effectiveIterationLabel?: string | null;
}

/**
 * Views behind a per-project role gate (Team: Scheduler+, Settings: admin) the list payload
 * does not carry; offering them would risk a dead link, so they are left out.
 */
const ROLE_GATED_VIEWS = new Set(['resources', 'settings']);

/**
 * When a query matches nothing, list the views other projects DO have, e.g.
 * "Sprints — Platform Core". Derived from data the palette already loads (the
 * projects list + the methodology visibility matrix), so it adds no request and
 * lists only projects the caller can already see and views that methodology shows.
 * Views a project turned off through a per-project surface toggle are not knowable
 * from the list payload; landing there still resolves (hidden views stay reachable
 * by URL, ADR-0041).
 */
export function buildCrossProjectViewItems(
  projects: readonly ViewSearchProject[] | undefined,
  query: string,
  go: (path: string) => () => void,
): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix: CommandItem[] = [];
  const contains: CommandItem[] = [];
  for (const project of projects ?? []) {
    const views = groupedVisibleViews(project.methodology ?? 'HYBRID').flatMap(
      (g) => g.visibleViews,
    );
    for (const view of views) {
      // `sprints` is named by the project's configured iteration term, as on the
      // rail and in the direct-match path (ADR-0203 §12).
      const label =
        view === 'sprints'
          ? iterationLabelForms(project.effectiveIterationLabel).plural
          : VIEW_TAB_META[view]?.label;
      if (!label || ROLE_GATED_VIEWS.has(view)) continue;
      const name = label.toLowerCase();
      if (!name.includes(q)) continue;
      (name.startsWith(q) ? prefix : contains).push({
        id: `projectview:${project.id}:${view}`,
        label: `${label} — ${project.name}`,
        group: 'projectView',
        tag: 'View',
        run: go(projectPath(project, view)),
      });
    }
  }
  return [...prefix, ...contains];
}
