import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import type { HeatmapResource } from '@/hooks/useResourceHeatmap';
import { ResourcesHeatmap, ResourcesHeatmapSkeleton } from './ResourcesHeatmap';

interface AllocationPayload {
  resources: Array<{ id: string; tasks: never[] }>;
}

const { getMock } = vi.hoisted(() => ({
  getMock:
    vi.fn<(url: string, config?: unknown) => Promise<{ data: AllocationPayload }>>(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function resource(overrides: Partial<HeatmapResource> = {}): HeatmapResource {
  return {
    id: 'r1',
    name: 'Anna Khoury',
    initials: 'AK',
    job_role: 'Avionics Lead',
    color: '#7C3AED',
    calendar_differs_from_project: false,
    util: [80, 40],
    ...overrides,
  };
}

const WEEKS = ['2026-W18', '2026-W19'];

function renderHeatmap(
  overrides: { weeks?: string[]; resources?: HeatmapResource[]; projectId?: string } = {},
) {
  const props = {
    projectId: overrides.projectId ?? 'p1',
    weeks: overrides.weeks ?? WEEKS,
    resources: overrides.resources ?? [resource()],
  };
  const view = renderWithProviders(<ResourcesHeatmap {...props} />);
  return {
    ...view,
    rerenderWith: (next: Partial<typeof props>): void => {
      view.rerender(<ResourcesHeatmap {...props} {...next} />);
    },
  };
}

function grid() {
  return screen.getByRole('grid', { name: 'Resource utilization heatmap' });
}

/** Mobile list rows are the buttons that live outside the desktop grid. */
function mobileRows() {
  return screen
    .getAllByRole('button')
    .filter((b) => !grid().contains(b) && b.getAttribute('aria-label')?.includes('peak'));
}

describe('ResourcesHeatmapSkeleton', () => {
  it('reserves the header plus five person rows so the page does not reflow', () => {
    const { container } = renderWithProviders(<ResourcesHeatmapSkeleton cols={8} />);
    expect(
      container.getElementsByClassName('motion-safe:animate-pulse'),
    ).toHaveLength(6);
  });
});

describe('ResourcesHeatmap', () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: { resources: [] } });
  });

  describe('desktop grid', () => {
    it('renders a column header for the resource column and each week, stripping the ISO year', () => {
      renderHeatmap();
      const headers = within(grid()).getAllByRole('columnheader');
      expect(headers).toHaveLength(3);
      expect(headers[0]).toHaveTextContent('Resource');
      expect(headers[1]).toHaveTextContent('W18');
      expect(headers[2]).toHaveTextContent('W19');
    });

    it('falls back to the raw column label when it carries no ISO week suffix', () => {
      renderHeatmap({ weeks: ['Backlog'], resources: [resource({ util: [10] })] });
      const headers = within(grid()).getAllByRole('columnheader');
      expect(headers[1]).toHaveTextContent('Backlog');
    });

    it('shows the job role only for resources that have one', () => {
      renderHeatmap({
        resources: [
          resource(),
          resource({ id: 'r2', name: 'Bo Quill', initials: 'BQ', job_role: '' }),
        ],
      });
      const rowheaders = within(grid()).getAllByRole('rowheader');
      expect(rowheaders[0]).toHaveTextContent('Avionics Lead');
      expect(rowheaders[1].textContent).toBe('BQBo Quill');
    });

    it('renders one labelled utilization cell per week per resource', () => {
      renderHeatmap();
      const cells = within(grid()).getAllByRole('gridcell');
      expect(cells).toHaveLength(2);
      expect(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W18, 80% utilized' }),
      ).toBeInTheDocument();
      expect(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W19, 40% utilized' }),
      ).toBeInTheDocument();
    });

    it('renders headers but no person rows when the team is empty', () => {
      renderHeatmap({ resources: [] });
      expect(within(grid()).queryAllByRole('rowheader')).toHaveLength(0);
      expect(within(grid()).getAllByRole('columnheader')).toHaveLength(3);
    });
  });

  describe('cell drawer', () => {
    it('is closed until a cell is clicked', () => {
      renderHeatmap();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens on the clicked week and requests that ISO week Monday→Sunday window', async () => {
      renderHeatmap();
      await userEvent.click(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W18, 80% utilized' }),
      );
      expect(
        await screen.findByRole('heading', { name: 'Anna Khoury' }),
      ).toBeInTheDocument();
      expect(screen.getByText('W18 · Apr 27 → May 3')).toBeInTheDocument();
      await waitFor(() =>
        expect(getMock).toHaveBeenCalledWith('/projects/p1/resource-allocation/', {
          params: { resource: 'r1', start: '2026-04-27', end: '2026-05-03' },
        }),
      );
    });

    it('resolves the week window for an ISO year whose Jan 4 is not a Sunday', async () => {
      renderHeatmap({ weeks: ['2025-W10'], resources: [resource({ util: [55] })] });
      await userEvent.click(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W10, 55% utilized' }),
      );
      expect(await screen.findByText('W10 · Mar 3 → Mar 9')).toBeInTheDocument();
      await waitFor(() =>
        expect(getMock).toHaveBeenCalledWith('/projects/p1/resource-allocation/', {
          params: { resource: 'r1', start: '2025-03-03', end: '2025-03-09' },
        }),
      );
    });

    it('passes the utilization of the clicked cell through to the drawer', async () => {
      renderHeatmap({ resources: [resource({ util: [80, 130] })] });
      await userEvent.click(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W19, 130% utilized' }),
      );
      expect(await screen.findByText('130% over')).toBeInTheDocument();
    });

    it('closes again on the drawer close button', async () => {
      renderHeatmap();
      await userEvent.click(
        within(grid()).getByRole('button', { name: 'Anna Khoury, W18, 80% utilized' }),
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Close drawer' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('is withdrawn when the selected resource disappears from the refreshed team', async () => {
      const { rerenderWith } = renderHeatmap({
        resources: [resource(), resource({ id: 'r2', name: 'Bo Quill', initials: 'BQ' })],
      });
      await userEvent.click(
        within(grid()).getByRole('button', { name: 'Bo Quill, W18, 80% utilized' }),
      );
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      rerenderWith({ resources: [resource()] });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('mobile sparkline list', () => {
    it('announces the peak week and flags an over-allocated resource', () => {
      renderHeatmap({ resources: [resource({ util: [80, 130] })] });
      const [row] = mobileRows();
      expect(row).toHaveAttribute(
        'aria-label',
        'Anna Khoury, over-allocated, peak 130% in W19',
      );
      expect(within(row).getByText('⚠')).toBeInTheDocument();
    });

    it('omits the over-allocation wording and glyph while within capacity', () => {
      renderHeatmap({ resources: [resource({ util: [80, 40] })] });
      const [row] = mobileRows();
      expect(row).toHaveAttribute('aria-label', 'Anna Khoury, peak 80% in W18');
      expect(within(row).queryByText('⚠')).not.toBeInTheDocument();
    });

    it('opens the drawer on the peak week for an over-allocated resource', async () => {
      renderHeatmap({ resources: [resource({ util: [80, 130] })] });
      await userEvent.click(mobileRows()[0]);
      expect(await screen.findByText('W19 · May 4 → May 10')).toBeInTheDocument();
    });

    it('opens the drawer on the first week when the resource is within capacity', async () => {
      renderHeatmap({ resources: [resource({ util: [40, 80] })] });
      await userEvent.click(mobileRows()[0]);
      expect(await screen.findByText('W18 · Apr 27 → May 3')).toBeInTheDocument();
    });

    it('falls back to "Team member" when the resource has no job role', () => {
      renderHeatmap({ resources: [resource({ job_role: '' })] });
      const [row] = mobileRows();
      expect(row).toHaveTextContent('Team member · peak W18 (80%)');
    });

    it('shows the job role in the subtitle when present', () => {
      renderHeatmap();
      const [row] = mobileRows();
      expect(row).toHaveTextContent('Avionics Lead · peak W18 (80%)');
    });

    it('uses the raw peak label when the week carries no ISO week suffix', () => {
      renderHeatmap({ weeks: ['Backlog'], resources: [resource({ util: [65] })] });
      const [row] = mobileRows();
      expect(row).toHaveAttribute('aria-label', 'Anna Khoury, peak 65% in Backlog');
    });

    it('still renders the person when no utilization data came back for them', () => {
      renderHeatmap({ resources: [resource({ util: [] })] });
      const [row] = mobileRows();
      expect(within(row).getByText('Anna Khoury')).toBeInTheDocument();
      expect(row.querySelectorAll('.rounded-chip')).toHaveLength(0);
    });

    it('caps the sparkline at the first eight weeks', () => {
      renderHeatmap({
        weeks: Array.from({ length: 10 }, (_, i) => `2026-W${String(i + 10)}`),
        resources: [resource({ util: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] })],
      });
      const [row] = mobileRows();
      expect(row.querySelectorAll('.rounded-chip')).toHaveLength(8);
    });

    it('renders an idle week as the sunken surface rather than a utilization color', () => {
      renderHeatmap({ resources: [resource({ util: [0, 40] })] });
      const squares = mobileRows()[0].querySelectorAll<HTMLElement>('.rounded-chip');
      expect(squares[0].style.backgroundColor).toBe('var(--neutral-surface-sunken)');
      expect(squares[1].style.backgroundColor).not.toBe('var(--neutral-surface-sunken)');
    });
  });
});
