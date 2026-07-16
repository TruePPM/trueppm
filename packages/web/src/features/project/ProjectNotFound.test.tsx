import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { ProjectNotFound } from './ProjectNotFound';

describe('ProjectNotFound', () => {
  it('renders the deleted/unavailable message and a back link', () => {
    renderWithRouter(<ProjectNotFound />);

    expect(screen.getByRole('heading', { name: /isn.t available/i })).toBeInTheDocument();
    expect(screen.getByText(/may have been deleted/i)).toBeInTheDocument();

    const back = screen.getByRole('link', { name: /back to your projects/i });
    expect(back).toHaveAttribute('href', '/');
  });

  it('hedges the copy to cover a lost-access case, not only deletion (#2040)', () => {
    renderWithRouter(<ProjectNotFound />);
    expect(screen.getByText(/no longer have access/i)).toBeInTheDocument();
  });

  it('exposes a status role for assistive tech', () => {
    renderWithRouter(<ProjectNotFound />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
