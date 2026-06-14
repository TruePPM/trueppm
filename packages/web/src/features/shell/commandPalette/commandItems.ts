/**
 * Command-palette item model + the pure fuzzy filter (v2 design system).
 *
 * Kept free of React/router so the matching logic is unit-testable in isolation.
 * The live items (which close over `navigate` and the data hooks) are assembled
 * in `useCommandItems`.
 */

export type CommandGroup = 'jump' | 'action';

export interface CommandItem {
  /** Stable id for React keys and active-item tracking. */
  id: string;
  /** Visible label. */
  label: string;
  group: CommandGroup;
  /** Short type tag shown as a calm mono chip ("View" / "Program" / "Project" / "Action"). */
  tag: string;
  /** Extra text folded into the match (e.g. a project's program name). */
  keywords?: string;
  /** Marks an edition-gated destination so the UI can badge it. */
  gated?: boolean;
  /** Invoked when the item is chosen. */
  run: () => void;
}

/**
 * Case-insensitive substring match over label + tag + keywords. Empty query
 * returns everything (so the palette shows the full list on open). Order is
 * preserved from the input — callers pre-order by relevance/section.
 */
export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) =>
    `${item.label} ${item.tag} ${item.keywords ?? ''}`.toLowerCase().includes(q),
  );
}
