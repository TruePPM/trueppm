import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  HIT_TARGET,
  ladderSignature,
  ScheduleToolbarV2,
  type ScheduleToolbarV2Props,
} from './ScheduleToolbarV2';

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
    baselineBarsDrawn: false,
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

  it('counts only the commands it renders: no Group for a reader without edit rights', () => {
    render(<ScheduleToolbarV2 {...props({ onGroup: undefined, canAddTask: false })} />);
    const trigger = screen.getByRole('button', { name: 'More schedule actions, 4 items' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'More schedule actions, 4 items' });
    expect(menu).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Group' })).toBeNull();
    // The four it names: Columns, Expand all, Dependency links, Export.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Owner' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Dependency links' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export PDF…' })).toBeInTheDocument();
  });

  it('portals its menus out of the 44px bar so nothing clips them (web-rule 253)', () => {
    render(<ScheduleToolbarV2 {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = screen.getByRole('menu', { name: 'Filter' });
    const toolbar = screen.getByRole('toolbar', { name: 'Schedule toolbar' });
    expect(toolbar.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(toolbar.className).not.toMatch(/\boverflow-hidden\b/);
  });

  it('gives every bar control a sized 44px before: hit target, never an inset one (rules 5, 330)', () => {
    // jsdom draws no pseudo-element, so this pins the mechanism; the e2e spec
    // measures the box (rule 330 (c)).
    expect(HIT_TARGET).toContain('before:h-11');
    expect(HIT_TARGET).toContain('before:w-[max(100%,2.75rem)]');
    expect(HIT_TARGET).not.toMatch(/before:-?inset/);
    render(<ScheduleToolbarV2 {...props()} />);
    for (const name of ['Filter', 'Add task', 'Today', 'Baseline', 'Critical only']) {
      const btn = screen.getByRole('button', { name: new RegExp(`^${name}`) });
      expect(btn.className, name).toContain('before:h-11');
      expect(btn.className, name).toContain('h-8');
    }
    fireEvent.click(screen.getByRole('button', { name: /^More schedule actions/ }));
    for (const row of screen.getAllByRole('menuitem')) expect(row.className).toContain('min-h-11');
  });
});

describe('ladderSignature (#4796)', () => {
  const base = {
    baselineAvailable: true,
    canAddTask: true,
    baselineShown: true,
    baselineBarsDrawn: true,
    milestonesOnly: false,
  };
  const sig = (o: Partial<typeof base> = {}, zoom = 'week') =>
    ladderSignature({ ...base, ...o }, zoom);

  it.each([
    ['baselineAvailable', { baselineAvailable: false }],
    ['canAddTask', { canAddTask: false }],
    ['baselineShown', { baselineShown: false }],
    ['baselineBarsDrawn', { baselineBarsDrawn: false }],
    ['milestonesOnly', { milestonesOnly: true }],
  ])('changes when %s changes', (_n, over) => {
    expect(sig(over)).not.toBe(sig());
  });

  it('changes when the zoom level changes', () => {
    expect(sig({}, 'month')).not.toBe(sig());
  });
});
