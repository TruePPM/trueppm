/**
 * Tests for SessionExpiredBanner (#352).
 *
 * Verifies:
 *   - banner is hidden when `sessionExpired === false`;
 *   - banner is shown when `sessionExpired === true`, with the explanatory
 *     copy and a focused Sign in button;
 *   - clicking Sign in clears tokens and navigates to /login.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SessionExpiredBanner } from './SessionExpiredBanner';
import { useAuthStore } from '@/stores/authStore';

function renderWithLoginRoute() {
  return render(
    <MemoryRouter initialEntries={['/projects']}>
      <SessionExpiredBanner />
      <Routes>
        <Route path="/projects" element={<div data-testid="projects-screen" />} />
        <Route path="/login" element={<div data-testid="login-screen" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SessionExpiredBanner', () => {
  beforeEach(() => {
    // Reset the persisted auth store between tests.
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
    });
  });

  it('renders nothing while sessionExpired is false', () => {
    renderWithLoginRoute();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the dialog with focused Sign in action when sessionExpired flips true', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    const dialog = screen.getByRole('dialog', { name: /Your session expired/ });
    expect(dialog).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Sign in/ });
    expect(button).toHaveFocus();
  });

  it('clicking Sign in clears tokens and navigates to /login', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  });
});
