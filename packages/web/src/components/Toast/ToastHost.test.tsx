import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastHost } from './ToastHost';
import { useToastStore } from './toastStore';
import { toast } from './toast';

describe('ToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a pushed toast in a polite status region that does not steal focus', () => {
    render(<ToastHost />);
    act(() => {
      toast.success('Nice — Backend done.');
    });
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // never blocks the UI beneath it
    expect(region.className).toContain('pointer-events-none');
    expect(screen.getByText('Nice — Backend done.')).toBeInTheDocument();
  });

  it('rises in via the motion-safe keyframe and uses the pop-surface shadow (rule 180/1)', () => {
    render(<ToastHost />);
    act(() => {
      toast.info('Pinned Atlas to Shortcuts');
    });
    const pill = screen.getByText('Pinned Atlas to Shortcuts').closest('div');
    expect(pill?.className).toContain('motion-safe:animate-toast-rise');
    expect(pill?.className).toContain('shadow-pop');
  });

  it('auto-dismisses after the toast duration', () => {
    render(<ToastHost />);
    act(() => {
      toast.info('Saved', 1500);
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('shows the sage check on success/info but not on error', () => {
    render(<ToastHost />);
    act(() => {
      toast.success('Done');
    });
    expect(screen.getByText('✓')).toBeInTheDocument();
    act(() => {
      useToastStore.getState().clear();
      toast.error('Failed to save');
    });
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.getByText('Failed to save')).toBeInTheDocument();
  });

  it('renders an action button (#1113 Undo): clicking runs onClick then dismisses', () => {
    const onUndo = vi.fn();
    render(<ToastHost />);
    act(() => {
      toast.action('"Downtown Retrofit" moved to Trash', {
        label: 'Undo',
        ariaLabel: 'Undo — restore Downtown Retrofit',
        onClick: onUndo,
      });
    });
    const btn = screen.getByRole('button', { name: 'Undo — restore Downtown Retrofit' });
    expect(btn).toBeInTheDocument();
    act(() => {
      btn.click();
    });
    expect(onUndo).toHaveBeenCalledOnce();
    // The pill is dismissed after the action fires.
    expect(screen.queryByText('"Downtown Retrofit" moved to Trash')).not.toBeInTheDocument();
  });

  it('action toasts dwell longer than the default so a phone user can react', () => {
    render(<ToastHost />);
    act(() => {
      toast.action('Moved to Trash', { label: 'Undo', onClick: vi.fn() });
    });
    // Still visible after the 2.6s default dwell — the action variant uses ~8s.
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.getByText('Moved to Trash')).toBeInTheDocument();
  });
});
