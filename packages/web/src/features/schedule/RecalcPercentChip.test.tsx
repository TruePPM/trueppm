import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { RecalcPercentChip } from './RecalcPercentChip';
import { RECALC_PROMPT_TIMEOUT_MS, type RecalcPromptState } from './recalcPercentPrompt';

const prompt: RecalcPromptState = {
  taskId: 't1',
  oldDuration: 5,
  newDuration: 10,
  oldPercent: 30,
  suggestedPercent: 15,
};

describe('RecalcPercentChip', () => {
  it('renders the inline prompt with the prorated suggestion (never a dialog)', () => {
    render(<RecalcPercentChip prompt={prompt} onAccept={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('recalc-percent-chip')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Recalculate percent complete to 15%/i }),
    ).toBeInTheDocument();
  });

  it('re-sends the edit with the suggested percent on accept, then confirms', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(<RecalcPercentChip prompt={prompt} onAccept={onAccept} onDismiss={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Recalculate percent complete to 15%/i }));
    expect(onAccept).toHaveBeenCalledWith(15);
    await waitFor(() => expect(screen.getByText(/Set to 15%/)).toBeInTheDocument());
  });

  it('dismisses (keep) without mutating when the × is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onAccept = vi.fn();
    render(<RecalcPercentChip prompt={prompt} onAccept={onAccept} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: /Keep current percent complete/i }));
    expect(onDismiss).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('shows a retry affordance when the re-send fails', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn().mockRejectedValue(new Error('boom'));
    render(<RecalcPercentChip prompt={prompt} onAccept={onAccept} onDismiss={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Recalculate percent complete to 15%/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Retry recalculating/i })).toBeInTheDocument(),
    );
  });

  it('auto-dismisses (keep) after the ~10s window elapses', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    try {
      render(<RecalcPercentChip prompt={prompt} onAccept={vi.fn()} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(11_000);
      expect(onDismiss).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('dwell timers under fake clock', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Both real call sites (`TaskListRow`, `TaskScheduleStrip`) pass
     * `onDismiss={() => setRecalcPrompt(null)}` — a fresh function identity on
     * every parent render. `TaskListRow` re-renders on every task refetch, so the
     * chip's parent re-renders far more often than once per dwell.
     */
    const renderWithFreshDismiss = (onDismiss: () => void, onAccept = vi.fn()) => {
      const props = () => ({ prompt, onAccept, onDismiss: () => onDismiss() });
      const utils = render(<RecalcPercentChip {...props()} />);
      return { ...utils, rerenderFresh: () => utils.rerender(<RecalcPercentChip {...props()} />) };
    };

    it('the ~10s dwell survives parent re-renders that hand it a fresh onDismiss (#3447)', () => {
      // The negative control for the re-arm defect: with `onDismiss` in the timer
      // effect's dependency array, every re-render tears the timer down and re-arms
      // it from zero, so the dwell never completes. What makes the control real is
      // that the clock advances ONLY in slices shorter than the dwell, with a
      // re-render between each, and never a full dwell after the last one — a trailing
      // `advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS)` would let the buggy version pass.
      const onDismiss = vi.fn();
      const { rerenderFresh } = renderWithFreshDismiss(onDismiss);
      for (let i = 0; i < 8; i += 1) {
        act(() => {
          vi.advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS / 5);
        });
        rerenderFresh();
      }
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('the "Set to N%" confirmation dwell survives parent re-renders too (#3447)', async () => {
      // Same defect on the second timer: the 1200ms confirmation used
      // `setTimeout(onDismiss, 1200)` in an effect depending on `onDismiss`.
      const onDismiss = vi.fn();
      const onAccept = vi.fn().mockResolvedValue(undefined);
      const { rerenderFresh } = renderWithFreshDismiss(onDismiss, onAccept);

      fireEvent.click(screen.getByRole('button', { name: /Recalculate percent complete to 15%/i }));
      // Flush the resolved `onAccept` so the chip reaches the `done` phase.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Set to 15%/)).toBeInTheDocument();
      expect(onDismiss).not.toHaveBeenCalled();

      for (let i = 0; i < 6; i += 1) {
        act(() => {
          vi.advanceTimersByTime(400);
        });
        rerenderFresh();
      }
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('pauses the dwell while hovered and dismisses once the pointer leaves (WCAG 2.2.1)', () => {
      const onDismiss = vi.fn();
      renderWithFreshDismiss(onDismiss);
      const chip = screen.getByTestId('recalc-percent-chip');
      act(() => {
        fireEvent.mouseEnter(chip);
      });
      act(() => {
        vi.advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS * 3);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      // The positive half of the control — a broken timer also "never dismisses".
      act(() => {
        fireEvent.mouseLeave(chip);
      });
      act(() => {
        vi.advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('never auto-removes the chip while one of its buttons holds focus (web rule 356(d))', () => {
      const onDismiss = vi.fn();
      renderWithFreshDismiss(onDismiss);
      act(() => {
        fireEvent.focus(screen.getByRole('button', { name: /Keep current percent complete/i }));
      });
      act(() => {
        vi.advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS * 3);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        fireEvent.blur(screen.getByRole('button', { name: /Keep current percent complete/i }));
      });
      act(() => {
        vi.advanceTimersByTime(RECALC_PROMPT_TIMEOUT_MS);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
