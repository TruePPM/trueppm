import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BacklogSeedingState } from './BacklogSeedingState';

describe('BacklogSeedingState', () => {
  it('announces the setting-up status for assistive tech', () => {
    render(<BacklogSeedingState />);
    expect(screen.getByRole('status', { name: 'Setting up your backlog' })).toBeInTheDocument();
    expect(screen.getByText('Setting up your backlog…')).toBeInTheDocument();
  });

  it('never renders waterfall creation vocabulary', () => {
    render(<BacklogSeedingState />);
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\bProgram\b/);
    expect(body).not.toMatch(/\bSchedule\b/);
    expect(body).not.toMatch(/Planning model/);
  });
});
