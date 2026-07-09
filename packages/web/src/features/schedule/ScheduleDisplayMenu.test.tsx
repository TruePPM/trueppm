import { type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ScheduleDisplayMenu, type DisplayMenuRow } from './ScheduleDisplayMenu';

function setup(overrides: Partial<ComponentProps<typeof ScheduleDisplayMenu>> = {}) {
  const props: ComponentProps<typeof ScheduleDisplayMenu> = {
    showCpOnly: false,
    setShowCpOnly: vi.fn(),
    focusModeEnabled: false,
    setFocusModeEnabled: vi.fn(),
    showCriticalOnly: false,
    setShowCriticalOnly: vi.fn(),
    showMilestonesOnly: false,
    setShowMilestonesOnly: vi.fn(),
    columns: null,
    iconOnly: false,
    ...overrides,
  };
  render(<ScheduleDisplayMenu {...props} />);
  return props;
}

describe('ScheduleDisplayMenu (#1741)', () => {
  it('renders a labeled trigger and no badge when no filters are active', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByText('Display')).toBeInTheDocument();
    // No active-filter count in the accessible name.
    expect(trigger.getAttribute('aria-label')).toBe('Display');
  });

  it('carries the active-filter count in the trigger accessible name and a badge', () => {
    setup({ showCpOnly: true, showMilestonesOnly: true });
    const trigger = screen.getByRole('button', { name: /display, 2 active filters/i });
    expect(trigger).toBeInTheDocument();
    // The visible pill shows the count (decorative — aria-hidden).
    expect(within(trigger).getByText('2')).toBeInTheDocument();
  });

  it('uses the singular "filter" for exactly one active filter', () => {
    setup({ focusModeEnabled: true });
    expect(
      screen.getByRole('button', { name: 'Display, 1 active filter' }),
    ).toBeInTheDocument();
  });

  it('opens the popover and toggles a filter in place (menu stays open)', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    const menu = screen.getByRole('menu', { name: 'Display options' });
    expect(within(menu).getByText('View filters')).toBeInTheDocument();
    expect(within(menu).getByText('Render filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'CP only' }));
    expect(props.setShowCpOnly).toHaveBeenCalledWith(true);
    // Multi-toggle: the menu stays open after a checkbox click.
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument();
  });

  it('omits the Columns section when no columns are provided', () => {
    setup({ columns: null });
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.queryByText('Columns')).toBeNull();
  });

  it('renders the Columns section when columns are provided', () => {
    const onChange = vi.fn();
    const columns: DisplayMenuRow[] = [
      { id: 'dur', label: 'Duration', checked: true, onChange },
      { id: 'start', label: 'Start', checked: false, onChange },
    ];
    setup({ columns });
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.getByText('Columns')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Duration' }));
    // Duration was checked → toggling requests the opposite.
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape and restores focus to the trigger', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Display' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Display options' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Display options' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('icon-only mode hides the visible label but keeps the accessible name', () => {
    setup({ iconOnly: true, showCpOnly: true });
    // The visible "Display" text is gone…
    expect(screen.queryByText('Display')).toBeNull();
    // …but the trigger still exposes its accessible name (with the active count).
    expect(
      screen.getByRole('button', { name: 'Display, 1 active filter' }),
    ).toBeInTheDocument();
  });
});
