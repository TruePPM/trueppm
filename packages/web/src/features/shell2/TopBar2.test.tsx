import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { TopBar2 } from './TopBar2';

let mockBreakpoint = 'sm';
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => mockBreakpoint }));
vi.mock('@/features/shell/useLocationModel', () => ({
  useLocationModel: () => ({ suppressed: false, leaf: 'My Work', program: null, project: null }),
}));
vi.mock('./StatusSlot', () => ({ StatusSlot: () => null }));
vi.mock('@/features/shell/CreateMenu', () => ({ CreateMenu: () => null }));
vi.mock('@/features/shell/UserMenu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));

afterEach(() => {
  useCommandPaletteStore.getState().setOpen(false);
  mockBreakpoint = 'sm';
});

describe('TopBar2 phone quick-find (#1592)', () => {
  it('shows a Search icon button on a phone that opens the palette by tap', () => {
    render(<TopBar2 />);
    const btn = screen.getByRole('button', { name: 'Search projects and tasks' });
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    // 44px target, and hidden from md up where the labelled ⌘K trigger takes over.
    expect(btn.className).toContain('h-11');
    expect(btn.className).toContain('w-11');
    expect(btn.className).toContain('md:hidden');
    expect(useCommandPaletteStore.getState().open).toBe(false);
    fireEvent.click(btn);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('keeps the desktop trigger alongside it, opening the same palette', () => {
    mockBreakpoint = 'lg';
    render(<TopBar2 />);
    fireEvent.click(screen.getByRole('button', { name: /Search or run a command/ }));
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
