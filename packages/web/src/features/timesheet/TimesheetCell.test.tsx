import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TimesheetCell } from './TimesheetCell';

function renderCell(overrides: Partial<Parameters<typeof TimesheetCell>[0]> = {}) {
  const onSave = vi.fn();
  render(
    <TimesheetCell
      minutes={120}
      editable
      entryCount={1}
      isWeekend={false}
      isToday={false}
      ariaLabel="ENG-1 Build, Mon 15"
      onSave={onSave}
      {...overrides}
    />,
  );
  return { onSave };
}

describe('TimesheetCell', () => {
  it('shows the committed value as h:mm in the editable input', () => {
    renderCell({ minutes: 150 });
    expect(screen.getByRole('textbox')).toHaveValue('2:30');
  });

  it('parses typed hours and commits the new minutes on Enter', () => {
    const { onSave } = renderCell({ minutes: 120 });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2:30' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledExactlyOnceWith(150);
  });

  it('reverts and does not save on Escape', () => {
    const { onSave } = renderCell({ minutes: 120 });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(input).toHaveValue('2:00');
  });

  it('reverts unparseable input without saving', () => {
    const { onSave } = renderCell({ minutes: 120 });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'not-hours' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(input).toHaveValue('2:00');
  });

  it('does not save when the value is unchanged', () => {
    const { onSave } = renderCell({ minutes: 120 });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2:00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('commits the edited value on blur', () => {
    const { onSave } = renderCell({ minutes: 120 });
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(240);
  });

  it('renders an inline validation reason and marks the input invalid (#1945)', () => {
    renderCell({ errorText: 'Entry date cannot be in the future.' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Entry date cannot be in the future.');
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
  });

  it('shows no alert when there is no error', () => {
    renderCell();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
  });

  it('renders a multi-entry cell read-only (ADR-0224) with an edit-on-My-Work hint', () => {
    renderCell({ editable: false, entryCount: 3, minutes: 180, lockReason: 'multi-entry' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const cell = screen.getByRole('gridcell');
    expect(cell).toHaveAttribute('aria-readonly', 'true');
    expect(cell).toHaveAccessibleName(/3 entries — edit on My Work/);
    expect(cell).toHaveTextContent('3:00');
  });

  it('pluralizes the multi-entry hint by count (never "1 entries")', () => {
    // A single-entry cell must never reach this branch in the grid, but the label must
    // still read correctly if it does (#2174 — the grammar bug the batch fixes).
    renderCell({ editable: false, entryCount: 1, minutes: 60, lockReason: 'multi-entry' });
    const cell = screen.getByRole('gridcell');
    expect(cell).toHaveAccessibleName(/1 entry — edit on My Work/);
    expect(cell).not.toHaveAccessibleName(/1 entries/);
  });

  it('a submitted cell with time names the Reopen-week remedy, not My Work (#2174)', () => {
    renderCell({ editable: false, entryCount: 1, minutes: 300, lockReason: 'submitted' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const cell = screen.getByRole('gridcell');
    expect(cell).toHaveAttribute('aria-readonly', 'true');
    // Correct remedy, correct value; no "N entries" grammar and no "edit on My Work".
    expect(cell).toHaveAccessibleName(/5:00 — week submitted, reopen to edit \(Reopen week, top right\)/);
    expect(cell).not.toHaveAccessibleName(/entries/);
    expect(cell).not.toHaveAccessibleName(/My Work/);
    expect(cell).toHaveTextContent('5:00');
    // A cell that carries time stays reachable so the guidance is heard in focus mode.
    expect(cell).toHaveAttribute('tabindex', '0');
  });

  it('a submitted empty cell is inert, non-focusable, and not announced as "0 entries" (#2174)', () => {
    renderCell({ editable: false, entryCount: 0, minutes: 0, lockReason: 'submitted' });
    const cell = screen.getByRole('gridcell');
    expect(cell).toHaveAttribute('aria-readonly', 'true');
    expect(cell).toHaveAccessibleName(/week submitted/);
    expect(cell).not.toHaveAccessibleName(/entries/);
    expect(cell).not.toHaveAccessibleName(/reopen to edit/);
    // No extra tab stop per blank day on a submitted week.
    expect(cell).not.toHaveAttribute('tabindex');
  });

  it('renders a future-day cell inert and non-editable (#1926)', () => {
    // A future day is not loggable — no input to POST a doomed future entry_date.
    renderCell({ isFuture: true, editable: true, entryCount: 0, minutes: 0 });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const cell = screen.getByRole('gridcell');
    expect(cell).toHaveAttribute('aria-readonly', 'true');
    expect(cell).toHaveAccessibleName(/future date, not loggable/);
  });
});
