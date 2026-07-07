import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { useThemeStore } from '@/stores/themeStore';
import { ThemeToggle } from './ThemeToggle';

beforeEach(() => {
  useThemeStore.setState({ theme: 'auto' });
});

describe('ThemeToggle', () => {
  it('renders the three scheme options as a labeled group', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('group', { name: 'Color scheme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto (system) mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark mode' })).toBeInTheDocument();
  });

  it('marks the active theme with aria-pressed', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Auto (system) mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('writes the chosen theme to the store', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark mode' }));
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('uses compact 28px targets on desktop (default)', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: 'Light mode' });
    expect(btn.className).toContain('h-7');
    expect(btn.className).toContain('w-7');
    expect(btn.className).not.toContain('min-h-[44px]');
  });

  it('uses 44px touch targets when isMobile (rule 5, #1681)', () => {
    render(<ThemeToggle isMobile />);
    // Every option must clear the 44px touch-target floor on the mobile sheet.
    for (const name of ['Light mode', 'Auto (system) mode', 'Dark mode']) {
      const btn = screen.getByRole('button', { name });
      expect(btn.className).toContain('min-h-[44px]');
      expect(btn.className).toContain('min-w-[44px]');
      expect(btn.className).not.toContain('h-7');
    }
  });
});
