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
});
