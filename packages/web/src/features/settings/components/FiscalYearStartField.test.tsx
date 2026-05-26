import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { FiscalYearStartField, maxFiscalDay } from './FiscalYearStartField';

/** Controlled wrapper so interactions actually update the rendered value. */
function Harness({ initialMonth = 1, initialDay = 1 }: { initialMonth?: number; initialDay?: number }) {
  const [month, setMonth] = useState(initialMonth);
  const [day, setDay] = useState(initialDay);
  return (
    <FiscalYearStartField
      month={month}
      day={day}
      onChange={(m, d) => {
        setMonth(m);
        setDay(d);
      }}
    />
  );
}

const monthSelect = () => screen.getByLabelText<HTMLSelectElement>('Fiscal year start month');
const daySelect = () => screen.getByLabelText<HTMLSelectElement>('Fiscal year start day');

describe('FiscalYearStartField', () => {
  it('highlights the preset matching the current value and hides the picker', () => {
    render(<Harness initialMonth={1} initialDay={1} />);
    expect(screen.getByRole('button', { name: 'Jan 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText('Fiscal year start month')).not.toBeInTheDocument();
  });

  it('selecting a preset chip moves the highlight', () => {
    render(<Harness initialMonth={1} initialDay={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apr 1' }));
    expect(screen.getByRole('button', { name: 'Apr 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Jan 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the picker and highlights Custom for a value that matches no preset', () => {
    render(<Harness initialMonth={4} initialDay={6} />);
    expect(screen.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'true');
    expect(monthSelect().value).toBe('4');
    expect(daySelect().value).toBe('6');
  });

  it('opening Custom reveals the picker even when the value matches a preset', () => {
    render(<Harness initialMonth={1} initialDay={1} />);
    expect(screen.queryByLabelText('Fiscal year start day')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    expect(screen.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'true');
    expect(daySelect()).toBeInTheDocument();
  });

  it('clamps an out-of-range day down when switching to a shorter month', () => {
    render(<Harness initialMonth={1} initialDay={31} />);
    // Jan 31 matches no preset → picker already visible.
    expect(daySelect().value).toBe('31');
    fireEvent.change(monthSelect(), { target: { value: '2' } });
    // February caps at 28 (year-agnostic), so the day clamps.
    expect(daySelect().value).toBe('28');
  });

  it('only offers days that exist in the chosen month (no Feb 29)', () => {
    render(<Harness initialMonth={2} initialDay={1} />);
    const options = Array.from(daySelect().options).map((o) => o.value);
    expect(options).toEqual(Array.from({ length: 28 }, (_, i) => String(i + 1)));
  });
});

describe('maxFiscalDay', () => {
  it('caps February at 28 and 30-day months at 30', () => {
    expect(maxFiscalDay(2)).toBe(28);
    expect(maxFiscalDay(4)).toBe(30);
    expect(maxFiscalDay(6)).toBe(30);
    expect(maxFiscalDay(9)).toBe(30);
    expect(maxFiscalDay(11)).toBe(30);
    expect(maxFiscalDay(1)).toBe(31);
    expect(maxFiscalDay(12)).toBe(31);
  });
});
