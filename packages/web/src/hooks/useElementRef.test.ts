/**
 * useElementRef unit tests (#2365).
 *
 * The point of this hook is that the node is *state*, so an effect that depends
 * on it re-runs when the node mounts late — the failure mode a `RefObject`
 * silently hides. These tests assert that contract directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEffect } from 'react';

import { useElementRef } from './useElementRef';

describe('useElementRef', () => {
  it('starts null and exposes the node once it is attached', () => {
    const el = document.createElement('div');
    const { result } = renderHook(() => useElementRef<HTMLDivElement>());

    expect(result.current.el).toBeNull();

    act(() => {
      result.current.setEl(el);
    });
    expect(result.current.el).toBe(el);
  });

  it('keeps a stable setter identity so React never re-attaches the ref', () => {
    const { result, rerender } = renderHook(() => useElementRef<HTMLDivElement>());
    const first = result.current.setEl;

    rerender();
    expect(result.current.setEl).toBe(first);

    act(() => {
      result.current.setEl(document.createElement('div'));
    });
    expect(result.current.setEl).toBe(first);
  });

  it('re-runs a dependent effect when the node mounts after the first commit', () => {
    // This is the whole reason the hook exists: with `useRef` the effect below
    // would run once against `null` and never again.
    const attach = vi.fn();
    const detach = vi.fn();

    const { result } = renderHook(() => {
      const { el, setEl } = useElementRef<HTMLDivElement>();
      useEffect(() => {
        if (!el) return;
        attach(el);
        return () => {
          detach(el);
        };
      }, [el]);
      return { setEl };
    });

    expect(attach).not.toHaveBeenCalled();

    const el = document.createElement('div');
    act(() => {
      result.current.setEl(el);
    });
    expect(attach).toHaveBeenCalledWith(el);
  });

  it('tears down and re-attaches when the node is swapped, and tears down on unmount', () => {
    const attach = vi.fn();
    const detach = vi.fn();

    const { result, unmount } = renderHook(() => {
      const { el, setEl } = useElementRef<HTMLDivElement>();
      useEffect(() => {
        if (!el) return;
        attach(el);
        return () => {
          detach(el);
        };
      }, [el]);
      return { setEl };
    });

    const first = document.createElement('div');
    const second = document.createElement('div');

    act(() => {
      result.current.setEl(first);
    });
    act(() => {
      result.current.setEl(second);
    });

    expect(detach).toHaveBeenCalledWith(first);
    expect(attach).toHaveBeenLastCalledWith(second);

    unmount();
    expect(detach).toHaveBeenCalledWith(second);
  });
});
