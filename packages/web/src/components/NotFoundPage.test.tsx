import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage (#2184)', () => {
  it('announces the dead-end assertively and offers recovery actions', () => {
    renderWithRouter(<NotFoundPage />, { initialEntries: ['/does/not/exist'] });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to my work/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to home/i })).toBeInTheDocument();
  });

  it('moves focus to the heading on mount so keyboard/AT users reach the CTAs (rule 224)', async () => {
    renderWithRouter(<NotFoundPage />, { initialEntries: ['/does/not/exist'] });
    const heading = screen.getByRole('heading', { name: /page not found/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });
});
