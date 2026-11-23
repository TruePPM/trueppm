import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PeopleLoadResponse } from '@/api/types';
import { LoadHeatMap } from './LoadHeatMap';

const DEF = 'Load = booked ÷ capacity, time off removed: server sentence.';

function payload(over: Partial<PeopleLoadResponse> = {}): PeopleLoadResponse {
  return {
    as_of: new Date().toISOString(),
    window: { start: '2026-03-02', end: '2026-03-15' },
    weeks: ['2026-03-02', '2026-03-09'],
    scope: { project_count: 2, withheld_project_count: 0, program_id: null },
    people: [
      {
        resource_id: 'r1',
        name: 'Alice Lee',
        initials: 'AL',
        job_role: 'Engineer',
        overallocated: true,
        peak_load_pct: 120,
        project_count: 2,
        cells: [
          { week_start: '2026-03-02', load_pct: 120, overallocated: true, reason: null },
          { week_start: '2026-03-09', load_pct: 45, overallocated: false, reason: null },
        ],
      },
      {
        resource_id: 'r2',
        name: 'Bo Park',
        initials: 'BP',
        job_role: '',
        overallocated: false,
        peak_load_pct: 30,
        project_count: 1,
        cells: [
          { week_start: '2026-03-02', load_pct: null, overallocated: false, reason: 'no_capacity' },
          { week_start: '2026-03-09', load_pct: 30, overallocated: false, reason: null },
        ],
      },
    ],
    over_allocated_count: 1,
    reason: null,
    definitions: { load_pct: DEF, over_allocated_count: 'x' },
    ...over,
  };
}

const props = { isLoading: false, isError: false, onRetry: vi.fn(), label: 'Load grid' };

describe('LoadHeatMap', () => {
  it('renders the server values, ▲ on over-allocated cells, and the server definition', () => {
    render(<LoadHeatMap {...props} data={payload()} />);
    const grid = screen.getByRole('grid', { name: 'Load grid' });
    const over = within(grid).getByRole('gridcell', {
      name: /Alice Lee, week of .*: 120% load, over-allocated/,
    });
    expect(over).toHaveTextContent('▲');
    expect(over).toHaveAttribute('data-band', 'gt115');
    const ok = within(grid).getByRole('gridcell', { name: /Alice Lee, .*: 45% load$/ });
    expect(ok).not.toHaveTextContent('▲');
    // A week with no working time is a dash, not 0%.
    const off = within(grid).getByRole('gridcell', { name: /Bo Park, .*: no working time/ });
    expect(off).toHaveTextContent('–');
    expect(screen.getByText(DEF, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Load legend' })).toHaveTextContent(
      '<40%40–59%60–79%80–100%▲101–115%▲>115%',
    );
  });

  it('has exactly one tabbable cell and moves it with the arrow keys', () => {
    render(<LoadHeatMap {...props} data={payload()} />);
    const cells = screen.getAllByRole('gridcell');
    expect(cells.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    cells[0].focus();
    fireEvent.keyDown(cells[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[1]);
    fireEvent.keyDown(cells[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells[3]);
    fireEvent.keyDown(cells[3], { key: 'Home' });
    expect(document.activeElement).toBe(cells[2]);
    fireEvent.keyDown(cells[2], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[0]);
  });

  it('shows a loading skeleton, a retryable error, and an empty state', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<LoadHeatMap {...props} isLoading data={undefined} />);
    expect(screen.queryByRole('grid')).toBeNull();

    rerender(<LoadHeatMap {...props} isError onRetry={onRetry} data={undefined} />);
    expect(screen.getByText("Couldn't load team load.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();

    rerender(
      <LoadHeatMap
        {...props}
        data={payload({ people: [], over_allocated_count: 0, reason: 'no_projects' })}
      />,
    );
    expect(screen.getByText('No bookings in this range')).toBeInTheDocument();
    // No upsell in the over-reach state (rule 231).
    expect(screen.queryByText(/enterprise|upgrade/i)).toBeNull();
  });
});
