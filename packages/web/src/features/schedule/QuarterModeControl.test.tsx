import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuarterModeControl } from './QuarterModeControl';
import { useScheduleStore } from '@/stores/scheduleStore';

const fiscalMonthMock = vi.fn<() => number>(() => 4);
vi.mock('@/hooks/useFiscalYearStartMonth', () => ({
  useFiscalYearStartMonth: () => fiscalMonthMock(),
}));

function renderControl() {
  return render(
    <MemoryRouter>
      <QuarterModeControl />
    </MemoryRouter>,
  );
}

describe('QuarterModeControl (#755)', () => {
  beforeEach(() => {
    fiscalMonthMock.mockReturnValue(4); // April-start workspace
    useScheduleStore.setState({ zoomLevel: 'quarter', quarterMode: 'fiscal' });
  });

  it('is hidden at day/week/month zoom', () => {
    useScheduleStore.setState({ zoomLevel: 'week' });
    renderControl();
    expect(screen.queryByRole('button', { name: /quarters/i })).not.toBeInTheDocument();
  });

  it('is hidden when the workspace fiscal year starts in January', () => {
    fiscalMonthMock.mockReturnValue(1);
    renderControl();
    expect(screen.queryByRole('button', { name: /quarters/i })).not.toBeInTheDocument();
  });

  it('shows the current mode in the trigger at quarter zoom', () => {
    renderControl();
    expect(screen.getByRole('button', { name: /quarters: fiscal/i })).toBeInTheDocument();
  });

  it('opens a menu naming the fiscal source month and the calendar option', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    expect(screen.getByRole('menuitemradio', { name: /fiscal/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/starts April \(workspace\)/i)).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /calendar/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('menuitem', { name: /workspace settings/i })).toBeInTheDocument();
  });

  it('switching to Calendar updates the store and the trigger label', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /calendar/i }));
    expect(useScheduleStore.getState().quarterMode).toBe('calendar');
    expect(screen.getByRole('button', { name: /quarters: calendar/i })).toBeInTheDocument();
  });

  it('opens with focus on the checked option', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    expect(screen.getByRole('menuitemradio', { name: /fiscal/i })).toHaveFocus();
  });

  it('ArrowDown moves focus to the next menu item (roving focus)', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: /calendar/i })).toHaveFocus();
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
