import { useMemo } from 'react';
import type { TaskNote } from '@/types';

/** A note paired with whether it matches the active search query. */
export interface NotesSearchEntry {
  note: TaskNote;
  /** True when the note matches the active query (full opacity); dimmed otherwise. */
  matches: boolean;
}

/** The annotated list plus a count of matching notes. */
export interface NotesSearchResult {
  /** Every note, in input order, each annotated with its match state. */
  entries: NotesSearchEntry[];
  /** Number of matching notes — equals `notes.length` when the query is empty. */
  matchCount: number;
}

/**
 * Client-side dim-search over an already-fetched note list (ADR-0143).
 *
 * Filters notes by a case-insensitive substring of the body or the author's
 * display name. An empty (or whitespace-only) query matches every note, so the
 * caller renders the full list at full opacity with no counter. Matching is
 * computed entirely client-side over the in-memory list — there is no server
 * round-trip.
 *
 * Args:
 *   notes: The fetched notes to search over.
 *   query: The raw search query; leading/trailing whitespace is ignored.
 *
 * Returns:
 *   A {@link NotesSearchResult} with each note annotated by its match state and
 *   the count of matching notes.
 */
export function useNotesSearch(notes: TaskNote[], query: string): NotesSearchResult {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    // Empty query ⇒ every note matches (full opacity, no counter).
    if (!q) {
      return {
        entries: notes.map((note) => ({ note, matches: true })),
        matchCount: notes.length,
      };
    }
    let matchCount = 0;
    const entries = notes.map((note) => {
      const hay = `${note.body} ${note.author?.display_name ?? ''}`.toLowerCase();
      const matches = hay.includes(q);
      if (matches) matchCount += 1;
      return { note, matches };
    });
    return { entries, matchCount };
  }, [notes, query]);
}
