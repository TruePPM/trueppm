import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BuildModeRowMenu, type RowMenuItem } from './BuildModeRowMenu';

function makeItems(overrides: Partial<RowMenuItem>[] = []): RowMenuItem[] {
  const defaults: RowMenuItem[] = [
    { key: 'edit', label: 'Edit', icon: '✎', hint: 'F2', onSelect: vi.fn() },
    { key: 'indent', label: 'Indent', icon: '⇥', hint: 'Tab', startsGroup: true, onSelect: vi.fn() },
    { key: 'outdent', label: 'Outdent', icon: '⇤', hint: '⇧+Tab', onSelect: vi.fn() },
    { key: 'delete', label: 'Delete', icon: '🗑', hint: '⌫', destructive: true, startsGroup: true, onSelect: vi.fn() },
  ];
  return defaults.map((item, i) => ({ ...item, ...(overrides[i] ?? {}) }));
}

const ANCHOR = { x: 100, y: 100 };

beforeEach(() => {
  // jsdom — no real viewport size; default to a comfortable window.
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
});

describe('BuildModeRowMenu — visibility', () => {
  it('renders nothing when anchor is null', () => {
    const { container } = render(
      <BuildModeRowMenu anchor={null} items={makeItems()} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders all items when anchor is set', () => {
    render(<BuildModeRowMenu anchor={ANCHOR} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Indent')).toBeInTheDocument();
    expect(screen.getByText('Outdent')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('renders separators for items with startsGroup', () => {
    render(<BuildModeRowMenu anchor={ANCHOR} items={makeItems()} onClose={vi.fn()} />);
    // Menu renders into document.body via portal — query from body.
    const separators = document.body.querySelectorAll('[aria-hidden="true"].border-t');
    expect(separators.length).toBe(2); // Indent and Delete both start groups
  });
});

describe('BuildModeRowMenu — activation', () => {
  it('calls item onSelect on click', () => {
    const onIndent = vi.fn();
    const onClose = vi.fn();
    const items = makeItems([{}, { onSelect: onIndent }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByText('Indent'));
    expect(onIndent).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not activate disabled items on click', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items = makeItems([{ disabled: true, onSelect }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter activates the focused item', () => {
    const onEdit = vi.fn();
    const items = makeItems([{ onSelect: onEdit }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledOnce();
  });
});

describe('BuildModeRowMenu — keyboard navigation', () => {
  it('ArrowDown moves to the next enabled item', () => {
    const onIndent = vi.fn();
    const items = makeItems([{}, { onSelect: onIndent }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onIndent).toHaveBeenCalledOnce();
  });

  it('ArrowDown skips disabled items', () => {
    const onOutdent = vi.fn();
    const items = makeItems([{}, { disabled: true }, { onSelect: onOutdent }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onOutdent).toHaveBeenCalledOnce();
  });

  it('ArrowUp wraps to the last item from the first', () => {
    const onDelete = vi.fn();
    const items = makeItems([{}, {}, {}, { onSelect: onDelete }]);
    render(<BuildModeRowMenu anchor={ANCHOR} items={items} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe('BuildModeRowMenu — dismissal', () => {
  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<BuildModeRowMenu anchor={ANCHOR} items={makeItems()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('click outside the menu calls onClose', () => {
    const onClose = vi.fn();
    render(<BuildModeRowMenu anchor={ANCHOR} items={makeItems()} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('scroll calls onClose', () => {
    const onClose = vi.fn();
    render(<BuildModeRowMenu anchor={ANCHOR} items={makeItems()} onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('BuildModeRowMenu — viewport overflow', () => {
  it('flips upward when menu would overflow bottom edge', () => {
    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
    render(
      <BuildModeRowMenu
        anchor={{ x: 50, y: 180 }}
        items={makeItems()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole('menu');
    // anchor.y (180) + menuHeight (4 items × 32 + 8 = 136) = 316 > 200, so flip up.
    // The menu top is set to max(0, 180 - 136) = 44.
    expect(menu.style.top).toBe('44px');
  });

  it('flips left when menu would overflow right edge', () => {
    Object.defineProperty(window, 'innerWidth', { value: 250, configurable: true });
    render(
      <BuildModeRowMenu
        anchor={{ x: 200, y: 100 }}
        items={makeItems()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole('menu');
    // anchor.x (200) + MENU_WIDTH (200) = 400 > 250, so flip left.
    // The menu left is set to max(0, 200 - 200) = 0.
    expect(menu.style.left).toBe('0px');
  });
});
