import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ForecastHorizonHelp } from './ForecastHorizonHelp';

/**
 * #2495 — the affordance that keeps a clamped Monte Carlo percentile from reading as
 * an unbiased one. The assertions that matter are about *copy direction*: the caveat
 * has to say the number is a floor (true value is later, never earlier). A test that
 * only checked "some help text renders" would pass on copy that said the opposite.
 */
describe('ForecastHorizonHelp', () => {
  it('is collapsed until invoked, so it never competes with the figure it annotates', () => {
    render(<ForecastHorizonHelp basis="velocity" />);
    expect(screen.getByRole('button', { name: /forecast horizon/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the velocity percentile is a floor, and which direction the bias runs', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="velocity" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('floor');
    // The direction is the whole point — an "approximate" hedge would be wrong.
    expect(text).toContain('this date or later, never earlier');
    // Names the clamp as the cause rather than vaguely blaming uncertainty.
    expect(text).toMatch(/stops at a fixed sprint horizon/i);
    // Gives the reader a way out, not just a warning.
    expect(text).toMatch(/three-point \(PERT\)/i);
  });

  it('speaks flow vocabulary on the throughput basis and never claims sprints', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="throughput" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const text = screen.getByRole('dialog').textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toMatch(/weekly throughput/i);
    expect(text).toMatch(/stops at a fixed week horizon/i);
    // web-rule 176: a flow-basis surface never borrows sprint vocabulary.
    expect(text).not.toMatch(/sprint/i);
  });

  it('links out to the docs section that substantiates the claim', async () => {
    const user = userEvent.setup();
    render(<ForecastHorizonHelp basis="velocity" />);
    await user.click(screen.getByRole('button', { name: /forecast horizon/i }));

    const link = screen.getByRole('link', { name: /why this is a floor/i });
    expect(link.getAttribute('href')).toContain(
      'features/monte-carlo/#velocity-and-throughput-forecasts-are-a-floor',
    );
    // Opens out of the app; rel must accompany target (no reverse-tabnabbing).
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
