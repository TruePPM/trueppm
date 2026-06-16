/**
 * useBacklogUrlState — the single owner of the backlog's URL-encoded toolbar
 * and pane state (decision D8). The parsing of malformed params and the
 * pane-mode transitions (select clears create/pull, openPull sets item+pull,
 * resetFilters keeps item/search) are the regression-prone parts, so they get
 * direct coverage here. State lives in `useSearchParams`, so each case drives a
 * `MemoryRouter` and asserts on the rendered `BacklogUrlState`.
 */

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useBacklogUrlState } from './useBacklogUrlState';

function setup(initialUrl = '/backlog') {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initialUrl] }, children);
  }
  return renderHook(() => useBacklogUrlState(), { wrapper: Wrapper });
}

describe('useBacklogUrlState parsing', () => {
  it('reads every param into typed state', () => {
    const { result } = setup(
      '/backlog?q=tele&status=PULLED&type=story,bug&tags=alpha,beta&item=BI-9&pulled=1',
    );
    expect(result.current.query).toBe('tele');
    expect(result.current.status).toBe('PULLED');
    expect(result.current.types).toEqual(['story', 'bug']);
    expect(result.current.tags).toEqual(['alpha', 'beta']);
    expect(result.current.selectedItemId).toBe('BI-9');
    expect(result.current.pulledOpen).toBe(true);
  });

  it('defaults to empty state with no params', () => {
    const { result } = setup('/backlog');
    expect(result.current.query).toBe('');
    expect(result.current.status).toBeNull();
    expect(result.current.types).toEqual([]);
    expect(result.current.tags).toEqual([]);
    expect(result.current.selectedItemId).toBeNull();
    expect(result.current.isNew).toBe(false);
    expect(result.current.isPull).toBe(false);
    expect(result.current.pulledOpen).toBe(false);
  });

  it('drops unknown status and type values rather than trusting the URL', () => {
    const { result } = setup('/backlog?status=BOGUS&type=story,notatype');
    expect(result.current.status).toBeNull();
    expect(result.current.types).toEqual(['story']);
  });

  it('reads the new / pull pane flags', () => {
    const { result } = setup('/backlog?new=1');
    expect(result.current.isNew).toBe(true);
    const { result: pullResult } = setup('/backlog?item=BI-1&pull=1');
    expect(pullResult.current.isPull).toBe(true);
  });
});

describe('useBacklogUrlState setters', () => {
  it('sets and clears the search query', () => {
    const { result } = setup();
    act(() => result.current.setQuery('polaris'));
    expect(result.current.query).toBe('polaris');
    act(() => result.current.clearSearch());
    expect(result.current.query).toBe('');
  });

  it('drops an empty query string rather than persisting q=', () => {
    const { result } = setup('/backlog?q=x');
    act(() => result.current.setQuery(''));
    expect(result.current.query).toBe('');
  });

  it('joins/clears the type and tag facets', () => {
    const { result } = setup();
    act(() => result.current.setTypes(['epic', 'spike']));
    expect(result.current.types).toEqual(['epic', 'spike']);
    act(() => result.current.setTypes([]));
    expect(result.current.types).toEqual([]);

    act(() => result.current.setTags(['x', 'y']));
    expect(result.current.tags).toEqual(['x', 'y']);
    act(() => result.current.setTags([]));
    expect(result.current.tags).toEqual([]);
  });

  it('resetFilters clears facets but keeps search and selection', () => {
    const { result } = setup('/backlog?q=keep&status=PULLED&type=bug&tags=t&item=BI-5');
    act(() => result.current.resetFilters());
    expect(result.current.status).toBeNull();
    expect(result.current.types).toEqual([]);
    expect(result.current.tags).toEqual([]);
    expect(result.current.query).toBe('keep');
    expect(result.current.selectedItemId).toBe('BI-5');
  });

  it('selectItem opens the detail pane and clears create/pull modes', () => {
    const { result } = setup('/backlog?new=1&pull=1');
    act(() => result.current.selectItem('BI-3'));
    expect(result.current.selectedItemId).toBe('BI-3');
    expect(result.current.isNew).toBe(false);
    expect(result.current.isPull).toBe(false);
  });

  it('selectItem(null) clears the selection', () => {
    const { result } = setup('/backlog?item=BI-3');
    act(() => result.current.selectItem(null));
    expect(result.current.selectedItemId).toBeNull();
  });

  it('openCreate swaps to the create form and clears item/pull', () => {
    const { result } = setup('/backlog?item=BI-3&pull=1');
    act(() => result.current.openCreate());
    expect(result.current.isNew).toBe(true);
    expect(result.current.selectedItemId).toBeNull();
    expect(result.current.isPull).toBe(false);
  });

  it('openPull selects the item and enters pull mode; closePull leaves it selected', () => {
    const { result } = setup('/backlog?new=1');
    act(() => result.current.openPull('BI-7'));
    expect(result.current.selectedItemId).toBe('BI-7');
    expect(result.current.isPull).toBe(true);
    expect(result.current.isNew).toBe(false);

    act(() => result.current.closePull());
    expect(result.current.isPull).toBe(false);
    expect(result.current.selectedItemId).toBe('BI-7');
  });

  it('closeDetail clears item, create, and pull together', () => {
    const { result } = setup('/backlog?item=BI-7&new=1&pull=1');
    act(() => result.current.closeDetail());
    expect(result.current.selectedItemId).toBeNull();
    expect(result.current.isNew).toBe(false);
    expect(result.current.isPull).toBe(false);
  });

  it('toggles the pulled section open flag', () => {
    const { result } = setup();
    act(() => result.current.setPulledOpen(true));
    expect(result.current.pulledOpen).toBe(true);
    act(() => result.current.setPulledOpen(false));
    expect(result.current.pulledOpen).toBe(false);
  });
});
