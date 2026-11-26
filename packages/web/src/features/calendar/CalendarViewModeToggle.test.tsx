import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CalendarViewModeToggle } from './CalendarViewModeToggle';
import type { CalViewMode } from './calendarUtils';

function Harness({ initial = 'month' as CalViewMode }) {
  const [mode, setMode] = useState<CalViewMode>(initial);
  return <CalendarViewModeToggle value={mode} onChange={setMode} />;
}

describe('CalendarViewModeToggle (rule 179, #3180)', () => {
  it('is a radiogroup of radios with aria-checked and a single roving tab stop', () => {
    render(<Harness initial="week" />);
    expect(screen.getByRole('radiogroup', { name: 'Calendar view mode' })).toBeInTheDocument();
    const month = screen.getByRole('radio', { name: 'Month' });
    const week = screen.getByRole('radio', { name: 'Week' });
    expect(week).toHaveAttribute('aria-checked', 'true');
    expect(month).toHaveAttribute('aria-checked', 'false');
    expect(week).toHaveAttribute('tabindex', '0');
    expect(month).toHaveAttribute('tabindex', '-1');
  });

  it('keeps the offset focus ring and a filled active segment', () => {
    render(<Harness initial="week" />);
    const week = screen.getByRole('radio', { name: 'Week' });
    expect(week.className).toContain('focus-visible:ring-offset-1');
    expect(week.className).toContain('bg-brand-primary');
  });

  it('arrow keys move AND commit the selection, wrapping at the ends, and move focus', async () => {
    const user = userEvent.setup();
    render(<Harness initial="month" />);
    const month = screen.getByRole('radio', { name: 'Month' });
    const week = screen.getByRole('radio', { name: 'Week' });
    month.focus();

    await user.keyboard('{ArrowRight}');
    expect(week).toHaveAttribute('aria-checked', 'true');
    expect(week).toHaveFocus();

    await user.keyboard('{ArrowRight}'); // wraps
    expect(month).toHaveAttribute('aria-checked', 'true');
    expect(month).toHaveFocus();

    await user.keyboard('{ArrowLeft}'); // wraps back
    expect(week).toHaveAttribute('aria-checked', 'true');
  });

  it('Home and End jump to the first and last option; ArrowUp/Down also move', async () => {
    const user = userEvent.setup();
    render(<Harness initial="month" />);
    screen.getByRole('radio', { name: 'Month' }).focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true');
  });

  it('clicking a segment selects it', async () => {
    render(<Harness initial="month" />);
    await userEvent.click(screen.getByRole('radio', { name: 'Week' }));
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
  });
});
