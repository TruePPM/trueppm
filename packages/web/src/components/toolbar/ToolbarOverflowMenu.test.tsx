import { render, screen, fireEvent, act } from '@testing-library/react';
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
