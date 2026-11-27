import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PwaInstallPrompt } from './PwaInstallPrompt';
import {
  INSTALL_NUDGE_STORAGE_KEY,
  isDismissed,
  readNudgeState,
  recordDismissal,
  shouldShowInstallNudge,
  SNOOZE_MS,
} from './installNudgePolicy';

afterEach(() => {
  localStorage.clear();
});

describe('installNudgePolicy', () => {
  const fresh = { dismissCount: 0, lastDismissedAt: null };

  it('shows only on iOS Safari outside the installed app', () => {
    expect(shouldShowInstallNudge({ iosSafari: true, standalone: false, state: fresh })).toBe(true);
    expect(shouldShowInstallNudge({ iosSafari: true, standalone: true, state: fresh })).toBe(false);
    expect(shouldShowInstallNudge({ iosSafari: false, standalone: false, state: fresh })).toBe(
      false,
    );
  });

  it('snoozes for 30 days after one dismissal, then shows again', () => {
    const now = 1_000_000_000_000;
    const once = { dismissCount: 1, lastDismissedAt: now };
    expect(isDismissed(once, now + SNOOZE_MS - 1)).toBe(true);
    expect(isDismissed(once, now + SNOOZE_MS)).toBe(false);
  });

  it('hides for good after the second dismissal', () => {
    expect(isDismissed({ dismissCount: 2, lastDismissedAt: 0 }, Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
  });

  it('persists dismissals and survives unreadable storage', () => {
    recordDismissal(5);
    expect(readNudgeState()).toEqual({ dismissCount: 1, lastDismissedAt: 5 });
    localStorage.setItem(INSTALL_NUDGE_STORAGE_KEY, '{not json');
    expect(readNudgeState()).toEqual({ dismissCount: 0, lastDismissedAt: null });
  });
});

describe('PwaInstallPrompt', () => {
  it('renders nothing when not eligible', () => {
    const { container } = render(<PwaInstallPrompt eligible={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('"Not now" hides the nudge and records the dismissal', async () => {
    render(<PwaInstallPrompt eligible />);
    expect(screen.getByRole('region', { name: 'Install TruePPM' })).toBeInTheDocument();
    expect(screen.getByText(/Share, then Add to Home Screen/)).toBeInTheDocument();
    // Claims only what ships (ADR-1523 Decision 6, the persistent outbox, is not built).
    expect(
      screen.getByText(/opens without a signal and shows your last My Work list/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/time tracking/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: 'Install TruePPM' })).not.toBeInTheDocument();
    expect(readNudgeState().dismissCount).toBe(1);
  });

  it('"Show me how" reveals the steps, moves focus to them, and "Done" dismisses', async () => {
    render(<PwaInstallPrompt eligible />);
    await userEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    const steps = screen.getByRole('list', { name: 'How to install' });
    expect(steps).toHaveFocus();
    expect(steps).toHaveTextContent('Add to Home Screen');
    expect(steps).toHaveTextContent('Changes made offline are kept only while the app stays open.');
    expect(steps).not.toHaveTextContent('works offline');
    expect(screen.queryByRole('button', { name: 'Show me how' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Install TruePPM' })).not.toBeInTheDocument();
  });
});
