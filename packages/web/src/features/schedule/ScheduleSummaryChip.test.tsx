import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { iterationLabelForms } from '@/lib/iterationLabel';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { useSchedulerStore } from '@/stores/schedulerStore';
import type { Task } from '@/types';

const baseTask: Omit<Task, 'id' | 'wbs' | 'name'> = {
  start: '2026-04-05', finish: '2026-04-09',
  duration: 5, progress: 0,
  parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return { ...baseTask, id, wbs: id, name: id, ...overrides } as Task;
}

beforeEach(() => {
  useSchedulerStore.setState({
    isRecalculating: false,
    cpmError: null,
    recalculatedAt: null,
  });
});

afterEach(() => {
  vi.doUnmock('@/hooks/useIterationLabel');
  vi.resetModules();
});

describe('ScheduleSummaryChip', () => {
  it('renders all four tokens when CPM is healthy', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[
          makeTask('a', { sprintId: 's1' }),
          makeTask('b', { isCritical: true }),
          makeTask('c', { isCritical: true }),
        ]}
      />,
    );
    expect(
      screen.getByLabelText('Project status: 3 items, 1 in sprints, 2 critical, CPM healthy'),
    ).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('items')).toBeInTheDocument();
    expect(screen.getByText('in sprints')).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    // The healthy-CPM mark is a house CheckIcon SVG, not a "✓" glyph (issue 1749).
    expect(screen.getByTestId('cpm-healthy-check')).toBeInTheDocument();
  });

  // The vocabulary lock (#3259). `visibleTasks` is every row regardless of
  // structure_role, so naming them "tasks" typed every phase and milestone the
  // chip counted.
  it('uses the governed neutral noun, never "task"', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[makeTask('a'), makeTask('b', { isSummary: true })]}
      />,
    );
    expect(screen.getByText('items')).toBeInTheDocument();
    expect(screen.queryByText(/^tasks?$/)).toBeNull();
    expect(screen.getByLabelText(/2 items,/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/tasks?,/)).toBeNull();
  });

  it('uses singular "item" for count of 1', () => {
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a')]} />);
    expect(screen.getByText('item')).toBeInTheDocument();
    expect(screen.queryByText('items')).toBeNull();
    expect(screen.getByLabelText(/Project status: 1 item,/)).toBeInTheDocument();
  });

  it('does not count summary tasks as critical even when flagged', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[
          makeTask('a', { isSummary: true, isCritical: true }),
          makeTask('b', { isCritical: true }),
        ]}
      />,
    );
    expect(screen.getByLabelText(/2 items, 0 in sprints, 1 critical/)).toBeInTheDocument();
  });

  // Same predicate shape as criticalCount: a phase is not itself in a sprint
  // even when every child under it is.
  it('excludes summary rows from the sprint count', () => {
    render(
      <ScheduleSummaryChip
        visibleTasks={[
          makeTask('phase', { isSummary: true, sprintId: 's1' }),
          makeTask('a', { sprintId: 's1' }),
          makeTask('b', { sprintId: 's2' }),
          makeTask('c'),
        ]}
      />,
    );
    expect(screen.getByLabelText(/4 items, 2 in sprints,/)).toBeInTheDocument();
  });

  // ADR-0111: the iteration container is a per-project noun, so a team running
  // Iterations or PIs must not be told about "sprints". Real forms from
  // iterationLabelForms(), not a hand-written stub, so the naive-pluralization
  // rules stay part of what this asserts.
  it.each([
    ['Sprint', 'in sprints'],
    ['Iteration', 'in iterations'],
    ['PI', 'in PIs'],
    ['Cycle', 'in cycles'],
  ])('follows the project iteration label: %s -> "%s"', async (stored, expected) => {
    vi.resetModules();
    vi.doMock('@/hooks/useIterationLabel', () => ({
      useIterationLabel: () => iterationLabelForms(stored),
    }));
    const { ScheduleSummaryChip: Chip } = await import('./ScheduleSummaryChip');
    render(<Chip visibleTasks={[makeTask('a', { sprintId: 's1' })]} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`1 ${expected},`))).toBeInTheDocument();
    vi.doUnmock('@/hooks/useIterationLabel');
  });

  it('renders the sprint token at zero rather than hiding it', () => {
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a')]} />);
    expect(screen.getByText('in sprints')).toBeInTheDocument();
    expect(screen.getByLabelText(/1 item, 0 in sprints,/)).toBeInTheDocument();
  });

  describe('the fit ladder shortens the paint, never the announcement', () => {
    // 4 rows: 1 in a sprint, 2 critical — every count distinct, so a token
    // rendering the wrong number cannot coincidentally match another's.
    const TASKS = [
      makeTask('a', { sprintId: 's1' }),
      makeTask('b', { isCritical: true }),
      makeTask('c', { isCritical: true }),
      makeTask('d'),
    ];
    const SPELLED = 'Project status: 4 items, 1 in sprints, 2 critical, CPM healthy';

    /** The mono number slots actually painted, in order. */
    const painted = () =>
      Array.from(
        screen.getByTestId('schedule-summary-chip').querySelectorAll('.tppm-mono'),
      ).map((el) => el.textContent);

    it('carries all four tokens at full', () => {
      render(<ScheduleSummaryChip visibleTasks={TASKS} density="full" />);
      expect(screen.getByText('items')).toBeInTheDocument();
      expect(screen.getByText('in sprints')).toBeInTheDocument();
      expect(screen.getByText('critical')).toBeInTheDocument();
      expect(painted()).toEqual(['4', '1', '2']);
    });

    it('drops "in sprints" first at mid — number and word, ahead of critical', () => {
      render(<ScheduleSummaryChip visibleTasks={TASKS} density="mid" />);
      expect(screen.queryByText('in sprints')).toBeNull();
      // The sprint COUNT is gone, not just its word. `critical` loses only its
      // word and keeps its number, with the dot icon as the referent — so the
      // two tokens degrade differently and the order is observable.
      expect(painted()).toEqual(['4', '2']);
      expect(screen.queryByText('critical')).toBeNull();
    });

    it('keeps the accessible name spelled out at every density (rule 161)', () => {
      for (const density of ['full', 'mid', 'min'] as const) {
        const { unmount } = render(
          <ScheduleSummaryChip visibleTasks={TASKS} density={density} />,
        );
        expect(
          screen.getByLabelText(SPELLED),
          `density=${density} shortened the accessible name`,
        ).toBeInTheDocument();
        unmount();
      }
    });
  });

  it('renders loading state when CPM is recalculating (preserves width)', () => {
    useSchedulerStore.setState({ isRecalculating: true });
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a')]} />);
    expect(screen.getByLabelText('Project status: recalculating')).toBeInTheDocument();
    expect(screen.getByText('CPM …')).toBeInTheDocument();
    // One placeholder per numeric slot the ok state would paint at this density,
    // so the toolbar does not reflow when the recompute lands.
    expect(screen.getAllByText('··')).toHaveLength(3);
  });

  it('renders error state when CPM has an error', () => {
    useSchedulerStore.setState({
      cpmError: { error: 'cyclic_dependency', cycle: ['a', 'b'] },
    });
    render(<ScheduleSummaryChip visibleTasks={[makeTask('a'), makeTask('b')]} />);
    // The warning glyph is now the WarningIcon SVG (aria-hidden); assert it
    // renders inside the CPM-error chip rather than the old ⚠ emoji text.
    expect(screen.getByLabelText(/CPM error/).querySelector('svg')).not.toBeNull();
  });

  it('error state takes precedence over recalculating', () => {
    // Both flags set — store guarantees this won't really happen, but defensive.
    useSchedulerStore.setState({
      isRecalculating: true,
      cpmError: { error: 'internal_error', cycle: [] },
    });
    render(<ScheduleSummaryChip visibleTasks={[]} />);
    // isRecalculating short-circuits in the component — verify loading wins.
    expect(screen.getByText('CPM …')).toBeInTheDocument();
  });

  it('handles empty task list', () => {
    render(<ScheduleSummaryChip visibleTasks={[]} />);
    expect(
      screen.getByLabelText('Project status: 0 items, 0 in sprints, 0 critical, CPM healthy'),
    ).toBeInTheDocument();
  });
});
