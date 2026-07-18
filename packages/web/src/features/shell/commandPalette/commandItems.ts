/**
 * Command-palette item model + the pure fuzzy filter (v2 design system).
 *
 * Kept free of React/router so the matching logic is unit-testable in isolation.
 * The live items (which close over `navigate` and the data hooks) are assembled
 * in `useCommandItems`.
 */

/**
 * Result sections (ADR-0138, issue 647; `sprint` added issue 1594; `person` added
 * ADR-0401/#1940; `sprintTask` + `recent` added ADR-0508/#1557). `sprint` leads as
 * the first-class "jump to current sprint" action; `sprintTask` (active-sprint
 * tasks) and `task` (all other tasks) and `current` are Tier-2 (current project
 * only); `person` is a global, query-gated people search; `recent` is the
 * cold-only recently-visited-projects strip; the rest are Tier-1 (all reachable
 * projects) or global.
 */
export type CommandGroup =
  | 'sprint'
  | 'sprintTask'
  | 'task'
  | 'current'
  | 'person'
  | 'recent'
  | 'jump'
  | 'backlog'
  | 'board'
  | 'action';

export interface CommandItem {
  /** Stable id for React keys and active-item tracking. */
  id: string;
  /** Visible label. */
  label: string;
  group: CommandGroup;
  /** Short type tag shown as a calm mono chip ("View" / "Project" / "Task" / "Sprint" …). */
  tag: string;
  /** Muted context shown between the label and the chip (e.g. a task's "1.4.2 · In progress"). */
  detail?: string;
  /** Extra text folded into the match (e.g. a project's program name, a task's short id). */
  keywords?: string;
  /** Marks an edition-gated destination so the UI can badge it. */
  gated?: boolean;
  /** Invoked when the item is chosen. */
  run: () => void;
}

/**
 * Case-insensitive substring match over label + tag + detail + keywords. Empty
 * query returns everything (so the palette shows the full list on open). Order is
 * preserved from the input — callers pre-order by relevance/section.
 */
export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) =>
    `${item.label} ${item.tag} ${item.detail ?? ''} ${item.keywords ?? ''}`
      .toLowerCase()
      .includes(q),
  );
}
