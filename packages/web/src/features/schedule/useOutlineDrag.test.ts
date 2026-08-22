import type React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOutlineDrag, LONG_PRESS_MS } from './useOutlineDrag';
import type { OutlineDragRow, OutlineMovePlan } from './outlineDrag';

const ROW_H = 28;

const ROWS: OutlineDragRow[] = [
  { id: 'phase', name: 'Mobilization', wbs: '1', parentId: null, isMilestone: false, hasChildren: true },
  { id: 'a', name: 'Survey', wbs: '1.1', parentId: 'phase', isMilestone: false, hasChildren: false },
  { id: 'gate', name: 'NTP', wbs: '2', parentId: null, isMilestone: true, hasChildren: false },
  { id: 'tail', name: 'Closeout', wbs: '3', parentId: null, isMilestone: false, hasChildren: false },
];

/** A React.PointerEvent stand-in — only the fields `startDrag` reads. */
function down(over: Partial<{ clientX: number; clientY: number; button: number }> = {}) {
  return {
    clientX: over.clientX ?? 0,
    clientY: over.clientY ?? 0,
    button: over.button ?? 0,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  } as unknown as React.PointerEvent;
}

function windowPointer(type: 'pointermove' | 'pointerup', clientY: number, clientX = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientY, clientX });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function setup(over: Partial<Parameters<typeof useOutlineDrag>[0]> = {}) {
  const onMove = vi.fn<(plan: OutlineMovePlan) => void>();
  const announce = vi.fn<(s: string) => void>();
  const hook = renderHook(() =>
    useOutlineDrag({
      rows: ROWS,
      rowHeight: ROW_H,
      getRowsTop: () => 0,
      onMove,
      announce,
      coarse: false,
      ...over,
    }),
  );
  return { hook, onMove, announce };
}

beforeEach(() => vi.useRealTimers());

describe('useOutlineDrag — a press is not yet a drag', () => {
  it('opens a session on pointerdown but draws nothing', () => {
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down()));
    expect(hook.result.current.session).toMatchObject({ draggedId: 'tail', active: false });
  });

  it('a press-and-release below the threshold commits nothing', () => {
    const { hook, onMove } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 10 })));
    windowPointer('pointermove', 12);
    windowPointer('pointerup', 12);
    expect(onMove).not.toHaveBeenCalled();
    expect(hook.result.current.session).toBeNull();
  });

  it('activates once the pointer travels past the threshold', () => {
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 10 })));
    windowPointer('pointermove', 40);
    expect(hook.result.current.session?.active).toBe(true);
  });

  it('ignores a non-primary button — a right-click still reaches the row menu', () => {
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down({ button: 2 })));
    expect(hook.result.current.session).toBeNull();
  });

  it('is inert with no commit sink at all', () => {
    const { hook } = setup({ onMove: undefined });
    act(() => hook.result.current.startDrag('tail', down()));
    expect(hook.result.current.session).toBeNull();
  });
});

describe('useOutlineDrag — the session resolves and commits', () => {
  it('commits the plan under the pointer on release', () => {
    const { hook, onMove } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', 3 * ROW_H + ROW_H / 2);
    // Middle of row 0 ("Mobilization") → become its child.
    windowPointer('pointermove', ROW_H / 2);
    windowPointer('pointerup', ROW_H / 2);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0]).toMatchObject({ taskId: 'tail', newParentId: 'phase' });
  });

  it('commits nothing when the pointer is over a refusal', () => {
    const { hook, onMove } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    // Middle of the milestone row.
    windowPointer('pointermove', 2 * ROW_H + ROW_H / 2);
    windowPointer('pointerup', 2 * ROW_H + ROW_H / 2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('resolves nothing when the list has no measurable top', () => {
    const { hook, onMove } = setup({ getRowsTop: () => null });
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', ROW_H / 2);
    windowPointer('pointerup', ROW_H / 2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('preventDefaults the move so the browser does not select or pan under it', () => {
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    const event = windowPointer('pointermove', 40);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('useOutlineDrag — the consequence is spoken, not only drawn', () => {
  it('announces what the drop would do', () => {
    const { hook, announce } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', ROW_H / 2);
    expect(announce).toHaveBeenCalledWith('Drop to move Closeout into Mobilization.');
  });

  it('does not repeat the same sentence on every pixel of travel', () => {
    const { hook, announce } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', ROW_H / 2);
    windowPointer('pointermove', ROW_H / 2 + 1);
    windowPointer('pointermove', ROW_H / 2 + 2);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('states a refusal rather than going quiet over it', () => {
    const { hook, announce } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', 2 * ROW_H + ROW_H / 2);
    expect(announce).toHaveBeenCalledWith('NTP is a milestone — a gate cannot hold work.');
  });
});

describe('useOutlineDrag — cancelling', () => {
  it('Escape ends the session and commits nothing', () => {
    const { hook, onMove, announce } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', ROW_H / 2);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(hook.result.current.session).toBeNull();
    expect(announce).toHaveBeenCalledWith('Move cancelled.');

    // A pointerup after the cancel must not resurrect the drop.
    windowPointer('pointerup', ROW_H / 2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('pointercancel ends the session', () => {
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    act(() => {
      window.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    });
    expect(hook.result.current.session).toBeNull();
  });

  it('unmounting mid-drag tears the window listeners down', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { hook } = setup();
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    hook.unmount();
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
    remove.mockRestore();
  });
});

describe('useOutlineDrag — a finger holds still to lift a row', () => {
  it('a coarse press that moves before the hold is a scroll, not a drag', () => {
    vi.useFakeTimers();
    const { hook, onMove } = setup({ coarse: true });
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointermove', 40);
    expect(hook.result.current.session).toBeNull();
    windowPointer('pointerup', 40);
    expect(onMove).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a coarse press that holds still lifts the row', () => {
    vi.useFakeTimers();
    const { hook } = setup({ coarse: true });
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    expect(hook.result.current.session?.active).toBe(true);
    vi.useRealTimers();
  });

  it('a hold that fires after the gesture ended does not resurrect it', () => {
    vi.useFakeTimers();
    const { hook } = setup({ coarse: true });
    act(() => hook.result.current.startDrag('tail', down({ clientY: 0 })));
    windowPointer('pointerup', 0);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    });
    expect(hook.result.current.session).toBeNull();
    vi.useRealTimers();
  });
});
