import { describe, it, expect } from 'vitest';
import { boardGridTemplate, BOARD_STUB_W } from './boardGrid';
import type { TaskStatus } from '@/types';

const COLS: { status: TaskStatus }[] = [
  { status: 'NOT_STARTED' },
  { status: 'IN_PROGRESS' },
  { status: 'REVIEW' },
  { status: 'COMPLETE' },
];

describe('boardGridTemplate (#1458/#1459)', () => {
  it('starts every template with the sticky phase-sidebar track', () => {
    const tpl = boardGridTemplate(COLS, new Set());
    expect(tpl.startsWith('var(--board-phase-col,188px) ')).toBe(true);
  });

  it('renders one fixed --board-col-w track per column when nothing is collapsed', () => {
    const tpl = boardGridTemplate(COLS, new Set());
    const colTracks = tpl.replace('var(--board-phase-col,188px) ', '').split(' ');
    expect(colTracks).toHaveLength(COLS.length);
    expect(colTracks.every((t) => t === 'var(--board-col-w,272px)')).toBe(true);
  });

  it('renders a fixed stub-width track for a collapsed column', () => {
    const tpl = boardGridTemplate(COLS, new Set<TaskStatus>(['IN_PROGRESS']));
    const colTracks = tpl.replace('var(--board-phase-col,188px) ', '').split(' ');
    expect(colTracks).toEqual([
      'var(--board-col-w,272px)',
      `${BOARD_STUB_W}px`,
      'var(--board-col-w,272px)',
      'var(--board-col-w,272px)',
    ]);
  });

  it('preserves column order and count when several columns are collapsed', () => {
    const tpl = boardGridTemplate(COLS, new Set<TaskStatus>(['NOT_STARTED', 'COMPLETE']));
    const colTracks = tpl.replace('var(--board-phase-col,188px) ', '').split(' ');
    expect(colTracks).toEqual([
      `${BOARD_STUB_W}px`,
      'var(--board-col-w,272px)',
      'var(--board-col-w,272px)',
      `${BOARD_STUB_W}px`,
    ]);
  });

  it('emits only the sidebar track when there are no columns', () => {
    expect(boardGridTemplate([], new Set())).toBe('var(--board-phase-col,188px) ');
  });

  describe('explicit column widths (#285)', () => {
    it('emits a fixed px track for a column with a stored width, default otherwise', () => {
      const tpl = boardGridTemplate(COLS, new Set(), { IN_PROGRESS: 320 });
      const colTracks = tpl.replace('var(--board-phase-col,188px) ', '').split(' ');
      expect(colTracks).toEqual([
        'var(--board-col-w,272px)',
        '320px',
        'var(--board-col-w,272px)',
        'var(--board-col-w,272px)',
      ]);
    });

    it('lets a collapsed stub win over a stored width for the same column', () => {
      const tpl = boardGridTemplate(COLS, new Set<TaskStatus>(['IN_PROGRESS']), {
        IN_PROGRESS: 320,
      });
      const colTracks = tpl.replace('var(--board-phase-col,188px) ', '').split(' ');
      expect(colTracks[1]).toBe(`${BOARD_STUB_W}px`);
    });

    it('ignores an empty width map (behaves like the two-arg call)', () => {
      expect(boardGridTemplate(COLS, new Set(), {})).toBe(
        boardGridTemplate(COLS, new Set()),
      );
    });
  });
});
