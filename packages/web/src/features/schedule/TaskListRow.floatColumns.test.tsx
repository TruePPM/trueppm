/**
 * Schedule outline float columns (#3344).
 *
 * The engine has computed `total_float` and `free_float` since 0.1 and the API
 * has returned both since; the outline showed neither. These cover the four
 * readings a cell can have, the two facts a screen reader needs from it, and the
 * two collisions the column set is capable of causing elsewhere.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFeatureFlag } from '@/lib/featureFlags';
import { renderWithRouter } from '@/test/utils';
import { TaskListRow, formatFloatCell, floatCellAriaLabel } from './TaskListRow';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 180, links: 76, dur: 52, start: 74, finish: 74,
  progress: 52, owner: 72, totalFloat: 64, freeFloat: 64,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true,
  progress: true, owner: true, totalFloat: true, freeFloat: true,
};

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

const tree = { hasChildren: false, isExpanded: false, onToggleId: vi.fn() };

function renderRow(over: Partial<Task>, vis: ColumnWidths['visible'] = visible) {
  return renderWithRouter(
    <TaskListRow task={{ ...base, ...over }} level={1} widths={widths} visible={vis} {...tree} />,
  );
}

describe('formatFloatCell', () => {
  it('renders a bare Nd, and an em-dash for a value CPM has not produced', () => {
    expect(formatFloatCell(5)).toBe('5d');
    expect(formatFloatCell(0)).toBe('0d');
    expect(formatFloatCell(-3)).toBe('-3d');
    expect(formatFloatCell(null)).toBe('—');
    expect(formatFloatCell(undefined)).toBe('—');
  });

  it('never emits the phrase "float", which four shipped surfaces locate by text', () => {
    // `getByText('5d float')` and a `getByText(/0d float/)` asserted to be
    // absent both exist in the shipped E2E suite, against the board card and the
    // drawer. A per-row cell repeating that phrase turns each of them into a
    // strict-mode collision on a surface that did not change.
    for (const v of [5, 0, -3, null]) {
      expect(formatFloatCell(v)).not.toMatch(/float/i);
    }
  });
});

describe('floatCellAriaLabel', () => {
  it('states lateness in WORDS, so the critical colour is never the only carrier', () => {
    expect(floatCellAriaLabel('Total float', -3)).toBe('Total float: 3 working days late');
  });

  it('separates "not computed" from zero', () => {
    expect(floatCellAriaLabel('Free float', null)).toBe('Free float: not computed yet');
    expect(floatCellAriaLabel('Free float', 0)).toBe('Free float: 0 working days');
  });

  it('singularises one day', () => {
    expect(floatCellAriaLabel('Total float', 1)).toBe('Total float: 1 working day');
  });
});

describe('floatCellAriaLabel band (shell v2)', () => {
  it('speaks the band the glyph prints, and leaves v1 and late values alone', () => {
    expect(floatCellAriaLabel('Total float', 0, 'critical')).toBe(
      'Total float: critical, 0 days float',
    );
    expect(floatCellAriaLabel('Total float', 2, 'near-critical')).toBe(
      'Total float: near-critical, 2 days float',
    );
    expect(floatCellAriaLabel('Total float', 0, null)).toBe('Total float: 0 working days');
    expect(floatCellAriaLabel('Total float', -3, 'critical')).toBe(
      'Total float: 3 working days late',
    );
  });
});

describe('TaskListRow — float cells', () => {
  it('renders both columns, each naming which float it is', () => {
    renderRow({ totalFloat: 5, freeFloat: 2 });
    expect(
      screen.getByRole('gridcell', { name: 'Total float: 5 working days' }),
    ).toHaveTextContent('5d');
    expect(
      screen.getByRole('gridcell', { name: 'Free float: 2 working days' }),
    ).toHaveTextContent('2d');
  });

  it('turns a NEGATIVE cell critical, in colour AND weight', () => {
    renderRow({ totalFloat: -2, freeFloat: -2 });
    const cell = screen.getByRole('gridcell', { name: 'Total float: 2 working days late' });
    expect(cell.className).toMatch(/text-semantic-critical/);
    expect(cell.className).toMatch(/font-semibold/);
  });

  it('leaves ZERO float uncoloured — a fully constrained plan is not an exception', () => {
    // Zero is the ordinary state of every row on the critical path, and the row
    // name already carries criticality in weight and colour. Colouring the cell
    // too would make the column a wall of red on the plans that need it most.
    renderRow({ totalFloat: 0, freeFloat: 0, isCritical: true });
    const cell = screen.getByRole('gridcell', { name: 'Total float: 0 working days' });
    expect(cell.className).not.toMatch(/text-semantic-critical/);
  });

  it('renders neither cell when the columns are hidden', () => {
    renderRow({ totalFloat: 5, freeFloat: 2 }, { ...visible, totalFloat: false, freeFloat: false });
    expect(screen.queryByRole('gridcell', { name: /Total float/ })).toBeNull();
    expect(screen.queryByRole('gridcell', { name: /Free float/ })).toBeNull();
  });

  it('renders Total float alone when only Free float is hidden', () => {
    renderRow({ totalFloat: 5, freeFloat: 2 }, { ...visible, freeFloat: false });
    expect(screen.getByRole('gridcell', { name: /Total float/ })).toBeInTheDocument();
    expect(screen.queryByRole('gridcell', { name: /Free float/ })).toBeNull();
  });
});

describe('shell v2 Total float glyphs (#5106)', () => {
  afterEach(() => setFeatureFlag('shell_v2', false));

  it('prints ▲ for critical and ◆ for near-critical, only under shell_v2', () => {
    setFeatureFlag('shell_v2', true);
    const { unmount } = renderRow({ isCritical: true, totalFloat: 0, freeFloat: 0 });
    expect(
      screen.getByRole('gridcell', { name: 'Total float: critical, 0 days float' }),
    ).toHaveTextContent('\u25B2 0d');
    // Free float never wears a band glyph.
    expect(screen.getByRole('gridcell', { name: 'Free float: 0 working days' })).toHaveTextContent(
      /^0d$/,
    );
    unmount();
    setFeatureFlag('shell_v2', false);
    renderRow({ isCritical: true, totalFloat: 0 });
    expect(screen.getByRole('gridcell', { name: 'Total float: 0 working days' })).toHaveTextContent(
      /^0d$/,
    );
  });
});
