import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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

  it('keeps the live region mounted but empty when the queue is empty (#2203)', () => {
    // The region must persist so a toast's text is injected into an existing
    // live node — a region mounted with its content is not reliably announced.
    render(<ToastHost />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('announces a pushed toast in a polite, non-atomic status region (#3149 D7)', () => {
    render(<ToastHost />);
    act(() => {
      toast.success('Nice — Backend done.');
    });
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Without aria-atomic="false" a re-render of one slot re-reads the other
    // slot's unchanged text. The live region *contains* the toasts, so an
    // announcement is a consequence of painting and nothing is written to it
    // out of band.
    expect(region).toHaveAttribute('aria-atomic', 'false');
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
    // The sage check is a house CheckIcon SVG, not a "✓" glyph (issue 1749).
    expect(screen.getByTestId('toast-success-check')).toBeInTheDocument();
    act(() => {
      useToastStore.getState().clear();
      toast.error('Failed to save');
    });
    expect(screen.queryByTestId('toast-success-check')).not.toBeInTheDocument();
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

  it('the Undo control is a real <button> inside the live region and in normal tab order (D7)', () => {
    render(<ToastHost />);
    act(() => {
      toast.action('Deleted, Cable plant install.', { label: 'Undo', onClick: vi.fn() });
    });
    const region = screen.getByRole('status');
    const btn = screen.getByRole('button', { name: 'Undo' });
    expect(btn.tagName).toBe('BUTTON');
    expect(region.contains(btn)).toBe(true);
    // No tabindex override — it sits in the natural tab order rather than being
    // reachable only by an SR's virtual cursor.
    expect(btn).not.toHaveAttribute('tabindex');
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

  it('pauses auto-dismiss while hovered so an Undo stays reachable (WCAG 2.2.1, #2203)', () => {
    render(<ToastHost />);
    act(() => {
      toast.action('Deleted', { label: 'Undo', onClick: vi.fn() }, { durationMs: 1500 });
    });
    const pill = screen.getByText('Deleted').closest('div') as HTMLElement;
    // Hover pauses the countdown — well past the duration the toast survives.
    act(() => {
      fireEvent.mouseEnter(pill);
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    // Leaving restarts the full duration, then it dismisses.
    act(() => {
      fireEvent.mouseLeave(pill);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  describe('two slots with fixed roles (#3149 D5)', () => {
    it('renders both slots as siblings, transient first in DOM order (geometry is e2e)', () => {
      render(<ToastHost />);
      act(() => {
        toast.action('Deleted, Cable plant install.', { label: 'Undo', onClick: vi.fn() });
        toast.success('Estimate saved');
      });
      const pills = screen.getAllByTestId('toast-pill');
      expect(pills).toHaveLength(2);
      expect(pills[0]).toHaveAttribute('data-toast-slot', 'transient');
      expect(pills[1]).toHaveAttribute('data-toast-slot', 'action');
    });

    it('never renders more than two however many are raised', () => {
      render(<ToastHost />);
      act(() => {
        for (let i = 0; i < 6; i += 1) {
          toast.success(`Saved ${i}`);
          toast.action(`Deleted ${i}`, { label: 'Undo', onClick: vi.fn() });
        }
      });
      expect(screen.getAllByTestId('toast-pill')).toHaveLength(2);
      expect(screen.getByText('Saved 5')).toBeInTheDocument();
      expect(screen.getByText('Deleted 5')).toBeInTheDocument();
    });

    it('reserves no height for an empty slot — a lone toast is the only child', () => {
      render(<ToastHost />);
      const region = screen.getByRole('status');
      act(() => {
        toast.action('Deleted, Cable plant install.', { label: 'Undo', onClick: vi.fn() });
      });
      // One filled slot means exactly one child node: no placeholder, no spacer.
      expect(region.children).toHaveLength(1);
      expect(region.children[0]).toHaveAttribute('data-toast-slot', 'action');
      act(() => {
        useToastStore.getState().clear();
      });
      expect(region).toBeEmptyDOMElement();
    });

    it('a passive toast does not displace or re-clock an action toast', () => {
      render(<ToastHost />);
      act(() => {
        toast.action('Deleted, Cable plant install.', { label: 'Undo', onClick: vi.fn() });
      });
      act(() => {
        vi.advanceTimersByTime(2000);
        toast.success('Estimate saved');
      });
      // Push the passive past its own dwell; the action toast is untouched.
      act(() => {
        vi.advanceTimersByTime(2600);
      });
      expect(screen.queryByText('Estimate saved')).not.toBeInTheDocument();
      expect(screen.getByText('Deleted, Cable plant install.')).toBeInTheDocument();
    });
  });

  describe('focus retention (#3149 D8)', () => {
    it('focus inside a pill claims it in the store and blocks displacement', () => {
      render(<ToastHost />);
      act(() => {
        toast.action('Deleted, Cable plant install.', { label: 'Undo', onClick: vi.fn() });
      });
      const btn = screen.getByRole('button', { name: 'Undo' });
      act(() => {
        fireEvent.focus(btn);
      });
      expect(useToastStore.getState().focusedId).toBe(useToastStore.getState().action?.id);

      // An incoming actionable waits rather than yanking the control away.
      act(() => {
        toast.action('Deleted, Trenching.', { label: 'Undo', onClick: vi.fn() });
      });
      expect(screen.getByText('Deleted, Cable plant install.')).toBeInTheDocument();
      expect(screen.queryByText('Deleted, Trenching.')).not.toBeInTheDocument();

      // Leaving is the only way to lose it — and the queued one lands then.
      act(() => {
        fireEvent.blur(btn);
      });
      expect(screen.getByText('Deleted, Trenching.')).toBeInTheDocument();
    });

    it('a focused toast is never timed out', () => {
      render(<ToastHost />);
      act(() => {
        toast.action('Deleted', { label: 'Undo', onClick: vi.fn() }, { durationMs: 1000 });
      });
      const btn = screen.getByRole('button', { name: 'Undo' });
      act(() => {
        fireEvent.focus(btn);
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByText('Deleted')).toBeInTheDocument();
    });
  });

  it('an absorbed duplicate shows a count and restarts the clock without remounting', () => {
    render(<ToastHost />);
    act(() => {
      toast.success('Estimate saved');
    });
    const firstPill = screen.getByTestId('toast-pill');
    act(() => {
      vi.advanceTimersByTime(200);
      toast.success('Estimate saved');
    });
    // Same DOM node — the pill did not remount, so the entrance animation did
    // not replay. That is the whole point of coalescing a rapid-edit burst.
    expect(screen.getByTestId('toast-pill')).toBe(firstPill);
    // The glyph is decorative; the count also has a spoken form, because `×` is
    // unreliable across screen readers.
    expect(screen.getByTestId('toast-pill')).toHaveTextContent('×2');
    expect(screen.getByText(', repeated 2 times')).toBeInTheDocument();
    // The clock restarted from the absorbing push, not from the original one:
    // 2500ms later is still inside the fresh 2600ms dwell even though 2700ms
    // have now passed since the first toast appeared.
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByText('Estimate saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Estimate saved')).not.toBeInTheDocument();
  });
});
