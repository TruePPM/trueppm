import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduleToolbarV2, type ScheduleToolbarV2Props } from './ScheduleToolbarV2';

vi.mock('../ZoomControl', () => ({
  ZoomControl: ({ collapsed }: { collapsed?: boolean }) => (
    <button type="button">{collapsed ? 'Month ▾' : 'Zoom'}</button>
  ),
}));

function props(over: Partial<ScheduleToolbarV2Props> = {}): ScheduleToolbarV2Props {
  return {
    onFit: vi.fn(),
    canAddTask: true,
    onAddTask: vi.fn(),
    createPending: false,
    onToday: vi.fn(),
    baselineAvailable: true,
    baselineShown: false,
    onToggleBaseline: vi.fn(),
    criticalOnly: false,
    onToggleCriticalOnly: vi.fn(),
    milestonesOnly: false,
    onToggleMilestonesOnly: vi.fn(),
    canGroup: false,
    onGroup: vi.fn(),
    columns: [{ key: 'owner', label: 'Owner', visible: true }],
    onToggleColumn: vi.fn(),
    onExpandAll: vi.fn(),
    dependencyLinesShown: true,
    onToggleDependencyLines: vi.fn(),
    exportItems: [{ label: 'Export PDF…', onSelect: vi.fn() }],
    legend: () => <span>legend</span>,
    onLegendPlacementChange: vi.fn(),
    ...over,
  };
}

describe('ScheduleToolbarV2 (#4796)', () => {
  it('renders the primary and inline controls and an overflow named with its count', () => {
    render(<ScheduleToolbarV2 {...props()} />);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add task/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Baseline' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Critical only' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More schedule actions, 5 items' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
  });

  it('omits Baseline and Add task when they have nothing to act on', () => {
    render(<ScheduleToolbarV2 {...props({ baselineAvailable: false, canAddTask: false })} />);
    expect(screen.queryByRole('button', { name: 'Baseline' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add task/ })).toBeNull();
  });

  it('is a single tab stop with roving focus', () => {
    render(<ScheduleToolbarV2 {...props()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Schedule toolbar' });
    const stops = () => toolbar.querySelectorAll('[tabindex="0"]');
    expect(stops()).toHaveLength(1);
    const filter = screen.getByRole('button', { name: 'Filter' });
    expect(filter).toHaveAttribute('tabindex', '0');
    filter.focus();
    fireEvent.keyDown(filter, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveTextContent('Zoom');
    expect(stops()).toHaveLength(1);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toHaveAccessibleName('More schedule actions, 5 items');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(filter);
  });

  it('opens the overflow menu, moves focus into it, and Escape returns focus', () => {
    const p = props();
    render(<ScheduleToolbarV2 {...p} />);
    const trigger = screen.getByRole('button', { name: 'More schedule actions, 5 items' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'More schedule actions, 5 items' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Group' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Dependency links' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('runs a menu item and closes', () => {
    const p = props();
    render(<ScheduleToolbarV2 {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'More schedule actions, 5 items' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expand all' }));
    expect(p.onExpandAll).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reports the legend placement at rest (unmeasurable bar = roomy, rule 343)', () => {
    const p = props();
    render(<ScheduleToolbarV2 {...p} />);
    expect(p.onLegendPlacementChange).toHaveBeenCalledWith('bar');
    expect(screen.getByText('legend')).toBeInTheDocument();
  });
});
