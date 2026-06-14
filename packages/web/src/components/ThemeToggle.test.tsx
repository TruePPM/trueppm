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
});
