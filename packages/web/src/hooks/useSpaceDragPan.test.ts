import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import {
  SpaceAwarePointerSensor,
  useSpaceDragPan,
  type SpaceAwarePointerSensorOptions,
} from './useSpaceDragPan';

/** Dispatch a Space keydown from a specific target so `e.target` is realistic. */
function pressSpace(
  target: EventTarget = document.body,
  type: 'keydown' | 'keyup' = 'keydown',
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const e = new KeyboardEvent(type, {
    code: 'Space',
    key: ' ',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

describe('useSpaceDragPan — pan-mode arming', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('arms on Space keydown and disarms on keyup, toggling the dnd suppression flag', () => {
    const { result } = renderHook(() => useSpaceDragPan());

    expect(result.current.isSpaceHeld).toBe(false);
    expect(result.current.shouldSuppressDrag()).toBe(false);

    act(() => {
      pressSpace();
    });
    expect(result.current.isSpaceHeld).toBe(true);
    expect(result.current.shouldSuppressDrag()).toBe(true);

    act(() => {
      pressSpace(document.body, 'keyup');
    });
    expect(result.current.isSpaceHeld).toBe(false);
    expect(result.current.shouldSuppressDrag()).toBe(false);
  });

  it('preventDefaults the Space keydown so the page does not page-scroll', () => {
    renderHook(() => useSpaceDragPan());
    let e!: KeyboardEvent;
    act(() => {
      e = pressSpace();
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it('ignores autorepeat while Space is held (arms once)', () => {
    const { result } = renderHook(() => useSpaceDragPan());
    act(() => {
      pressSpace();
    });
    let repeated!: KeyboardEvent;
    act(() => {
      repeated = pressSpace(document.body, 'keydown', { repeat: true });
    });
    // Still armed, but the repeat was a no-op (not preventDefaulted again).
    expect(result.current.isSpaceHeld).toBe(true);
    expect(repeated.defaultPrevented).toBe(false);
  });

  it('does NOT arm while typing in a text input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useSpaceDragPan());
    let e!: KeyboardEvent;
    act(() => {
      e = pressSpace(input);
    });
    expect(result.current.isSpaceHeld).toBe(false);
    expect(result.current.shouldSuppressDrag()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it('does NOT arm while a modal dialog is open', () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    const { result } = renderHook(() => useSpaceDragPan());
    act(() => {
      pressSpace();
    });
    expect(result.current.isSpaceHeld).toBe(false);
  });

  it('does NOT arm when focus is on a Space-activated control (keyboard users unaffected)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);

    const { result } = renderHook(() => useSpaceDragPan());
    let e!: KeyboardEvent;
    act(() => {
      e = pressSpace(button);
    });
    expect(result.current.isSpaceHeld).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it('resets pan mode on window blur (Space cannot get stuck)', () => {
    const { result } = renderHook(() => useSpaceDragPan());
    act(() => {
      pressSpace();
    });
    expect(result.current.isSpaceHeld).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current.isSpaceHeld).toBe(false);
  });

  it('does nothing when disabled', () => {
    const { result } = renderHook(() => useSpaceDragPan({ enabled: false }));
    let e!: KeyboardEvent;
    act(() => {
      e = pressSpace();
    });
    expect(result.current.isSpaceHeld).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('useSpaceDragPan — click-drag panning', () => {
  function makePointerEvent(
    type: string,
    opts: { clientX?: number; clientY?: number; button?: number; pointerId?: number },
  ): Event {
    const e = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: opts.clientX ?? 0,
      clientY: opts.clientY ?? 0,
      button: opts.button ?? 0,
    });
    Object.assign(e, { pointerId: opts.pointerId ?? 1, isPrimary: true });
    return e;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('scrolls the container by the inverse of the pointer delta while armed', () => {
    // jsdom has no layout engine, so scrollLeft/scrollTop are hardcoded to 0 —
    // make them writable so the pan math is observable.
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollLeft', { writable: true, value: 100, configurable: true });
    Object.defineProperty(el, 'scrollTop', { writable: true, value: 60, configurable: true });
    const setPointerCapture = vi.fn();
    el.setPointerCapture = setPointerCapture;
    el.releasePointerCapture = vi.fn();
    document.body.appendChild(el);

    // Assigning the ref in the render body (before effects run) means the pointer
    // effect binds its listeners to `el` on mount.
    const { result } = renderHook(() => {
      const api = useSpaceDragPan();
      api.scrollRef.current = el;
      return api;
    });

    act(() => {
      pressSpace();
    });
    act(() => {
      el.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    });
    expect(result.current.isPanning).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    act(() => {
      el.dispatchEvent(makePointerEvent('pointermove', { clientX: 170, clientY: 185 }));
    });
    // Dragging left/up (pointer moved -30x, -15y) scrolls content right/down:
    // scrollLeft = 100 - (170-200) = 130 ; scrollTop = 60 - (185-200) = 75.
    expect(el.scrollLeft).toBe(130);
    expect(el.scrollTop).toBe(75);

    act(() => {
      el.dispatchEvent(makePointerEvent('pointerup', { clientX: 170, clientY: 185 }));
    });
    expect(result.current.isPanning).toBe(false);
  });

  it('does not pan when Space is not held', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollLeft', { writable: true, value: 100, configurable: true });
    Object.defineProperty(el, 'scrollTop', { writable: true, value: 60, configurable: true });
    el.setPointerCapture = vi.fn();
    document.body.appendChild(el);

    renderHook(() => {
      const api = useSpaceDragPan();
      api.scrollRef.current = el;
      return api;
    });

    act(() => {
      el.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
      el.dispatchEvent(makePointerEvent('pointermove', { clientX: 100, clientY: 100 }));
    });
    expect(el.scrollLeft).toBe(100);
    expect(el.scrollTop).toBe(60);
  });
});

describe('SpaceAwarePointerSensor activator', () => {
  const activator = SpaceAwarePointerSensor.activators[0];

  function reactPointerDown(button = 0, isPrimary = true) {
    return {
      nativeEvent: { button, isPrimary } as PointerEvent,
    } as ReactPointerEvent;
  }

  it('suppresses activation while pan mode is armed', () => {
    const onActivation = vi.fn();
    const options: SpaceAwarePointerSensorOptions = {
      onActivation,
      shouldSuppressActivation: () => true,
    };
    expect(activator.handler(reactPointerDown(), options)).toBe(false);
    expect(onActivation).not.toHaveBeenCalled();
  });

  it('activates on a primary-button pointer-down when not suppressed', () => {
    const onActivation = vi.fn();
    const options: SpaceAwarePointerSensorOptions = {
      onActivation,
      shouldSuppressActivation: () => false,
    };
    expect(activator.handler(reactPointerDown(0, true), options)).toBe(true);
    expect(onActivation).toHaveBeenCalledTimes(1);
  });

  it('ignores non-primary and right-button pointer-downs', () => {
    const options: SpaceAwarePointerSensorOptions = { shouldSuppressActivation: () => false };
    expect(activator.handler(reactPointerDown(2, true), options)).toBe(false);
    expect(activator.handler(reactPointerDown(0, false), options)).toBe(false);
  });
});
