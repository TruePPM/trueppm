import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { HeatmapCellDrawer } from './HeatmapCellDrawer';

interface DrawerTask {
  id: string;
  name: string;
  status: string;
  early_start: string | null;
  early_finish: string | null;
  scheduled_start: string | null;
  units: string;
  hours: number;
}

interface AllocationPayload {
  resources: Array<{ id: string; tasks: DrawerTask[] }>;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, config?: unknown) => Promise<{ data: AllocationPayload }>>(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function task(overrides: Partial<DrawerTask> = {}): DrawerTask {
  // scheduled_start defaults to whichever early_start this call resolves to
  // (not-started/complete windows coincide, ADR-0752 §2), so pre-existing
  // overrides that only touch early_start/early_finish stay correct. Pass
  // scheduled_start explicitly to test the in-progress narrowing case (#2677).
  const early_start = 'early_start' in overrides ? overrides.early_start! : '2026-04-06';
  return {
    id: 't1',
    name: 'Wire the avionics loom',
    status: 'in_progress',
    early_start,
    early_finish: '2026-04-10',
    scheduled_start: early_start,
    units: '1.0',
    hours: 8,
    ...overrides,
  };
}

function resolveWith(tasks: DrawerTask[], resourceId = 'r1') {
  getMock.mockResolvedValue({ data: { resources: [{ id: resourceId, tasks }] } });
}

const BASE_PROPS = {
  projectId: 'p1',
  resourceId: 'r1',
  resourceName: 'Anna Khoury',
  resourceInitials: 'AK',
  resourceColor: '#7C3AED',
  weekLabel: '2026-W18',
  weekStart: '2026-04-27',
  weekEnd: '2026-05-03',
  utilPct: 80,
  onClose: vi.fn(),
};

function renderDrawer(overrides: Partial<typeof BASE_PROPS> = {}) {
  return renderWithProviders(<HeatmapCellDrawer {...BASE_PROPS} {...overrides} />);
}

describe('HeatmapCellDrawer', () => {
  beforeEach(() => {
    getMock.mockReset();
    resolveWith([task()]);
  });

  describe('header', () => {
    it('labels the dialog with the resource name and the ISO week range', async () => {
      renderDrawer();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(await screen.findByRole('heading', { name: 'Anna Khoury' })).toBeInTheDocument();
      expect(screen.getByText('W18 · Apr 27 → May 3')).toBeInTheDocument();
    });

    it('falls back to the raw label when it carries no ISO week suffix', () => {
      renderDrawer({ weekLabel: 'This week' });
      expect(screen.getByText('This week · Apr 27 → May 3')).toBeInTheDocument();
    });

    it('shows the over-capacity badge only above 100% utilization', async () => {
      const { unmount } = renderDrawer({ utilPct: 100 });
      expect(screen.queryByText('100% over')).not.toBeInTheDocument();
      unmount();

      renderDrawer({ utilPct: 125 });
      expect(await screen.findByText('125% over')).toBeInTheDocument();
    });
  });

  describe('task list', () => {
    it('shows placeholders and no content while the fetch is in flight', () => {
      getMock.mockReturnValue(new Promise<{ data: AllocationPayload }>(() => {}));
      const { container } = renderDrawer();
      expect(container.getElementsByClassName('motion-safe:animate-pulse')).toHaveLength(3);
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('renders each assigned task with hours, units, status and dates', async () => {
      resolveWith([task()]);
      renderDrawer();
      const items = await screen.findAllByRole('listitem');
      expect(items).toHaveLength(1);
      expect(screen.getByText('Wire the avionics loom')).toBeInTheDocument();
      expect(screen.getByText(/8\.0h/)).toBeInTheDocument();
      expect(screen.getByText('In progress')).toBeInTheDocument();
      expect(screen.getByText('Apr 6 → Apr 10')).toBeInTheDocument();
    });

    it('requests only this resource and week window', async () => {
      renderDrawer();
      await screen.findByRole('list');
      expect(getMock).toHaveBeenCalledWith('/projects/p1/resource-allocation/', {
        params: { resource: 'r1', start: '2026-04-27', end: '2026-05-03' },
      });
    });

    it('shows the empty state when the resource has no tasks that week', async () => {
      resolveWith([]);
      renderDrawer();
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('No assignments for Anna Khoury in W18.');
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('shows the empty state when the response omits this resource entirely', async () => {
      resolveWith([task()], 'someone-else');
      renderDrawer();
      expect(await screen.findByRole('status')).toHaveTextContent('No assignments');
    });

    it('does not fetch, and shows the empty state, without a project id', () => {
      renderDrawer({ projectId: '' });
      expect(getMock).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent('No assignments');
    });

    it('does not fetch without a resource id', () => {
      renderDrawer({ resourceId: '' });
      expect(getMock).not.toHaveBeenCalled();
    });
  });

  describe('task date ranges', () => {
    it('renders an em dash when a task has neither date', async () => {
      resolveWith([task({ early_start: null, early_finish: null })]);
      renderDrawer();
      expect(await screen.findByText('—')).toBeInTheDocument();
    });

    it('renders an open-ended "from" range when only the start is known', async () => {
      resolveWith([task({ early_finish: null })]);
      renderDrawer();
      expect(await screen.findByText('from Apr 6')).toBeInTheDocument();
    });

    it('renders an "until" range when only the finish is known', async () => {
      resolveWith([task({ early_start: null })]);
      renderDrawer();
      expect(await screen.findByText('until Apr 10')).toBeInTheDocument();
    });

    it('renders the SPAN start (scheduled_start), not the narrowed early_start, for an in-progress task (#2677, ADR-0752)', async () => {
      // early_start has narrowed to the remaining-work window; scheduled_start
      // still carries the real span start.
      resolveWith([task({ early_start: '2026-04-09', scheduled_start: '2026-04-06' })]);
      renderDrawer();
      expect(await screen.findByText('Apr 6 → Apr 10')).toBeInTheDocument();
    });

    it('falls back to early_start when scheduled_start is null (not yet recalculated)', async () => {
      resolveWith([task({ early_start: '2026-04-06', scheduled_start: null })]);
      renderDrawer();
      expect(await screen.findByText('Apr 6 → Apr 10')).toBeInTheDocument();
    });

    it('humanizes multi-word statuses', async () => {
      resolveWith([task({ status: 'NOT_STARTED' })]);
      renderDrawer();
      expect(await screen.findByText('Not started')).toBeInTheDocument();
    });
  });

  describe('over-allocation footer', () => {
    it('states the delta above capacity when over-allocated with tasks', async () => {
      renderDrawer({ utilPct: 125 });
      expect(await screen.findByText('25% above capacity this week')).toBeInTheDocument();
    });

    it('is omitted when the week is within capacity', async () => {
      renderDrawer({ utilPct: 80 });
      await screen.findByRole('list');
      expect(screen.queryByText(/above capacity/)).not.toBeInTheDocument();
    });

    it('is omitted when over-allocated but no tasks came back', async () => {
      resolveWith([]);
      renderDrawer({ utilPct: 125 });
      await screen.findByRole('status');
      expect(screen.getByText('125% over')).toBeInTheDocument();
      expect(screen.queryByText(/above capacity/)).not.toBeInTheDocument();
    });
  });

  describe('dismissal', () => {
    it('focuses the close button on mount', () => {
      renderDrawer();
      expect(screen.getByRole('button', { name: 'Close drawer' })).toHaveFocus();
    });

    it('closes on the close button', async () => {
      const onClose = vi.fn();
      renderDrawer({ onClose });
      await userEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the backdrop is clicked', async () => {
      const onClose = vi.fn();
      const { container } = renderDrawer({ onClose });
      const backdrop = container.firstElementChild;
      expect(backdrop).toHaveAttribute('aria-hidden', 'true');
      await userEvent.click(backdrop as Element);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape but ignores other keys', async () => {
      const onClose = vi.fn();
      renderDrawer({ onClose });
      await userEvent.keyboard('a');
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stops listening for Escape once unmounted', async () => {
      const onClose = vi.fn();
      const { unmount } = renderDrawer({ onClose });
      unmount();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(onClose).not.toHaveBeenCalled());
    });
  });
});
