/**
 * URL-synced task-selection round-trip (issues #2031, #2046).
 *
 * These tests pin the two behaviors the Board/Sprints views rely on and that a
 * naive re-implementation gets wrong:
 *  1. the selection is seeded from `?<key>=` on first render (deep-link opens the
 *     drawer without an extra effect pass), and
 *  2. the mirror-back write is skipped when the URL already matches — the guard
 *     that stops the mount pass from clobbering a sibling param (#2031).
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { useUrlSelectedId } from './useUrlSelectedId';

function wrapperFor(initialEntry: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initialEntry] }, children);
  };
}

/** Render the hook alongside a live view of the current search string. */
function renderWithUrl(key: string, initialEntry: string) {
  return renderHook(
    () => {
      const [selectedId, setSelectedId] = useUrlSelectedId(key);
      const [params] = useSearchParams();
      return { selectedId, setSelectedId, search: params.toString() };
    },
    { wrapper: wrapperFor(initialEntry) },
  );
}

describe('useUrlSelectedId', () => {
  it('seeds the selection from the query param on first render', () => {
    const { result } = renderWithUrl('task', '/board?task=abc');
    expect(result.current.selectedId).toBe('abc');
  });

  it('defaults to null when the param is absent', () => {
    const { result } = renderWithUrl('task', '/board');
    expect(result.current.selectedId).toBeNull();
  });

  it('does not rewrite the URL when it already reflects the seeded selection', () => {
    const { result } = renderWithUrl('task', '/board?task=abc&sprint=s1');
    // The guard must leave sibling params untouched — a redundant mount write is
    // exactly what wiped `?sprint=` in the #2031 regression.
    expect(result.current.search).toBe('task=abc&sprint=s1');
  });

  it('mirrors a new selection into the URL', () => {
    const { result } = renderWithUrl('task', '/board');
    act(() => result.current.setSelectedId('xyz'));
    expect(result.current.search).toBe('task=xyz');
    expect(result.current.selectedId).toBe('xyz');
  });

  it('drops the key when the selection is cleared', () => {
    const { result } = renderWithUrl('task', '/board?task=abc');
    act(() => result.current.setSelectedId(null));
    expect(result.current.search).toBe('');
    expect(result.current.selectedId).toBeNull();
  });

  it('preserves sibling params when the selection changes', () => {
    const { result } = renderWithUrl('task', '/board?sprint=s1');
    act(() => result.current.setSelectedId('abc'));
    expect(result.current.search).toContain('sprint=s1');
    expect(result.current.search).toContain('task=abc');
  });
});
