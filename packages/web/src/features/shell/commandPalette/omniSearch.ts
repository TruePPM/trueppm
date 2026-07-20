/**
 * Pure helpers for the ⌘K global Epic/Story omni-search result rows (ADR-0508 D4,
 * #2103). Kept free of React/router so the breadcrumb, routing, and grouping logic
 * is unit-testable in isolation — `useCommandItems` supplies `go` (the navigate
 * wrapper) and folds the returned items into the palette list.
 */
import type { OmniSearchResult } from '@/api/types';
import type { CommandGroup, CommandItem } from './commandItems';

/** The agile-hierarchy glyph. The breadcrumb uses this (not the ` · ` dot the rest
 *  of the palette uses) to echo the "Epic ▸ Story" vocabulary the PO persona asked
 *  for — an explicit parent→child reading, never a WBS code. */
const SEP = ' ▸ ';

/** Which palette group a result lands in — keyed on the agile `type`, so a task
 *  epic and a backlog epic share the "Epics" group. Anything that is not an epic
 *  (story, or a task if ever requested) falls to Stories. */
export function omniSearchGroup(result: OmniSearchResult): CommandGroup {
  return result.type === 'epic' ? 'epic' : 'story';
}

/** The muted breadcrumb subtitle — agile vocabulary only (program ▸ project ▸
 *  parent epic), never a WBS code. A backlog item is program-level intake, so it
 *  reads `{program} ▸ Backlog`; a story shows its parent epic so the PO sees which
 *  epic it belongs to. */
export function omniSearchBreadcrumb(result: OmniSearchResult): string {
  if (result.kind === 'backlog_item') {
    return [result.program_name, 'Backlog'].filter(Boolean).join(SEP);
  }
  return [result.program_name, result.project_name, result.parent_epic_name]
    .filter(Boolean)
    .join(SEP);
}

/** The deep-link a selected result navigates to, or null when it cannot be routed
 *  (a task with no project, or a backlog item with no program — neither should
 *  occur, but the palette must never build an item that navigates nowhere). A task
 *  opens the schedule with the drawer deep-linked (`?task=`); a backlog item lands
 *  on its program backlog. */
export function omniSearchRoute(result: OmniSearchResult): string | null {
  if (result.kind === 'backlog_item') {
    return result.program_id ? `/programs/${result.program_id}/backlog` : null;
  }
  return result.project_id
    ? `/projects/${result.project_id}/schedule?task=${result.id}`
    : null;
}

/**
 * Map the server search results into palette command items. Order is preserved
 * from the server (already ranked prefix-first then alphabetically), so the flat
 * list drives rendering and keyboard nav identically. Results that cannot be routed
 * are dropped rather than rendered as dead rows.
 */
export function buildOmniSearchItems(
  results: OmniSearchResult[],
  go: (path: string) => () => void,
): CommandItem[] {
  const items: CommandItem[] = [];
  for (const result of results) {
    const path = omniSearchRoute(result);
    if (path === null) continue;
    const group = omniSearchGroup(result);
    items.push({
      id: `omni:${result.kind}:${result.id}`,
      label: result.title,
      group,
      // Agile vocabulary chip — "Epic" / "Story" — never a WBS type.
      tag: group === 'epic' ? 'Epic' : 'Story',
      detail: omniSearchBreadcrumb(result),
      keywords: [
        result.type,
        result.program_name ?? '',
        result.project_name ?? '',
        result.parent_epic_name ?? '',
        result.kind === 'backlog_item' ? 'backlog' : '',
      ].join(' '),
      run: go(path),
    });
  }
  return items;
}
