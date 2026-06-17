import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TaskNote } from '@/types';
import { useNotesSearch } from './useNotesSearch';

function note(overrides: Partial<TaskNote> = {}): TaskNote {
  return {
    id: 'n1',
    task: 't1',
    author: { id: 'u1', username: 'alice', display_name: 'Alice' },
    body: 'hello world',
    pinned: false,
    decision: false,
    edited_at: null,
    created_at: '2026-05-19T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

function twoNotes(): TaskNote[] {
  return [
    note({
      id: 'n1',
      body: 'database migration plan',
      author: { id: 'u1', username: 'alice', display_name: 'Alice' },
    }),
    note({
      id: 'n2',
      body: 'frontend rollout',
      author: { id: 'u2', username: 'bob', display_name: 'Bob' },
    }),
  ];
}

describe('useNotesSearch', () => {
  it('returns every note as a match for an empty query', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, ''));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.every((e) => e.matches)).toBe(true);
    expect(result.current.matchCount).toBe(2);
  });

  it('treats a whitespace-only query as empty (all match)', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, '   '));
    expect(result.current.entries.every((e) => e.matches)).toBe(true);
    expect(result.current.matchCount).toBe(2);
  });

  it('filters by a body substring', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, 'migration'));
    expect(result.current.matchCount).toBe(1);
    const byId = Object.fromEntries(result.current.entries.map((e) => [e.note.id, e.matches]));
    expect(byId.n1).toBe(true);
    expect(byId.n2).toBe(false);
  });

  it('filters by an author display-name substring', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, 'bob'));
    expect(result.current.matchCount).toBe(1);
    const byId = Object.fromEntries(result.current.entries.map((e) => [e.note.id, e.matches]));
    expect(byId.n2).toBe(true);
    expect(byId.n1).toBe(false);
  });

  it('matches case-insensitively', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, 'MIGRATION'));
    expect(result.current.matchCount).toBe(1);
    expect(result.current.entries.find((e) => e.note.id === 'n1')?.matches).toBe(true);
  });

  it('preserves input order in the annotated entries', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, ''));
    expect(result.current.entries.map((e) => e.note.id)).toEqual(['n1', 'n2']);
  });

  it('returns a zero match count when nothing matches', () => {
    const notes = twoNotes();
    const { result } = renderHook(() => useNotesSearch(notes, 'nonexistent'));
    expect(result.current.matchCount).toBe(0);
    expect(result.current.entries.every((e) => !e.matches)).toBe(true);
  });

  it('tolerates a note with no author', () => {
    const notes = [note({ id: 'n1', body: 'orphan note', author: null })];
    const { result } = renderHook(() => useNotesSearch(notes, 'orphan'));
    expect(result.current.matchCount).toBe(1);
    expect(result.current.entries[0].matches).toBe(true);
  });
});
