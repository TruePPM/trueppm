import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TypeBadge } from './TypeBadge';

describe('TypeBadge', () => {
  it('renders the human label for each task type', () => {
    const { rerender } = render(<TypeBadge type="story" />);
    expect(screen.getByText('Story')).toBeInTheDocument();
    rerender(<TypeBadge type="tech_debt" />);
    expect(screen.getByText('Tech Debt')).toBeInTheDocument();
  });

  it('falls back to Task when the type is absent (legacy rows)', () => {
    render(<TypeBadge />);
    expect(screen.getByText('Task')).toBeInTheDocument();
  });
});
