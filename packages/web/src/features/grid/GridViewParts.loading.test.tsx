import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GridLoadingSkeleton } from './GridViewParts';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

describe('loading placeholders expose a status role (#4618)', () => {
  it('GridLoadingSkeleton is a named status region', () => {
    render(<GridLoadingSkeleton outline={false} />);
    expect(screen.getByRole('status', { name: /loading/i })).toHaveAttribute('aria-busy', 'true');
  });

  it('shared LoadingSkeleton is a named status region', () => {
    render(<LoadingSkeleton label="Loading things" />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});
