import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DateCellValue, FULL_MARKER_MIN_WIDTH_PX } from './DateCellValue';
import type { ReconcileEntry } from './reconcileState';

function entry(over: Partial<ReconcileEntry> = {}): ReconcileEntry {
  return {
    taskId: 't1',
    field: 'finish',
    taskName: 'Spec freeze',
    status: 'diverged',
    expected: '2026-10-13',
    actual: '2026-10-16',
    reason: null,
    retry: null,
    since: 0,
    ...over,
  };
}

/** The shipped default for the start/finish columns (`useColumnWidths`). */
const DEFAULT_WIDTH = 74;

describe('DateCellValue', () => {
  it('renders the plain date with no entry', () => {
    const { container } = render(
      <DateCellValue value="2026-10-13" entry={undefined} widthPx={DEFAULT_WIDTH} />,
    );
    expect(container).toHaveTextContent('Oct 13');
    expect(container.querySelector('.italic')).toBeNull();
  });

  it('italicizes a preview value', () => {
    const { container } = render(
      <DateCellValue
        value="2026-10-13"
        entry={entry({ status: 'preview', actual: null })}
        widthPx={DEFAULT_WIDTH}
      />,
    );
    expect(container.querySelector('.italic')).toHaveTextContent('Oct 13');
  });

  it('at the DEFAULT column width shows the arrow + new date only', () => {
    // 74px cannot hold "Oct 13 →Oct 16"; the struck old value is dropped and the
    // full claim lives on the cell's aria-label/title and in the review strip.
    render(<DateCellValue value="2026-10-16" entry={entry()} widthPx={DEFAULT_WIDTH} />);
    const marker = screen.getByTestId('reconcile-cell-diverged');
    expect(marker).toHaveTextContent('→Oct 16');
    expect(marker.querySelector('s')).toBeNull();
  });

  it('at a widened column ALSO shows the struck-through old value', () => {
    render(
      <DateCellValue value="2026-10-16" entry={entry()} widthPx={FULL_MARKER_MIN_WIDTH_PX} />,
    );
    const marker = screen.getByTestId('reconcile-cell-diverged');
    expect(marker.querySelector('s')).toHaveTextContent('Oct 13');
    expect(marker).toHaveTextContent('Oct 13→Oct 16');
  });

  it('the arrow is the non-color signal and is hidden from assistive tech', () => {
    // The cell's aria-label carries the claim; the glyph must not be read twice.
    render(<DateCellValue value="2026-10-16" entry={entry()} widthPx={DEFAULT_WIDTH} />);
    const arrow = screen.getByTestId('reconcile-cell-diverged').querySelector('[aria-hidden]');
    expect(arrow).toHaveTextContent('→');
  });

  it('renders the em-dash fallback when the task has no date', () => {
    const { container } = render(
      <DateCellValue value={null} entry={undefined} widthPx={DEFAULT_WIDTH} />,
    );
    expect(container).toHaveTextContent('—');
  });

  it('tones a refused value without changing the date shown', () => {
    render(
      <DateCellValue
        value="2026-10-13"
        entry={entry({ status: 'rejected', reason: 'Locked.' })}
        widthPx={DEFAULT_WIDTH}
      />,
    );
    expect(screen.getByTestId('reconcile-cell-rejected')).toHaveTextContent('Oct 13');
  });

  it('renders no interactive element — the treegrid must not gain a tab stop per row', () => {
    const { container } = render(
      <DateCellValue value="2026-10-16" entry={entry()} widthPx={FULL_MARKER_MIN_WIDTH_PX} />,
    );
    expect(container.querySelector('button, a, [tabindex]')).toBeNull();
  });
});
