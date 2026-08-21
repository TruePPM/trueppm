import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DateOrderBlock, ambiguousContinueLabel, joinColumns } from './DateOrderBlock';
import type { CsvPreview } from '@/hooks/useCsvImport';

/** A preview shaped like the server's, with only the date fields varied. */
function preview(over: Partial<CsvPreview> = {}): CsvPreview {
  return {
    filename: 'plan.csv',
    headers: ['Name', 'Start', 'Finish'],
    columns: [],
    sample_rows: [],
    row_count: 486,
    truncated_rows: 0,
    task_count: 486,
    resource_count: 0,
    row_errors: [],
    error_count: 0,
    warning_count: 0,
    warnings: [],
    available_fields: [],
    date_order: 'auto',
    date_order_resolved: 'dmy',
    date_order_auto: 'dmy',
    date_order_ambiguous: false,
    date_order_has_columns: true,
    date_order_evidence: {
      row: 14,
      column: 'Start',
      value: '13/04/2026',
      reason: 'no_thirteenth_month',
    },
    date_order_readings: [],
    values_matched: 486,
    values_failed: 0,
    date_preview: [],
    ...over,
  };
}

const AMBIGUOUS = preview({
  date_order_resolved: 'mdy',
  date_order_auto: 'mdy',
  date_order_ambiguous: true,
  date_order_evidence: null,
  date_order_readings: [
    {
      order: 'mdy',
      sample_row: 2,
      sample_name: 'Design',
      sample_raw_start: '03/04/2026',
      start: '2026-03-04',
      finish: '2026-05-04',
      duration_days: 62,
      values_matched: 486,
      values_failed: 0,
      rows_unparseable: 0,
    },
    {
      order: 'dmy',
      sample_row: 2,
      sample_name: 'Design',
      sample_raw_start: '03/04/2026',
      start: '2026-04-03',
      finish: '2026-04-05',
      duration_days: 3,
      values_matched: 486,
      values_failed: 0,
      rows_unparseable: 0,
    },
  ],
});

function renderBlock(over: Partial<CsvPreview> = {}, props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(
    <DateOrderBlock
      preview={preview(over)}
      value="auto"
      onChange={onChange}
      busy={false}
      dateColumnNames={['Start', 'Finish']}
      {...props}
    />,
  );
  return { onChange };
}

describe('joinColumns', () => {
  it('renders the mapped column names as prose, never as a count', () => {
    expect(joinColumns(['Start', 'Finish'])).toBe('Start and Finish');
    expect(joinColumns(['Start'])).toBe('Start');
    expect(joinColumns(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('DateOrderBlock — the confirming state', () => {
  it('names the row, the value and the reason its inference came from', () => {
    renderBlock();
    const live = screen.getByText(/Auto read this file as/i).closest('p');
    // The claim is checkable against the file in five seconds — which is the
    // entire difference between this and the notice it replaces.
    expect(live).toHaveTextContent('Row 14 is “13/04/2026”');
    expect(live).toHaveTextContent('there is no 13th month');
    expect(live).toHaveTextContent('All 486 values in Start and Finish fit that reading');
  });

  it('announces changes politely rather than stealing focus', () => {
    renderBlock();
    const live = screen.getByText(/Auto read this file as/i).closest('p');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('shows what Auto resolved to on the chip, so it never reads as no opinion', () => {
    renderBlock();
    expect(screen.getByRole('radio', { name: 'Auto · D/M/Y' })).toBeInTheDocument();
  });

  it('states the ISO case without inventing a row-level reason', () => {
    renderBlock({
      date_order_resolved: 'iso',
      date_order_auto: 'iso',
      date_order_evidence: {
        row: 2,
        column: 'Start',
        value: '2026-04-03',
        reason: 'non_slash_layout',
      },
    });
    expect(screen.getByText(/ISO 8601 \(YYYY-MM-DD\)/)).toBeInTheDocument();
    expect(screen.getByText(/match that pattern/)).toBeInTheDocument();
  });
});

describe('DateOrderBlock — ambiguous, the state the ticket exists for', () => {
  it('says Auto cannot tell, and never uses the word "ambiguous"', () => {
    render(
      <DateOrderBlock
        preview={AMBIGUOUS}
        value="auto"
        onChange={vi.fn()}
        busy={false}
        dateColumnNames={['Start', 'Finish']}
      />,
    );
    expect(screen.getByText(/Auto cannot tell/)).toBeInTheDocument();
    expect(screen.queryByText(/ambiguous/i)).not.toBeInTheDocument();
  });

  it('signals the decision four ways, none of which is colour', () => {
    render(
      <DateOrderBlock
        preview={AMBIGUOUS}
        value="auto"
        onChange={vi.fn()}
        busy={false}
        dateColumnNames={['Start', 'Finish']}
      />,
    );
    // 1. the text badge, 2. the question-marked Auto chip, 3. the statement…
    expect(screen.getByText('Needs a decision')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto · M/D/Y?' })).toBeInTheDocument();
    expect(screen.getByText(/nothing in this file identifies its own convention/)).toBeInTheDocument();
    // 4. …and the wizard's own primary-button copy, kept in step by this export.
    expect(ambiguousContinueLabel('mdy')).toBe('Confirm M/D/Y and continue');
  });

  it('puts both readings in a table so the durations are comparable', () => {
    render(
      <DateOrderBlock
        preview={AMBIGUOUS}
        value="auto"
        onChange={vi.fn()}
        busy={false}
        dateColumnNames={['Start', 'Finish']}
      />,
    );
    const mdy = screen.getByRole('rowheader', { name: /M\/D\/Y/ }).closest('tr');
    const dmy = screen.getByRole('rowheader', { name: /D\/M\/Y/ }).closest('tr');
    // The 59-day difference on one task is the whole argument for the block.
    expect(within(mdy as HTMLElement).getByText('62 days')).toBeInTheDocument();
    expect(within(dmy as HTMLElement).getByText('3 days')).toBeInTheDocument();
  });

  it('lets the operator choose a reading straight from the comparison', async () => {
    const onChange = vi.fn();
    render(
      <DateOrderBlock
        preview={AMBIGUOUS}
        value="auto"
        onChange={onChange}
        busy={false}
        dateColumnNames={['Start', 'Finish']}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use D/M/Y' }));
    expect(onChange).toHaveBeenCalledWith('dmy');
  });
});

describe('DateOrderBlock — the quiet states', () => {
  it('stays present but inert when no date column is mapped', () => {
    // Hiding it means an operator who maps Start *after* reading the step never
    // learns the setting exists.
    renderBlock({ date_order_has_columns: false }, { dateColumnNames: [] });
    expect(screen.getByText('Not needed')).toBeInTheDocument();
    expect(screen.getByText(/Map a date column and the control becomes live/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('reports a refetch without locking the control', () => {
    renderBlock({}, { busy: true, value: 'dmy' });
    expect(screen.getByText(/Re-reading 486 rows as D\/M\/Y…/)).toBeInTheDocument();
    // A third change must be able to supersede the second.
    expect(screen.getByRole('radio', { name: 'D/M/Y' })).not.toBeDisabled();
  });

  it('names both orders once the operator has overridden', () => {
    renderBlock({ date_order_resolved: 'dmy', date_order_auto: 'mdy' }, { value: 'dmy' });
    expect(screen.getByText(/Set by you: D\/M\/Y \(day first\)/)).toBeInTheDocument();
    expect(screen.getByText(/Auto would have read this file as M\/D\/Y/)).toBeInTheDocument();
  });

  it('counts the rows that fail under the chosen order rather than hiding them', () => {
    renderBlock(
      {
        date_order_resolved: 'mdy',
        date_order_auto: 'dmy',
        values_matched: 484,
        values_failed: 2,
        date_preview: [
          {
            row: 14,
            name: 'Handover',
            raw_start: '13/04/2026',
            raw_finish: '14/04/2026',
            start: null,
            finish: null,
            duration_days: null,
            unreadable: true,
          },
        ],
      },
      { value: 'mdy' },
    );
    expect(
      screen.getByText(/2 of 486 date values cannot be read as M\/D\/Y/),
    ).toBeInTheDocument();
    expect(screen.getByText(/They will import without dates/)).toBeInTheDocument();
  });
});

describe('DateOrderBlock — keyboard', () => {
  it('is one tab stop, and arrows move and select', async () => {
    const { onChange } = renderBlock();
    const auto = screen.getByRole('radio', { name: 'Auto · D/M/Y' });
    expect(auto).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'M/D/Y' })).toHaveAttribute('tabindex', '-1');

    auto.focus();
    await userEvent.keyboard('{ArrowRight}');
    // Selection commits on move, per web-rule 179.
    expect(onChange).toHaveBeenCalledWith('mdy');
  });

  it('jumps to the ends with Home and End', async () => {
    const { onChange } = renderBlock();
    screen.getByRole('radio', { name: 'Auto · D/M/Y' }).focus();
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenCalledWith('iso');
  });
});
