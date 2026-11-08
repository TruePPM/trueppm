import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingSkeleton } from './LoadingSkeleton';
import { TABLE_HEADER_CELL, TABLE_ROW_HEIGHT } from './page2/DataTable';

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
        columns={[
          { key: 'task', header: 'Task' },
          { key: 'finish', header: 'Finish', numeric: true },
        ]}
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

  it('uses the DataTable row heights, column widths and alignment so nothing moves on paint', () => {
    const { container } = render(
      <LoadingSkeleton
        variant="table"
        label="Loading tasks…"
        columns={[
          { key: 'task', header: 'Task', width: '240px' },
          { key: 'float', header: 'Float', width: '96px', numeric: true },
        ]}
        rows={2}
      />,
    );
    for (const row of screen.getAllByTestId('skeleton-row')) {
      expect(row.className).toContain(TABLE_ROW_HEIGHT.default);
    }
    const headers = container.querySelectorAll('th');
    expect(headers[0]).toHaveStyle({ width: '240px' });
    expect(headers[1]).toHaveClass('text-right');
    expect(headers[1].className).toContain(TABLE_HEADER_CELL);
  });

  it('follows the density the real table will use', () => {
    render(
      <LoadingSkeleton
        variant="table"
        label="Loading…"
        columns={[{ key: 'task', header: 'Task' }]}
        density="dense"
      />,
    );
    expect(screen.getAllByTestId('skeleton-row')[0].className).toContain(TABLE_ROW_HEIGHT.dense);
  });
});

describe('LoadingSkeleton table — column identity', () => {
  it('keys cells by column key, so two columns with an empty header both render', () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errors.push(a);
    });
    const { container } = render(
      <LoadingSkeleton
        variant="table"
        label="Loading…"
        columns={[
          { key: 'a', header: '' },
          { key: 'b', header: '' },
        ]}
        rows={2}
      />,
    );
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr:first-child td')).toHaveLength(2);
    expect(errors.filter((a) => String(a[0]).includes('same key'))).toHaveLength(0);
    spy.mockRestore();
  });
});
