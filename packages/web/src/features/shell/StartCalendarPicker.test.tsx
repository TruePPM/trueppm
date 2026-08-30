import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { StartCalendarPicker } from './StartCalendarPicker';
import type { InheritedCalendar } from './useInheritedCalendar';

const libraryResult = {
  data: [] as Array<{ id: string; name: string; working_days: number; hours_per_day: number; timezone: string; exceptions: unknown[] }>,
  isLoading: false,
};
vi.mock('@/hooks/useProjectCalendars', () => ({
  useCalendarLibrary: () => libraryResult,
}));

function inherited(over: Partial<InheritedCalendar> = {}): InheritedCalendar {
  return {
    id: null,
    name: 'System default',
    summary: 'Mon – Fri · 8h/day',
    source: 'system_default',
    loading: false,
    ...over,
  };
}

describe('StartCalendarPicker (#2728)', () => {
  beforeEach(() => {
    libraryResult.data = [];
    libraryResult.isLoading = false;
  });

  it('the default option always names the resolved inherited calendar', () => {
    renderWithProviders(
      <StartCalendarPicker
        value={null}
        onChange={vi.fn()}
        inherited={inherited({ id: 'cal-1', name: 'Standard 40h', source: 'workspace' })}
      />,
    );
    const picker = screen.getByRole('combobox', { name: /working calendar/i });
    expect(within(picker).getByRole('option', { name: /standard 40h \(inherited\)/i })).toBeInTheDocument();
    expect(picker).toHaveValue('');
  });

  it('excludes the inherited calendar from the override list (it is already the default option)', () => {
    libraryResult.data = [
      { id: 'cal-1', name: 'Standard 40h', working_days: 31, hours_per_day: 8, timezone: 'UTC', exceptions: [] },
      { id: 'cal-2', name: 'Compressed 4x10', working_days: 30, hours_per_day: 10, timezone: 'UTC', exceptions: [] },
    ];
    renderWithProviders(
      <StartCalendarPicker
        value={null}
        onChange={vi.fn()}
        inherited={inherited({ id: 'cal-1', name: 'Standard 40h', source: 'workspace' })}
      />,
    );
    const picker = screen.getByRole('combobox', { name: /working calendar/i });
    expect(within(picker).getAllByRole('option', { name: /standard 40h/i })).toHaveLength(1);
    expect(within(picker).getByRole('option', { name: 'Compressed 4x10' })).toBeInTheDocument();
  });

  it('picking an explicit calendar calls onChange with its id', async () => {
    libraryResult.data = [
      { id: 'cal-2', name: 'Compressed 4x10', working_days: 30, hours_per_day: 10, timezone: 'UTC', exceptions: [] },
    ];
    const onChange = vi.fn();
    renderWithProviders(
      <StartCalendarPicker value={null} onChange={onChange} inherited={inherited()} />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /working calendar/i }),
      'cal-2',
    );
    expect(onChange).toHaveBeenCalledWith('cal-2');
  });

  it('picking the blank option again calls onChange with null (back to inherited)', async () => {
    libraryResult.data = [
      { id: 'cal-2', name: 'Compressed 4x10', working_days: 30, hours_per_day: 10, timezone: 'UTC', exceptions: [] },
    ];
    const onChange = vi.fn();
    renderWithProviders(
      <StartCalendarPicker value="cal-2" onChange={onChange} inherited={inherited()} />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /working calendar/i }),
      '',
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('is disabled while the inherited resolution is still loading', () => {
    renderWithProviders(
      <StartCalendarPicker value={null} onChange={vi.fn()} inherited={inherited({ loading: true })} />,
    );
    expect(screen.getByRole('combobox', { name: /working calendar/i })).toBeDisabled();
  });

  it('attaches to a form it is rendered outside of when given a formId (#3130)', () => {
    // The Start sheet pins this field in its footer, below the scrolling <form>,
    // so without the attribute the browser drops it from that form's implicit
    // submission and Enter silently does nothing here.
    renderWithProviders(
      <StartCalendarPicker
        value={null}
        onChange={vi.fn()}
        inherited={inherited()}
        formId="new-project-form"
      />,
    );
    expect(screen.getByRole('combobox', { name: /working calendar/i })).toHaveAttribute(
      'form',
      'new-project-form',
    );
  });

  it('omits the form attribute entirely when no formId is given', () => {
    renderWithProviders(
      <StartCalendarPicker value={null} onChange={vi.fn()} inherited={inherited()} />,
    );
    expect(screen.getByRole('combobox', { name: /working calendar/i })).not.toHaveAttribute('form');
  });
});
