import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { RmHome } from './RmHome';

const load = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/hooks/usePeopleLoad', () => ({ usePeopleLoad: () => load.current }));

const data = {
  as_of: new Date().toISOString(),
  window: { start: '2026-03-02', end: '2026-03-08' },
  weeks: ['2026-03-02'],
  scope: {
    project_count: 2,
    withheld_project_count: 0,
    capacity_withheld_project_count: 0,
    program_id: null,
  },
  people: [
    {
      resource_id: 'r1',
      name: 'Alice Lee',
      initials: 'AL',
      job_role: '',
      overallocated: true,
      peak_load_pct: 130,
      project_count: 2,
      cells: [{ week_start: '2026-03-02', load_pct: 130, overallocated: true, reason: null }],
    },
  ],
  over_allocated_count: 1,
  reason: null,
  definitions: { load_pct: 'Load = booked ÷ capacity.', over_allocated_count: 'x' },
};

describe('RmHome', () => {
  beforeEach(() => {
    load.current = { data, isLoading: false, isError: false, refetch: vi.fn() };
  });

  it('shows the scope line, the over-capacity banner, the heat map and a People link', () => {
    renderWithRouter(<RmHome />, { initialEntries: ['/home'] });
    expect(screen.getByRole('heading', { level: 1, name: 'Team load' })).toBeInTheDocument();
    expect(screen.getByText('1 person · 2 projects')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 person over capacity');
    expect(screen.getByRole('grid', { name: 'Team load by person and week' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open People' })).toHaveAttribute('href', '/people');
  });

  it('omits the scope line and banner while loading', () => {
    load.current = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderWithRouter(<RmHome />, { initialEntries: ['/home'] });
    expect(screen.getByRole('heading', { level: 1, name: 'Team load' })).toBeInTheDocument();
    expect(screen.queryByText(/over capacity/)).not.toBeInTheDocument();
    expect(screen.queryByText(/projects?$/)).not.toBeInTheDocument();
  });

  it('renders the error state without a scope line', () => {
    load.current = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    renderWithRouter(<RmHome />, { initialEntries: ['/home'] });
    expect(screen.queryByText('1 person · 2 projects')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open People' })).toBeInTheDocument();
  });
});
