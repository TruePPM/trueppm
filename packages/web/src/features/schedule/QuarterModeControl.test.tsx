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

  it('is visible at year zoom, not just quarter zoom', () => {
    useScheduleStore.setState({ zoomLevel: 'year' });
    renderControl();
    expect(screen.getByRole('button', { name: /quarters: fiscal/i })).toBeInTheDocument();
  });

  it('names the workspace fiscal start month from the hook', () => {
    fiscalMonthMock.mockReturnValue(7);
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    expect(screen.getByText(/starts July \(workspace\)/i)).toBeInTheDocument();
  });

  describe('when the stored mode is calendar', () => {
    beforeEach(() => {
      useScheduleStore.setState({ quarterMode: 'calendar' });
    });

    it('labels the trigger "Quarters: Calendar"', () => {
      renderControl();
      expect(screen.getByRole('button', { name: /quarters: calendar/i })).toBeInTheDocument();
    });

    it('opens with focus on Calendar and marks it as the selected radio', () => {
      renderControl();
      fireEvent.click(screen.getByRole('button', { name: /quarters: calendar/i }));
      const calendar = screen.getByRole('menuitemradio', { name: /calendar/i });
      const fiscal = screen.getByRole('menuitemradio', { name: /fiscal/i });
      expect(calendar).toHaveFocus();
      expect(calendar).toHaveAttribute('aria-checked', 'true');
      expect(fiscal).toHaveAttribute('aria-checked', 'false');
      // The ●/○ pair is one RadioDotIcon whose `filled` state drives `fill`
      // (issue 1749): solid for the selected radio, hollow ring for the other.
      expect(calendar.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
      expect(fiscal.querySelector('svg')).toHaveAttribute('fill', 'none');
      expect(document.body.textContent).not.toContain('●');
      expect(document.body.textContent).not.toContain('○');
    });

    it('switching back to Fiscal updates the store and the trigger label', () => {
      renderControl();
      fireEvent.click(screen.getByRole('button', { name: /quarters: calendar/i }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: /fiscal/i }));
      expect(useScheduleStore.getState().quarterMode).toBe('fiscal');
      expect(screen.getByRole('button', { name: /quarters: fiscal/i })).toBeInTheDocument();
    });
  });

  it('only advertises aria-controls while the menu is open', () => {
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    expect(trigger).not.toHaveAttribute('aria-controls');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
  });

  it('clicking the trigger again closes the open menu', () => {
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes when a pointer press lands outside the menu and the trigger', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays open when the pointer press lands inside the menu', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.pointerDown(screen.getByRole('menuitemradio', { name: /calendar/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('stays open when the pointer press lands on the trigger itself', () => {
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('stops listening for outside presses once the menu is closed', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('ArrowUp from the first item wraps to the settings link', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: /workspace settings/i })).toHaveFocus();
  });

  it('ArrowDown from the last item wraps back to the first', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: /workspace settings/i })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: /fiscal/i })).toHaveFocus();
  });

  it('Home returns focus to the first item', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitemradio', { name: /fiscal/i })).toHaveFocus();
  });

  it('roving tabindex follows the active item', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    const fiscal = screen.getByRole('menuitemradio', { name: /fiscal/i });
    const calendar = screen.getByRole('menuitemradio', { name: /calendar/i });
    const link = screen.getByRole('menuitem', { name: /workspace settings/i });
    expect(fiscal).toHaveAttribute('tabindex', '0');
    expect(calendar).toHaveAttribute('tabindex', '-1');
    expect(link).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(fiscal).toHaveAttribute('tabindex', '-1');
    expect(calendar).toHaveAttribute('tabindex', '0');
  });

  it('Tab closes the menu without yanking focus back to the trigger', () => {
    renderControl();
    const trigger = screen.getByRole('button', { name: /quarters: fiscal/i });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it('ignores unrelated keys and leaves the menu open on the active item', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'a' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /fiscal/i })).toHaveFocus();
  });

  it('closes the menu when the settings link is followed', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /workspace settings/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the stored mode untouched when the menu is merely dismissed', () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: /quarters: fiscal/i }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(useScheduleStore.getState().quarterMode).toBe('fiscal');
  });
});
