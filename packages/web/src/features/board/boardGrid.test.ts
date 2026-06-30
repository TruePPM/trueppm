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
});
