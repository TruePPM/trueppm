import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToastStore, TOAST_DEFAULT_DURATION_MS } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
  });

  it('push adds a toast with info/default-duration defaults and returns its id', () => {
    const id = useToastStore.getState().push({ message: 'Saved' });
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id,
      message: 'Saved',
      variant: 'info',
      durationMs: TOAST_DEFAULT_DURATION_MS,
    });
  });

  it('honors an explicit variant and duration', () => {
    useToastStore.getState().push({ message: 'Boom', variant: 'error', durationMs: 1000 });
    expect(useToastStore.getState().toasts[0]).toMatchObject({ variant: 'error', durationMs: 1000 });
  });

  it('dismiss removes only the matching toast', () => {
    const a = useToastStore.getState().push({ message: 'A' });
    useToastStore.getState().push({ message: 'B' });
    useToastStore.getState().dismiss(a);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('B');
  });

  it('assigns a unique id to each toast', () => {
    const a = useToastStore.getState().push({ message: 'A' });
    const b = useToastStore.getState().push({ message: 'B' });
    expect(a).not.toBe(b);
  });

  it('clear empties the queue', () => {
    useToastStore.getState().push({ message: 'A' });
    useToastStore.getState().push({ message: 'B' });
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('carries an optional action through push (#1113 Undo)', () => {
    const onClick = vi.fn();
    useToastStore.getState().push({
      message: '"Downtown Retrofit" moved to Trash',
      action: { label: 'Undo', onClick, ariaLabel: 'Undo — restore Downtown Retrofit' },
    });
    const stored = useToastStore.getState().toasts[0];
    expect(stored.action?.label).toBe('Undo');
    stored.action?.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
