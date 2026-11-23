import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { setFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/shellFlag';
import { PeoplePage } from './PeoplePage';

const load = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/hooks/usePeopleLoad', () => ({ usePeopleLoad: () => load.current }));
vi.mock('@/features/resources/ResourcesPage', () => ({
  ResourcesPage: () => <div>directory-surface</div>,
}));

const data = {
  as_of: new Date().toISOString(),
  window: { start: '2026-03-02', end: '2026-03-08' },
  weeks: ['2026-03-02'],
  scope: { project_count: 1, withheld_project_count: 0, program_id: null },
  people: [
    {
      resource_id: 'r1',
      name: 'Alice Lee',
      initials: 'AL',
      job_role: '',
      overallocated: true,
      peak_load_pct: 130,
      project_count: 1,
      cells: [{ week_start: '2026-03-02', load_pct: 130, overallocated: true, reason: null }],
    },
  ],
  over_allocated_count: 1,
  reason: null,
  definitions: { load_pct: 'Load = booked ÷ capacity.', over_allocated_count: 'x' },
};

describe('PeoplePage', () => {
  beforeEach(() => {
    localStorage.clear();
    setFeatureFlag(SHELL_V2_FLAG, true);
    load.current = { data, isLoading: false, isError: false, refetch: vi.fn() };
  });

  it('lands on Capacity, with the server over-capacity count and the heat map', () => {
    renderWithRouter(<PeoplePage />, { initialEntries: ['/people'] });
    expect(screen.getByRole('heading', { level: 1, name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Capacity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('1 person over capacity');
    expect(screen.getByRole('grid', { name: 'Load by person and week' })).toBeInTheDocument();
  });

  it('keeps the roster as its own Directory tab', async () => {
    renderWithRouter(<PeoplePage />, { initialEntries: ['/people'] });
    fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
    expect(await screen.findByText('directory-surface')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Directory' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the Directory from ?view=directory', async () => {
    renderWithRouter(<PeoplePage />, { initialEntries: ['/people?view=directory'] });
    expect(await screen.findByText('directory-surface')).toBeInTheDocument();
  });

  it('renders nothing of v2 with the flag off (redirects to the v1 catalog)', () => {
    setFeatureFlag(SHELL_V2_FLAG, false);
    renderWithRouter(<PeoplePage />, { initialEntries: ['/people'] });
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
