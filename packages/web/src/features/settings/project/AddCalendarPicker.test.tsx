import type { ComponentProps } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AddCalendarPicker } from './AddCalendarPicker';
import type { Calendar } from '@/hooks/useProjectCalendars';

// EnterpriseBadge reads the edition via a query hook; stub it so the picker can
// render without a QueryClientProvider (the badge itself is not under test here).
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

function cal(id: string, name: string, exceptionCount = 0): Calendar {
  return {
    id,
    server_version: 1,
    name,
    working_days: 31,
    hours_per_day: 8,
    timezone: 'UTC',
    exceptions: Array.from({ length: exceptionCount }, (_, i) => ({
      id: `${id}-x${i}`,
      exc_start: '2026-11-11',
      exc_end: '2026-11-11',
      description: 'Holiday',
    })),
  };
}

const LIBRARY: Calendar[] = [
  cal('c-uk', 'UK Bank Holidays 2026', 8),
  cal('c-us', 'US Federal Holidays 2026', 11),
  cal('c-eng', 'Engineering 4-day week'),
];

function renderPicker(overrides: Partial<ComponentProps<typeof AddCalendarPicker>> = {}) {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(
    <AddCalendarPicker
      variant="popover"
      library={LIBRARY}
      appliedIds={new Set(['c-us'])}
      loading={false}
      submitting={false}
      onAdd={onAdd}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onAdd, onClose };
}

describe('AddCalendarPicker', () => {
  it('lists library calendars and flags already-applied ones as disabled', () => {
    renderPicker();
    // The applied calendar is present but disabled and labeled "Applied".
    const appliedOption = screen.getByRole('option', { name: /US Federal Holidays 2026/ });
    expect(appliedOption).toBeDisabled();
    expect(within(appliedOption).getByText('Applied')).toBeInTheDocument();
    // A non-applied calendar is selectable.
    expect(screen.getByRole('option', { name: /UK Bank Holidays 2026/ })).toBeEnabled();
  });

  it('filters the list by the search query', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search calendars'), { target: { value: 'UK' } });
    expect(screen.getByRole('option', { name: /UK Bank Holidays 2026/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Engineering 4-day week/ })).not.toBeInTheDocument();
  });

  it('shows a loading row while the library query is resolving', () => {
    renderPicker({ loading: true, library: [] });
    expect(screen.getByText('Loading calendars…')).toBeInTheDocument();
    expect(screen.queryByText(/No calendars/)).not.toBeInTheDocument();
  });

  it('distinguishes a genuine no-results state from loading', () => {
    renderPicker({ loading: false });
    fireEvent.change(screen.getByLabelText('Search calendars'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No calendars match “zzzz”/)).toBeInTheDocument();
    expect(screen.queryByText('Loading calendars…')).not.toBeInTheDocument();
  });

  it('toggles selection and reflects the count, disabling Add until one is picked', () => {
    renderPicker();
    const add = screen.getByRole('button', { name: /^Add 0 calendars$/ });
    expect(add).toBeDisabled();

    const uk = screen.getByRole('option', { name: /UK Bank Holidays 2026/ });
    fireEvent.click(uk);
    expect(uk).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add 1 calendar$/ })).toBeEnabled();

    // Toggling off returns the count to zero.
    fireEvent.click(uk);
    expect(uk).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });

  it('calls onAdd with the selected calendar ids on confirm', () => {
    const { onAdd } = renderPicker();
    fireEvent.click(screen.getByRole('option', { name: /UK Bank Holidays 2026/ }));
    fireEvent.click(screen.getByRole('option', { name: /Engineering 4-day week/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Add 2 calendars$/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toEqual(expect.arrayContaining(['c-uk', 'c-eng']));
    expect(onAdd.mock.calls[0][0]).toHaveLength(2);
  });

  it('Cancel invokes onClose', () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Issue #1913 — dismiss-guard (web-rule 217) on Escape / scrim / Cancel
  // ---------------------------------------------------------------------

  describe('dismiss-guard (#1913)', () => {
    it('Cancel with a selection made opens the discard prompt instead of closing', () => {
      const { onClose } = renderPicker();
      fireEvent.click(screen.getByRole('option', { name: /UK Bank Holidays 2026/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Keep editing dismisses the prompt and preserves the selection', () => {
      const { onClose } = renderPicker();
      fireEvent.click(screen.getByRole('option', { name: /UK Bank Holidays 2026/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    it('Discard changes closes the picker', () => {
      const { onClose } = renderPicker();
      fireEvent.click(screen.getByRole('option', { name: /UK Bank Holidays 2026/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('scrim-click on the mobile sheet with a selection made opens the discard prompt', () => {
      const { onClose } = renderPicker({ variant: 'sheet' });
      fireEvent.click(screen.getByRole('option', { name: /UK Bank Holidays 2026/ }));
      // Two elements share the accessible name "Close" (scrim + header button) —
      // the scrim is the first in document order.
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('scrim-click on the mobile sheet with no selection closes immediately', () => {
      const { onClose } = renderPicker({ variant: 'sheet' });
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
