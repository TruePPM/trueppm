import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingSkeleton } from './LoadingSkeleton';

describe('LoadingSkeleton (#2431, rule 248)', () => {
  it('exposes one named status node so the wait-for-paint gate can resolve on it', () => {
    render(<LoadingSkeleton label="Loading members…" />);
    const status = screen.getByRole('status', { name: /Loading members/i });
    expect(status).toBeInTheDocument();
    // Exactly one — the ghosts must not each announce themselves.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('renders ghost blocks, never a bare "Loading…" text line', () => {
    render(<LoadingSkeleton label="Loading members…" rows={3} />);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading members…')).not.toBeInTheDocument();
  });

  it('renders one ghost per requested row', () => {
    const { container } = render(<LoadingSkeleton label="Loading rows…" rows={5} />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(5);
  });

  it('marks every ghost aria-hidden and pulses only under motion-safe', () => {
    const { container } = render(<LoadingSkeleton label="Loading rows…" rows={2} />);
    const ghosts = Array.from(container.querySelectorAll('[aria-hidden="true"]'));
    expect(ghosts).toHaveLength(2);
    for (const g of ghosts) {
      // `motion-safe:` is mandatory — a bare animate-pulse ignores
      // prefers-reduced-motion.
      expect(g.className).toContain('motion-safe:animate-pulse');
      expect(g.className).toContain('bg-neutral-surface-sunken');
    }
  });

  it('shell variant ghosts a toolbar band above the content rows', () => {
    const { container } = render(<LoadingSkeleton label="Loading…" variant="shell" rows={4} />);
    // 3 toolbar ghosts + 4 content ghosts. The toolbar band is what stops the
    // layout jumping when the real chrome paints.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(7);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });
});

describe('LoadingSkeleton — Pass 2 table variant (rule 439)', () => {
  it('paints the real column names and count first, ghosts only the values', () => {
    const { container } = render(
      <LoadingSkeleton
        variant="table"
        label="Loading tasks…"
        columns={['Task', 'Finish']}
        count="24 tasks"
        rows={4}
      />,
    );
    const status = screen.getByRole('status', { name: 'Loading tasks…' });
    expect(status).toHaveTextContent('24 tasks');
    expect(status).toHaveTextContent('Task');
    expect(status).toHaveTextContent('Finish');
    // 4 rows × 2 columns of value ghosts, pulsing only under motion-safe.
    const ghosts = container.querySelectorAll('.motion-safe\\:animate-pulse');
    expect(ghosts).toHaveLength(8);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});
