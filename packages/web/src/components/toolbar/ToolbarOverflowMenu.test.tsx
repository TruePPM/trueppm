import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolbarOverflowMenu, type ToolbarOverflowItem } from './ToolbarOverflowMenu';

function actionItem(id: string, onSelect = vi.fn(), disabled = false): ToolbarOverflowItem {
  return { kind: 'action', id, label: `Action ${id}`, onSelect, disabled };
}

function checkboxItem(
  id: string,
  checked = false,
  onChange = vi.fn(),
): ToolbarOverflowItem {
  return { kind: 'checkbox', id, label: `Toggle ${id}`, checked, onChange };
}

describe('<ToolbarOverflowMenu>', () => {
  it('renders the trigger but no menu until opened', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the menu and exposes items by role on click', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a'), checkboxItem('b', true)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const menu = screen.getByRole('menu', { name: 'More options' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toBeInTheDocument();
    const checkbox = screen.getByRole('menuitemcheckbox', { name: /Toggle b/ });
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
  });

  it('uses a custom aria-label when triggerAriaLabel is set', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a')]} triggerAriaLabel="Schedule overflow" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Schedule overflow' }));
    expect(screen.getByRole('menu', { name: 'Schedule overflow' })).toBeInTheDocument();
  });

  it('activates an action item, calls onSelect, and closes the menu', () => {
    const onSelect = vi.fn();
    render(<ToolbarOverflowMenu items={[actionItem('a', onSelect)]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action a' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('toggles a checkbox item without closing the menu', () => {
    const onChange = vi.fn();
    render(<ToolbarOverflowMenu items={[checkboxItem('b', false, onChange)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Toggle b/ }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('ignores activation when an item is disabled', () => {
    const onSelect = vi.fn();
    render(
      <ToolbarOverflowMenu items={[actionItem('a', onSelect, true)]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitem', { name: 'Action a' });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens with ArrowDown and focuses the first item', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    act(() => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    });
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toHaveFocus();
  });

  it('navigates items with ArrowDown / ArrowUp and wraps at the ends', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Action b' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Action c' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Action c' })).toHaveFocus();
  });

  it('jumps to first and last with Home and End', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Action c' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when the user clicks outside the menu', () => {
    render(
      <div>
        <button type="button">outside</button>
        <ToolbarOverflowMenu items={[actionItem('a')]} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('<ToolbarOverflowMenu> — branch coverage (#2459)', () => {
  it('closes again when the trigger is clicked a second time', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('points aria-controls at the menu only while it is open', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    expect(trigger).not.toHaveAttribute('aria-controls');

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(menu.id).not.toBe('');
  });

  it('merges a caller className onto the wrapper (responsive visibility hook)', () => {
    const { container } = render(
      <ToolbarOverflowMenu items={[actionItem('a')]} className="md:hidden" />,
    );
    expect(container.firstElementChild).toHaveClass('md:hidden');
    expect(container.firstElementChild).toHaveClass('relative');
  });

  it('omits the caller className when none is passed', () => {
    const { container } = render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    expect(container.firstElementChild).toHaveClass('relative');
    expect(container.firstElementChild?.className).not.toMatch(/undefined|null/);
  });

  it('anchors the popover to the right edge by default', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('right-0');
    expect(menu).not.toHaveClass('left-0');
  });

  it('anchors the popover to the left edge when align="left"', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} align="left" />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('left-0');
    expect(menu).not.toHaveClass('right-0');
  });

  it('renders a decorative icon on an action item when one is supplied', () => {
    render(
      <ToolbarOverflowMenu
        items={[{ kind: 'action', id: 'a', label: 'Export', onSelect: vi.fn(), icon: '↓' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitem', { name: 'Export' });
    expect(within(item).getByText('↓')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders no icon slot on an action item without an icon', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitem', { name: 'Action a' });
    expect(item.querySelectorAll('span')).toHaveLength(1);
  });

  it('renders a decorative icon on a checkbox item when one is supplied', () => {
    render(
      <ToolbarOverflowMenu
        items={[
          {
            kind: 'checkbox',
            id: 'b',
            label: 'Show WIP',
            checked: false,
            onChange: vi.fn(),
            icon: '◧',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitemcheckbox', { name: /Show WIP/ });
    expect(within(item).getByText('◧')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the check glyph only for a checked checkbox item', () => {
    render(
      <ToolbarOverflowMenu items={[checkboxItem('on', true), checkboxItem('off', false)]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const checked = screen.getByRole('menuitemcheckbox', { name: /Toggle on/ });
    const unchecked = screen.getByRole('menuitemcheckbox', { name: /Toggle off/ });
    expect(checked.querySelector('svg')).not.toBeNull();
    expect(unchecked.querySelector('svg')).toBeNull();
  });

  it('reports the inverse of the current state when a checked item is toggled off', () => {
    const onChange = vi.fn<(next: boolean) => void>();
    render(<ToolbarOverflowMenu items={[checkboxItem('b', true, onChange)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Toggle b/ }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('ignores activation of a disabled checkbox item', () => {
    const onChange = vi.fn<(next: boolean) => void>();
    render(
      <ToolbarOverflowMenu
        items={[
          { kind: 'checkbox', id: 'b', label: 'Toggle b', checked: false, onChange, disabled: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const item = screen.getByRole('menuitemcheckbox', { name: /Toggle b/ });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps exactly one item in the tab order as the active index moves', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const tabIndexes = () =>
      screen.getAllByRole('menuitem').map((el) => el.getAttribute('tabindex'));
    expect(tabIndexes()).toEqual(['0', '-1', '-1']);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(tabIndexes()).toEqual(['-1', '-1', '0']);
  });

  it('opens with ArrowUp on the trigger and focuses the last item', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    act(() => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    });
    expect(screen.getByRole('menuitem', { name: 'Action c' })).toHaveFocus();
  });

  it('opens with Enter and with Space on the trigger', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: ' ' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('leaves the menu closed for an unrelated key on the trigger', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    fireEvent.keyDown(trigger, { key: 'a' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays open on an unrelated key inside the menu', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a'), actionItem('b')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'x' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toHaveFocus();
  });

  it('closes on Tab without pulling focus back to the trigger', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it('opens an empty menu and survives arrow keys with no items', () => {
    render(<ToolbarOverflowMenu items={[]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    act(() => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    });
    const menu = screen.getByRole('menu');
    expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0);

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps the menu open when the pointer goes down inside it', () => {
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Action a' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps the menu open when the pointer goes down on the trigger itself', () => {
    // The trigger's own click handler owns the toggle; the outside-click
    // listener must not pre-close it or the toggle would double-fire.
    render(<ToolbarOverflowMenu items={[actionItem('a')]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('stops listening for outside pointerdown once closed', () => {
    render(
      <div>
        <button type="button">outside</button>
        <ToolbarOverflowMenu items={[actionItem('a')]} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // A pointerdown after close must be inert — no listener left behind.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('reopens at the first item after being navigated and closed', () => {
    render(
      <ToolbarOverflowMenu items={[actionItem('a'), actionItem('b'), actionItem('c')]} />,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Action c' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Action a' })).toHaveFocus();
  });

  it('activates a checkbox and then an action from the same open menu', () => {
    const onChange = vi.fn<(next: boolean) => void>();
    const onSelect = vi.fn<() => void>();
    render(
      <ToolbarOverflowMenu
        items={[checkboxItem('b', false, onChange), actionItem('a', onSelect)]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More options' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Toggle b/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action a' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
