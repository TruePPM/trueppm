import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { TaskLink } from '@/types';
import { useDependencyHover } from './useDependencyHover';

function link(id: string, sourceId: string, targetId: string): TaskLink {
  return { id, sourceId, targetId, type: 'FS', lag: 0, isCritical: false };
}

describe('useDependencyHover', () => {
  // 1.1 → 1.2 → 1.3 → 1.4; plus 1.5 (unrelated).
  //   pred(1.3) = {1.2, 1.1}
  //   succ(1.3) = {1.4}
  const links: TaskLink[] = [
    link('l1', '1.1', '1.2'),
    link('l2', '1.2', '1.3'),
    link('l3', '1.3', '1.4'),
  ];

  it('returns the empty chain when no task is hovered', () => {
    const { result } = renderHook(() => useDependencyHover(null, links));
    expect(result.current.hoveredId).toBeNull();
    expect(result.current.predecessors.size).toBe(0);
    expect(result.current.successors.size).toBe(0);
    expect(result.current.chain.size).toBe(0);
  });

  it('resolves the transitive predecessor and successor sets via BFS', async () => {
    const { result } = renderHook(() => useDependencyHover('1.3', links));
    await waitFor(() => expect(result.current.hoveredId).toBe('1.3'));
    expect(Array.from(result.current.predecessors).sort()).toEqual(['1.1', '1.2']);
    expect(Array.from(result.current.successors).sort()).toEqual(['1.4']);
    expect(Array.from(result.current.chain).sort()).toEqual(['1.1', '1.2', '1.3', '1.4']);
  });

  it('returns predecessors-only when hovering a leaf', async () => {
    const { result } = renderHook(() => useDependencyHover('1.4', links));
    await waitFor(() =>
      expect(Array.from(result.current.predecessors).sort()).toEqual(['1.1', '1.2', '1.3']),
    );
    expect(result.current.successors.size).toBe(0);
  });

  it('returns successors-only when hovering a root', async () => {
    const { result } = renderHook(() => useDependencyHover('1.1', links));
    await waitFor(() =>
      expect(Array.from(result.current.successors).sort()).toEqual(['1.2', '1.3', '1.4']),
    );
    expect(result.current.predecessors.size).toBe(0);
  });

  it('returns the empty chain for a task with no dep edges', async () => {
    const { result } = renderHook(() => useDependencyHover('1.5', links));
    await waitFor(() => expect(result.current.hoveredId).toBe('1.5'));
    expect(result.current.predecessors.size).toBe(0);
    expect(result.current.successors.size).toBe(0);
    expect(Array.from(result.current.chain)).toEqual(['1.5']);
  });

  it('does not loop forever on a cyclic dep graph (defensive)', async () => {
    // The API rejects cycles (ADR-0055) but the BFS must still terminate if
    // bad data ever lands on the client.
    const cyclic: TaskLink[] = [
      link('l1', 'a', 'b'),
      link('l2', 'b', 'c'),
      link('l3', 'c', 'a'),
    ];
    const { result } = renderHook(() => useDependencyHover('a', cyclic));
    await waitFor(() => expect(result.current.chain.size).toBe(3));
  });

  it('debounces rapid hover transitions through a settle delay', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useDependencyHover(id, links),
      { initialProps: { id: null as string | null } },
    );
    // Three transitions in quick succession — the prior settle timers are
    // cancelled on each new value, so only the final id resolves.
    rerender({ id: '1.1' as string | null });
    rerender({ id: '1.2' as string | null });
    rerender({ id: '1.3' as string | null });
    await waitFor(() => expect(result.current.hoveredId).toBe('1.3'));
    expect(result.current.predecessors.has('1.2')).toBe(true);
  });

  it('clears the chain immediately when hoveredId transitions to null', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useDependencyHover(id, links),
      { initialProps: { id: '1.3' as string | null } },
    );
    await waitFor(() => expect(result.current.hoveredId).toBe('1.3'));
    rerender({ id: null });
    // No settle wait — null applies on the next React tick.
    await waitFor(() => expect(result.current.hoveredId).toBeNull());
    expect(result.current.chain.size).toBe(0);
  });
});
