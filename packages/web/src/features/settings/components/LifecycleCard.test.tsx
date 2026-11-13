import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleCard } from './LifecycleCard';

describe('LifecycleCard body contrast (#1620)', () => {
  // jsdom computes no contrast; the guard is the token. On the -bg tint over the warm
  // canvas, neutral-text-secondary sits near the 4.5:1 floor; primary is ~11:1.
  it('uses the primary text token for description and notes on a warning card', () => {
    render(
      <LifecycleCard
        title="Archive"
        tone="warning"
        description="Hides the project."
        actionLabel="Archive project"
        notes={['Reversible.']}
      />,
    );
    expect(screen.getByText('Hides the project.')).toHaveClass('text-neutral-text-primary');
    expect(screen.getByText('Reversible.')).toHaveClass('text-neutral-text-primary');
    expect(screen.getByText('Hides the project.')).not.toHaveClass('text-neutral-text-secondary');
  });
});
