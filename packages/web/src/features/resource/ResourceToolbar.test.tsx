import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { ResourceToolbar, type ViewMode } from './ResourceToolbar';

// jsdom has no matchMedia; useBreakpoint is stubbed with a mutable tier so each
// test can drive the sm / md / lg branches of the responsive toolbar (#568).
const bp = vi.hoisted(() => ({ current: 'lg' as 'sm' | 'md' | 'lg' }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => bp.current }));

function makeHandlers() {
  return {
    onViewModeChange: vi.fn<(mode: ViewMode) => void>(),
    onStatusFiltersChange: vi.fn<(filters: string[]) => void>(),
    onResourceSearchChange: vi.fn<(value: string) => void>(),
    onPrev: vi.fn<() => void>(),
    onNext: vi.fn<() => void>(),
    onToday: vi.fn<() => void>(),
    onFitToggle: vi.fn<() => void>(),
    onMyAllocationToggle: vi.fn<() => void>(),
  };
}

interface Overrides {
  viewMode?: ViewMode;
  windowStart?: string;
  windowEnd?: string;
  unassignedCount?: number;
  overallocationCount?: number;
  isFitToProject?: boolean;
  myAllocationActive?: boolean;
  showMyAllocation?: boolean;
  statusFilters?: string[];
  resourceSearch?: string;
}

function renderToolbar(overrides: Overrides = {}) {
  const handlers = makeHandlers();
  const view = renderWithProviders(
    <ResourceToolbar
      viewMode={overrides.viewMode ?? 'timeline'}
      windowStart={overrides.windowStart ?? '2026-01-05'}
      windowEnd={overrides.windowEnd ?? '2026-02-02'}
      unassignedCount={overrides.unassignedCount ?? 0}
      overallocationCount={overrides.overallocationCount ?? 0}
      isFitToProject={overrides.isFitToProject ?? false}
      myAllocationActive={overrides.myAllocationActive ?? false}
      showMyAllocation={overrides.showMyAllocation ?? true}
      statusFilters={overrides.statusFilters ?? []}
      resourceSearch={overrides.resourceSearch ?? ''}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
}

beforeEach(() => {
  bp.current = 'lg';
});

describe('ResourceToolbar', () => {
  describe('view mode segmented control', () => {
    it('marks Timeline selected in timeline mode', () => {
      renderToolbar({ viewMode: 'timeline' });
      expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Utilization' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('marks Utilization selected in utilization mode', () => {
      renderToolbar({ viewMode: 'utilization' });
      expect(screen.getByRole('tab', { name: 'Utilization' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('emits the clicked mode', async () => {
      const { onViewModeChange } = renderToolbar({ viewMode: 'timeline' });
      await userEvent.click(screen.getByRole('tab', { name: 'Utilization' }));
      expect(onViewModeChange).toHaveBeenCalledWith('utilization');
      await userEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
      expect(onViewModeChange).toHaveBeenLastCalledWith('timeline');
    });

    it('exposes the toolbar and the mode group with accessible names', () => {
      renderToolbar();
      expect(screen.getByRole('toolbar', { name: 'Resource toolbar' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Resource view mode' })).toBeInTheDocument();
    });
  });

  describe('window navigation', () => {
    it('wires previous / today / next', async () => {
      const { onPrev, onToday, onNext } = renderToolbar();
      await userEvent.click(screen.getByRole('button', { name: 'Previous period' }));
      await userEvent.click(screen.getByRole('button', { name: 'Today' }));
      await userEvent.click(screen.getByRole('button', { name: 'Next period' }));
      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onToday).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('renders the formatted date window as an accessible label', () => {
      renderToolbar({ windowStart: '2026-01-05', windowEnd: '2026-02-02' });
      expect(
        screen.getByLabelText('Date window: Mon 5 Jan to Mon 2 Feb'),
      ).toBeInTheDocument();
    });
  });

  describe('fit to project', () => {
    it('offers Fit to project when the window is not fitted', async () => {
      const { onFitToggle } = renderToolbar({ isFitToProject: false });
      const btn = screen.getByRole('button', { name: '⤢ Fit to project' });
      await userEvent.click(btn);
      expect(onFitToggle).toHaveBeenCalledTimes(1);
    });

    it('offers Reset to today when the window is fitted', () => {
      renderToolbar({ isFitToProject: true });
      expect(screen.getByRole('button', { name: 'Reset to today' })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '⤢ Fit to project' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('My allocation toggle', () => {
    it('renders inactive and toggles on click', async () => {
      const { onMyAllocationToggle } = renderToolbar({ myAllocationActive: false });
      const btn = screen.getByRole('button', { name: 'My allocation' });
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(btn);
      expect(onMyAllocationToggle).toHaveBeenCalledTimes(1);
    });

    it('renders pressed when the filter is active', () => {
      renderToolbar({ myAllocationActive: true });
      expect(screen.getByRole('button', { name: 'My allocation' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('is hidden when the user has no resource record', () => {
      renderToolbar({ showMyAllocation: false });
      expect(screen.queryByRole('button', { name: 'My allocation' })).not.toBeInTheDocument();
    });

    it('is hidden in utilization mode', () => {
      renderToolbar({ viewMode: 'utilization' });
      expect(screen.queryByRole('button', { name: 'My allocation' })).not.toBeInTheDocument();
    });

    it('is hidden at the sm tier (it moves into the overflow menu)', () => {
      bp.current = 'sm';
      renderToolbar();
      expect(screen.queryByRole('button', { name: 'My allocation' })).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Resource secondary controls' }),
      ).toBeInTheDocument();
    });
  });

  describe('overflow menu (sm tier)', () => {
    it('is not rendered at md or lg', () => {
      bp.current = 'md';
      renderToolbar();
      expect(
        screen.queryByRole('button', { name: 'Resource secondary controls' }),
      ).not.toBeInTheDocument();
    });

    it('is not rendered in utilization mode even at sm', () => {
      bp.current = 'sm';
      renderToolbar({ viewMode: 'utilization' });
      expect(
        screen.queryByRole('button', { name: 'Resource secondary controls' }),
      ).not.toBeInTheDocument();
    });

    it('exposes My allocation plus every status as checkbox items', async () => {
      bp.current = 'sm';
      const { onMyAllocationToggle } = renderToolbar({
        statusFilters: ['IN_PROGRESS'],
        myAllocationActive: true,
      });
      await userEvent.click(
        screen.getByRole('button', { name: 'Resource secondary controls' }),
      );
      expect(screen.getByRole('menuitemcheckbox', { name: 'My allocation' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('menuitemcheckbox', { name: 'In progress' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(screen.getByRole('menuitemcheckbox', { name: 'On hold' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'My allocation' }));
      expect(onMyAllocationToggle).toHaveBeenCalledTimes(1);
    });

    it('omits My allocation when the user has no resource record', async () => {
      bp.current = 'sm';
      renderToolbar({ showMyAllocation: false });
      await userEvent.click(
        screen.getByRole('button', { name: 'Resource secondary controls' }),
      );
      expect(
        screen.queryByRole('menuitemcheckbox', { name: 'My allocation' }),
      ).not.toBeInTheDocument();
      expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(4);
    });

    it('adds a status from the menu', async () => {
      bp.current = 'sm';
      const { onStatusFiltersChange } = renderToolbar({ statusFilters: ['COMPLETE'] });
      await userEvent.click(
        screen.getByRole('button', { name: 'Resource secondary controls' }),
      );
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Not started' }));
      expect(onStatusFiltersChange).toHaveBeenCalledWith(['COMPLETE', 'NOT_STARTED']);
    });

    it('removes a status from the menu', async () => {
      bp.current = 'sm';
      const { onStatusFiltersChange } = renderToolbar({
        statusFilters: ['COMPLETE', 'ON_HOLD'],
      });
      await userEvent.click(
        screen.getByRole('button', { name: 'Resource secondary controls' }),
      );
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Complete' }));
      expect(onStatusFiltersChange).toHaveBeenCalledWith(['ON_HOLD']);
    });
  });

  describe('overallocation badge', () => {
    it('is absent when nothing is overallocated', () => {
      renderToolbar({ overallocationCount: 0 });
      expect(screen.queryByText(/over-allocated/)).not.toBeInTheDocument();
    });

    it('uses the singular noun for one resource', () => {
      renderToolbar({ overallocationCount: 1 });
      expect(screen.getByLabelText('1 over-allocated resource')).toHaveTextContent(
        '1 over-allocated',
      );
    });

    it('uses the plural noun for several resources', () => {
      renderToolbar({ overallocationCount: 3 });
      expect(screen.getByLabelText('3 over-allocated resources')).toBeInTheDocument();
    });

    it('is absent in utilization mode', () => {
      renderToolbar({ overallocationCount: 3, viewMode: 'utilization' });
      expect(screen.queryByText(/over-allocated/)).not.toBeInTheDocument();
    });
  });

  describe('unassigned count', () => {
    it('is absent when every task is assigned', () => {
      renderToolbar({ viewMode: 'utilization', unassignedCount: 0 });
      expect(screen.queryByText(/without assignment/)).not.toBeInTheDocument();
    });

    it('uses the singular noun for one task', () => {
      renderToolbar({ viewMode: 'utilization', unassignedCount: 1 });
      expect(screen.getByText('1 task without assignment')).toBeInTheDocument();
    });

    it('uses the plural noun for several tasks', () => {
      renderToolbar({ viewMode: 'utilization', unassignedCount: 4 });
      expect(screen.getByText('4 tasks without assignment')).toBeInTheDocument();
    });

    it('is absent in timeline mode', () => {
      renderToolbar({ viewMode: 'timeline', unassignedCount: 4 });
      expect(screen.queryByText(/without assignment/)).not.toBeInTheDocument();
    });
  });

  describe('secondary row (status filters + search)', () => {
    it('reflects the active status filters', () => {
      renderToolbar({ statusFilters: ['IN_PROGRESS', 'COMPLETE'] });
      expect(screen.getByRole('checkbox', { name: 'In progress' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Complete' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Not started' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'On hold' })).not.toBeChecked();
    });

    it('adds an unchecked status to the filter set', async () => {
      const { onStatusFiltersChange } = renderToolbar({ statusFilters: ['IN_PROGRESS'] });
      await userEvent.click(screen.getByRole('checkbox', { name: 'On hold' }));
      expect(onStatusFiltersChange).toHaveBeenCalledWith(['IN_PROGRESS', 'ON_HOLD']);
    });

    it('removes a checked status from the filter set', async () => {
      const { onStatusFiltersChange } = renderToolbar({
        statusFilters: ['IN_PROGRESS', 'ON_HOLD'],
      });
      await userEvent.click(screen.getByRole('checkbox', { name: 'In progress' }));
      expect(onStatusFiltersChange).toHaveBeenCalledWith(['ON_HOLD']);
    });

    it('shows the current search text and emits each keystroke', async () => {
      const { onResourceSearchChange } = renderToolbar({ resourceSearch: 'ali' });
      const input = screen.getByRole<HTMLInputElement>('searchbox', {
        name: 'Filter resources by name',
      });
      expect(input.value).toBe('ali');
      await userEvent.type(input, 'c');
      expect(onResourceSearchChange).toHaveBeenCalledWith('alic');
    });

    it('is hidden in utilization mode', () => {
      renderToolbar({ viewMode: 'utilization' });
      expect(screen.queryByRole('checkbox', { name: 'Not started' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('searchbox', { name: 'Filter resources by name' }),
      ).not.toBeInTheDocument();
    });

    it('is hidden at the sm tier', () => {
      bp.current = 'sm';
      renderToolbar();
      expect(screen.queryByRole('checkbox', { name: 'Not started' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('searchbox', { name: 'Filter resources by name' }),
      ).not.toBeInTheDocument();
    });

    it('is rendered at the md tier', () => {
      bp.current = 'md';
      renderToolbar();
      expect(screen.getByRole('checkbox', { name: 'Not started' })).toBeInTheDocument();
    });
  });
});
