import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FacetToggle } from './FacetToggle';

describe('FacetToggle', () => {
  it('renders through the shared Toggle: a switch with the focus ring and no stray label span (#4621)', () => {
    render(<FacetToggle on ariaLabel="Scrum Master" onToggle={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Scrum Master' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveClass('focus-visible:ring-2');
    expect(sw).not.toHaveAttribute('aria-busy');
    // Empty on/off labels render no text column, so the track is the only child.
    expect(sw.children).toHaveLength(1);
  });

  it('announces aria-busy while a write is pending', () => {
    render(<FacetToggle on={false} pending ariaLabel="Product Owner" onToggle={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Product Owner' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
