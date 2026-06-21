import { describe, it, expect } from 'vitest';
import {
  initialsOf,
  buildContextLabel,
  buildBoardPrintData,
  type BoardPrintFilters,
} from './boardPrintData';
import type { Task, TaskStatus } from '@/types';

/** Minimal Task factory — only the fields the print transform reads. */
function task(over: Partial<Task> & { id: string; status: TaskStatus }): Task {
  return {
    name: over.name ?? `Task ${over.id}`,
    assignees: [],
    isCritical: false,
    isMilestone: false,
    finish: '',
    ...over,
  } as Task;
}

const NO_FILTERS: BoardPrintFilters = {
  myTasks: false,
  atRisk: false,
  techDebt: false,
  showCost: false,
  searchQuery: '',
  savedViewName: null,
};

describe('initialsOf', () => {
  it('takes first + last initial for multi-word names', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('  Grace  Brewster  Hopper ')).toBe('GH');
  });

  it('takes first two letters for a single-word name', () => {
    expect(initialsOf('Cher')).toBe('CH');
  });

  it('returns null for an empty/whitespace name', () => {
    expect(initialsOf('')).toBeNull();
    expect(initialsOf('   ')).toBeNull();
  });
});

describe('buildContextLabel', () => {
  it('reports "All cards" when no filter is active', () => {
    expect(buildContextLabel(NO_FILTERS)).toBe('All cards');
  });

  it('composes the active filters into a "Filtered —" line', () => {
    expect(
      buildContextLabel({
        ...NO_FILTERS,
        myTasks: true,
        atRisk: true,
        techDebt: true,
        searchQuery: '  payments  ',
        savedViewName: 'Release readiness',
      }),
    ).toBe('Filtered — View: Release readiness · My tasks · At-risk · Tech debt · Search: "payments"');
  });

  it('ignores a whitespace-only search query', () => {
    expect(buildContextLabel({ ...NO_FILTERS, searchQuery: '   ' })).toBe('All cards');
  });
});

describe('buildBoardPrintData', () => {
  const columns = [
    { status: 'NOT_STARTED' as TaskStatus, label: 'To do' },
    { status: 'IN_PROGRESS' as TaskStatus, label: 'In progress' },
  ];

  it('maps lanes/tasks into the print model and drops cards outside visible columns', () => {
    const data = buildBoardPrintData({
      projectName: 'Apollo',
      sprintName: 'Sprint 4',
      columns,
      lanes: [
        {
          id: 'p1',
          name: 'Phase 1',
          tasks: [
            task({ id: 't1', status: 'NOT_STARTED', name: 'Design', assignees: [{ name: 'Ada Lovelace' }] as Task['assignees'] }),
            task({ id: 't2', status: 'IN_PROGRESS', name: 'Build' }),
            // BACKLOG is not a visible column → must be excluded.
            task({ id: 't3', status: 'BACKLOG', name: 'Someday' }),
          ],
        },
      ],
      userName: 'Sarah PM',
      generatedAtLabel: 'Jun 21, 2026',
      filters: NO_FILTERS,
    });

    expect(data.projectName).toBe('Apollo');
    expect(data.sprintName).toBe('Sprint 4');
    expect(data.lanes).toHaveLength(1);
    const cards = data.lanes[0].cards;
    expect(cards.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(cards[0].assignee).toBe('Ada Lovelace');
    expect(cards[0].assigneeInitials).toBe('AL');
    expect(data.footer.userName).toBe('Sarah PM');
    expect(data.footer.generatedAtLabel).toBe('Jun 21, 2026');
    expect(data.footer.contextLabel).toBe('All cards');
  });

  it('keeps an empty lane rather than dropping it', () => {
    const data = buildBoardPrintData({
      projectName: 'Apollo',
      sprintName: null,
      columns,
      lanes: [{ id: 'p2', name: 'Empty phase', tasks: [task({ id: 'x', status: 'BACKLOG' })] }],
      userName: null,
      generatedAtLabel: 'now',
      filters: NO_FILTERS,
    });
    expect(data.lanes).toHaveLength(1);
    expect(data.lanes[0].cards).toHaveLength(0);
  });
});
