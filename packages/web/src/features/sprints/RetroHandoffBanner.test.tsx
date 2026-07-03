import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RetroHandoffBanner } from './RetroHandoffBanner';

describe('RetroHandoffBanner (issue 1471)', () => {
  it('names the just-closed sprint in the CTA and supporting copy', () => {
    render(
      <RetroHandoffBanner
        sprintName="Sprint Alpha"
        iterationLabel="sprint"
        onRun={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // The primary action carries the sprint name so the deep-link target is
    // unambiguous (acceptance: "Run the {iteration} retro").
    expect(
      screen.getByRole('button', { name: /Run the Sprint Alpha retro/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sprint Alpha closed.');
  });

  it('fires onRun when the CTA is pressed', async () => {
    const onRun = vi.fn();
    render(
      <RetroHandoffBanner
        sprintName="Sprint Alpha"
        iterationLabel="sprint"
        onRun={onRun}
        onDismiss={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Run the Sprint Alpha retro/ }),
    );
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('fires onDismiss when the dismiss control is pressed', async () => {
    const onDismiss = vi.fn();
    render(
      <RetroHandoffBanner
        sprintName="Sprint Alpha"
        iterationLabel="sprint"
        onRun={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss retro handoff' }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('respects the iteration label in the supporting copy', () => {
    render(
      <RetroHandoffBanner
        sprintName="Iteration 4"
        iterationLabel="iteration"
        onRun={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'while the iteration is still fresh',
    );
  });
});
