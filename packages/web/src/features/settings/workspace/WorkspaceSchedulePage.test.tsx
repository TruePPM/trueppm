import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceSchedulePage } from './WorkspaceSchedulePage';
import { isFeatureFlagEnabled } from '@/lib/featureFlags';

const FLAG = 'schedule_build_mode_v1';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('WorkspaceSchedulePage — Build mode toggle', () => {
  it('renders the Schedule section with a beta-tagged Build mode toggle', () => {
    render(<WorkspaceSchedulePage />);
    expect(screen.getByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Build mode (beta)' })).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('reflects the current flag state — off by default', () => {
    render(<WorkspaceSchedulePage />);
    const toggle = screen.getByRole('switch', { name: 'Build mode (beta)' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // The cheatsheet link only appears once the flag is on (avoids the
    // chicken-and-egg of previewing shortcuts for a disabled surface).
    expect(screen.queryByRole('button', { name: 'View keyboard shortcuts' })).toBeNull();
  });

  it('reflects an already-enabled flag on mount', () => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ [FLAG]: true }));
    render(<WorkspaceSchedulePage />);
    const toggle = screen.getByRole('switch', { name: 'Build mode (beta)' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('button', { name: 'View keyboard shortcuts' }),
    ).toBeInTheDocument();
  });

  it('flipping the toggle on persists the flag and reveals the cheatsheet link', () => {
    render(<WorkspaceSchedulePage />);
    const toggle = screen.getByRole('switch', { name: 'Build mode (beta)' });

    fireEvent.click(toggle);

    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('button', { name: 'View keyboard shortcuts' }),
    ).toBeInTheDocument();
  });

  it('flipping the toggle off clears the flag', () => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ [FLAG]: true }));
    render(<WorkspaceSchedulePage />);
    const toggle = screen.getByRole('switch', { name: 'Build mode (beta)' });

    fireEvent.click(toggle);

    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('opens the keyboard cheatsheet when the link is clicked (flag on)', () => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ [FLAG]: true }));
    render(<WorkspaceSchedulePage />);

    expect(screen.queryByRole('dialog', { name: 'Schedule shortcuts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View keyboard shortcuts' }));
    expect(
      screen.getByRole('dialog', { name: 'Schedule shortcuts' }),
    ).toBeInTheDocument();
  });
});
