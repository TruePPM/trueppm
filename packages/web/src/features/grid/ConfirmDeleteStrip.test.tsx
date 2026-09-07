import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmDeleteStrip } from './ConfirmDeleteStrip';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const bar = () => screen.getByTestId('confirm-delete-shrink-bar');
const strip = () => screen.getByRole('alertdialog');

describe('ConfirmDeleteStrip', () => {
  it('focuses the Confirm button on mount', () => {
    render(
      <ConfirmDeleteStrip count={2} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /^Confirm delete$/ })).toHaveFocus();
  });

  it('singular noun for count of 1', () => {
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Delete 1 task\?/)).toBeInTheDocument();
  });

  it('plural noun for count > 1', () => {
    render(
      <ConfirmDeleteStrip count={3} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Delete 3 tasks\?/)).toBeInTheDocument();
  });

  it('tells the user bulk delete is undoable (#2078)', () => {
    render(
      <ConfirmDeleteStrip count={3} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/you can undo this/i)).toBeInTheDocument();
  });

  it('shows the deleting state and disables both buttons', () => {
    render(
      <ConfirmDeleteStrip count={2} isDeleting={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /deleting…/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
  });

  it('clicking Confirm invokes onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Confirm delete$/ }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('clicking Cancel invokes onCancel', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('Escape declines the delete through the same onCancel as the button (#3445)', () => {
    // Escape is the third exit, and routing it through `onCancel` rather than its own
    // state setter is what keeps the rule-368 focus handoff in `GridView` wired to all
    // three exits instead of two. An Escape handler that reached for `setDeletePhase`
    // directly would pass a "the strip closes" test and skip the handoff entirely.
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={2} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(strip(), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape is inert once the delete is in flight', () => {
    // Both buttons are disabled at this point; Escape must not be the one way left to
    // return the toolbar to idle while the request is still running.
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={2} isDeleting={true} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(strip(), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keys other than Escape are left alone', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={2} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(strip(), { key: 'Enter' });
    fireEvent.keyDown(strip(), { key: 'a' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('gives BOTH controls the identical hit-area pad (#3446)', () => {
    // jsdom has no layout, so the pad's real geometry is pinned in Playwright
    // (`wave3-grid-view.spec.ts`) by hit-testing points outside the visible box. What
    // this adds is the half a browser test cannot see cheaply: the two buttons share
    // one constant, so Confirm cannot end up padded while Cancel stays 28px — which
    // is exactly how this class recurs.
    render(
      <ConfirmDeleteStrip count={2} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const confirm = screen.getByRole('button', { name: /^Confirm delete$/ });
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    const pad = (el: HTMLElement) =>
      el.className
        .split(/\s+/)
        .filter((c) => c === 'relative' || c.startsWith('before:'))
        .sort()
        .join(' ');
    expect(pad(confirm)).not.toBe('');
    expect(pad(cancel)).toBe(pad(confirm));
    // Vertical only: a symmetric pad would overlap the 12px gap between them and let
    // DOM order decide which button a tap in between lands on.
    expect(pad(confirm)).toContain('before:inset-x-0');
  });

  it('does NOT auto-cancel while deleting is in flight', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteStrip count={1} isDeleting={true} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('suppresses the countdown when isDeleting flips true mid-window', () => {
    // The bare timer keyed off `isDeleting` too, so this is a hold-the-line assertion
    // for the move onto the hook's `active`: an in-flight delete must not be declined
    // out from under itself.
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    rerender(
      <ConfirmDeleteStrip count={1} isDeleting={true} onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  /**
   * The pausable dwell (#3394) — WCAG 2.2.1 / 2.4.3, web rule 378.
   *
   * The whole design turns on one discrimination: the strip focuses ITSELF on mount,
   * and that focus must not read as engagement or the strip never expires — on a
   * destructive-action guard whose timeout is the *safe* direction. So the first two
   * tests here are a matched pair and only mean something together: the countdown
   * survives the autofocus, and dies the moment the focus came from the user.
   */
  describe('pausable dwell', () => {
    it('auto-cancels after 5s even though it focused itself on mount', () => {
      // The negative control for every pause assertion below (rule 378(d)): each of
      // those passes trivially against a strip whose timer is simply broken, and the
      // most likely way to break it here is to let the mount autofocus arm the pause.
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      expect(screen.getByRole('button', { name: /^Confirm delete$/ })).toHaveFocus();
      expect(bar()).toHaveAttribute('data-paused', 'false');

      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(onCancel).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('is not restarted by an unrelated re-render (the deadline is real)', () => {
      // `GridView` passes `onCancelDelete={() => setDeletePhase('idle')}` — a fresh
      // arrow on every render — and the pre-#3394 effect listed `onCancel` in its
      // dependency array, so ANY parent re-render tore the timer down and re-armed
      // it. On a project polling in the background the strip could therefore linger
      // indefinitely: the 5s promise on the shrink-bar was not a deadline the code
      // could keep. `usePausableAutoDismiss` reads `onDismiss` through a ref, so the
      // clock now survives re-renders.
      //
      // The control is in HOW this advances: only in slices shorter than the dwell,
      // with a re-render between each and never a full dwell after the last one. A
      // trailing `advanceTimersByTime(5_000)` would let the buggy version pass.
      const onCancel = vi.fn();
      const { rerender } = render(
        <ConfirmDeleteStrip
          count={1}
          isDeleting={false}
          onConfirm={vi.fn()}
          onCancel={() => {
            onCancel();
          }}
        />,
      );
      for (let i = 0; i < 6; i += 1) {
        act(() => {
          vi.advanceTimersByTime(1_000);
        });
        rerender(
          <ConfirmDeleteStrip
            count={1}
            isDeleting={false}
            onConfirm={vi.fn()}
            onCancel={() => {
              onCancel();
            }}
          />,
        );
      }
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('pauses when the user moves focus into the strip themselves', () => {
      // Same DOM state as the test above — Confirm focused — reached a different way.
      // `fireEvent.focus` is a focus the component did not make, so it is outside the
      // `runWithoutPausing` bracket, which is the entire discriminator under test.
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      act(() => {
        vi.advanceTimersByTime(4_000);
        fireEvent.focus(screen.getByRole('button', { name: /^cancel$/i }));
      });
      expect(bar()).toHaveAttribute('data-paused', 'true');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('resumes a FULL window once the user takes focus back out', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      const cancel = screen.getByRole('button', { name: /^cancel$/i });
      act(() => {
        vi.advanceTimersByTime(4_900);
        fireEvent.focus(cancel);
      });
      act(() => {
        // relatedTarget outside the strip — focus genuinely left.
        fireEvent.blur(cancel, { relatedTarget: document.body });
      });
      // Not the 100ms remainder that was left when focus arrived.
      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(onCancel).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('does not resume when focus moves between the strip’s own buttons', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      const confirm = screen.getByRole('button', { name: /^Confirm delete$/ });
      const cancel = screen.getByRole('button', { name: /^cancel$/i });
      act(() => {
        fireEvent.focus(confirm);
      });
      act(() => {
        fireEvent.blur(confirm, { relatedTarget: cancel });
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('pauses while hovered', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      act(() => {
        vi.advanceTimersByTime(4_000);
        fireEvent.mouseEnter(strip());
      });
      expect(bar()).toHaveAttribute('data-paused', 'true');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onCancel).not.toHaveBeenCalled();

      act(() => {
        fireEvent.mouseLeave(strip());
      });
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('holds the pause while either hover or focus is still on it', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={onCancel} />,
      );
      const cancel = screen.getByRole('button', { name: /^cancel$/i });
      act(() => {
        fireEvent.mouseEnter(strip());
        fireEvent.focus(cancel);
      });
      act(() => {
        fireEvent.mouseLeave(strip());
        vi.advanceTimersByTime(60_000);
      });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('stops the shrink-bar draining while paused, and restarts it on resume', () => {
      // Acceptance criterion 3: the bar is what promises the deadline, so a bar that
      // keeps draining through a paused timer is the same misinformation the pause was
      // added to remove — and a bar that RESUMES from its remainder promises a deadline
      // 5s earlier than the timer will now fire, because the hook restarts the full
      // dwell rather than the remainder.
      render(
        <ConfirmDeleteStrip count={1} isDeleting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
      );
      const before = bar();
      expect(before.style.animationPlayState).toBe('running');

      act(() => {
        fireEvent.mouseEnter(strip());
      });
      expect(bar().style.animationPlayState).toBe('paused');
      expect(bar()).toBe(before); // paused in place, not remounted

      act(() => {
        fireEvent.mouseLeave(strip());
      });
      const after = bar();
      expect(after.style.animationPlayState).toBe('running');
      // A new element: the `key` changed, so the CSS animation replays from 100%
      // instead of picking up where it stopped.
      expect(after).not.toBe(before);
    });

    it('keeps the bar animating under reduced-motion, deliberately', () => {
      // Pins a decision that looks like an oversight, so nobody "fixes" it: the tree's
      // habit is `motion-safe:` on anything animated, and the bar does NOT follow it.
      // Since #3394 the bar is the only feedback that the countdown stopped, so gating
      // it on `prefers-reduced-motion` would delete the pause indicator for exactly the
      // users most likely to want the pause. A determinate progress indicator is the
      // shape reduced-motion exempts.
      const matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      }));
      vi.stubGlobal('matchMedia', matchMedia);
      try {
        render(
          <ConfirmDeleteStrip
            count={1}
            isDeleting={false}
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
          />,
        );
        expect(bar().style.animation).toContain('shrink-bar');
        expect(bar().className).not.toContain('motion-safe:');
        expect(bar().className).not.toContain('motion-reduce:');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('renders no shrink-bar at all once the delete is in flight', () => {
      render(
        <ConfirmDeleteStrip count={1} isDeleting={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
      );
      expect(screen.queryByTestId('confirm-delete-shrink-bar')).not.toBeInTheDocument();
    });
  });
});
