import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { VelocitySaturationNote } from './VelocitySaturationNote';

describe('VelocitySaturationNote (#4954)', () => {
  it('states the lower bound and the saturated share when runs were clamped', () => {
    render(<VelocitySaturationNote saturatedRuns={250} runs={1000} />);
    const note = screen.getByTestId('velocity-saturation-note');
    expect(note.textContent).toMatch(/P80 and P95 are lower bounds/);
    expect(note.textContent).toMatch(/250 of 1,000 runs/);
    expect(note.textContent).toMatch(/25%/);
  });

  it('never rounds a non-zero count down to 0%', () => {
    render(<VelocitySaturationNote saturatedRuns={1} runs={5000} />);
    expect(screen.getByTestId('velocity-saturation-note').textContent).toMatch(/1%/);
  });

  it.each([
    ['zero (no run clamped)', 0],
    ['absent (persisted-history fallback — unknown, not zero)', undefined],
  ])('renders no claim when the count is %s', (_label, count) => {
    const { container } = render(<VelocitySaturationNote saturatedRuns={count} runs={1000} />);
    expect(container.firstChild).toBeNull();
  });
});
