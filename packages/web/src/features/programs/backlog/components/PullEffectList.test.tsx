import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PullEffectList } from './PullEffectList';

describe('PullEffectList', () => {
  it('personalizes the destination bullet with the target project name', () => {
    render(<PullEffectList projectName="Avionics" />);
    expect(screen.getByText(/New task in Avionics's backlog/)).toBeInTheDocument();
    expect(screen.getByText(/This item becomes Pulled/)).toBeInTheDocument();
  });

  it('falls back to a generic destination when no project is selected', () => {
    render(<PullEffectList projectName={null} />);
    expect(screen.getByText(/New task in the project backlog/)).toBeInTheDocument();
  });

  it('applies an extra className onto the list', () => {
    const { container } = render(<PullEffectList projectName={null} className="mt-2" />);
    expect(container.querySelector('ul')).toHaveClass('mt-2');
  });
});
