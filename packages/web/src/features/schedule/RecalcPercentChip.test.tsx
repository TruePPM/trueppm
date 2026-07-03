import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RecalcPercentChip } from './RecalcPercentChip';
import type { RecalcPromptState } from './recalcPercentPrompt';

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
});
