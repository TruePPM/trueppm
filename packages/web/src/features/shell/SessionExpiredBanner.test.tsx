/**
 * Tests for SessionExpiredBanner / SessionExpiredReadOnlyBar (#352, #1922).
 *
 * Verifies:
 *   - the modal is hidden while `sessionExpired === false`;
 *   - the modal is shown when `sessionExpired` flips true, with the
 *     explanatory copy and a focused Sign in button;
 *   - clicking Sign in clears tokens and navigates to /login;
 *   - the modal traps focus (Tab cannot escape behind the scrim);
 *   - clicking "Continue viewing (read-only)" releases the trap, hides the
 *     modal, shows the persistent read-only banner, and moves focus to its
 *     Sign in again action (#1922);
 *   - re-asserting the session (as the mutation-error path does) re-opens
 *     the blocking modal instead of leaving the read-only banner up.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SessionExpiredBanner, SessionExpiredReadOnlyBar } from './SessionExpiredBanner';
import { useAuthStore } from '@/stores/authStore';

function renderWithLoginRoute() {
  return render(
    <MemoryRouter initialEntries={['/projects']}>
      <SessionExpiredBanner />
      <SessionExpiredReadOnlyBar />
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
      sessionExpiredReadOnly: false,
    });
  });

  it('renders nothing while sessionExpired is false', () => {
    renderWithLoginRoute();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the dialog with focused Sign in action when sessionExpired flips true', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    const dialog = screen.getByRole('dialog', { name: /Your session expired/ });
    expect(dialog).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toHaveFocus();
  });

  it('clicking Sign in clears tokens and navigates to /login', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  });

  it('traps focus inside the re-auth gate — Tab cannot escape behind the scrim', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    const continueViewing = screen.getByRole('button', { name: /Continue viewing/ });
    expect(signIn).toHaveFocus();
    // Shift+Tab from the first focusable wraps to the last focusable inside
    // the trap (fireEvent returns false when the event is defaultPrevented),
    // proving Tab/Shift+Tab never escapes into the stale UI behind the scrim.
    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(continueViewing).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(signIn).toHaveFocus();
  });

  it('Escape does not dismiss the blocking modal', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
  });

  it('"Continue viewing (read-only)" releases the trap and shows the persistent banner (#1922)', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue viewing/ }));

    // Session is still expired (the user did not re-authenticate) but the
    // blocking modal is gone in favor of the non-modal persistent banner.
    expect(useAuthStore.getState().sessionExpired).toBe(true);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const persistentBanner = screen.getByRole('status');
    expect(persistentBanner).toHaveTextContent(/viewing cached content read-only/);
    // The cached screen behind the (now-gone) modal is still on the page —
    // this is the actual escape-hatch guarantee: reachable cached content.
    expect(screen.getByTestId('projects-screen')).toBeInTheDocument();

    // Focus moves to the persistent banner's Sign in again action (WCAG 2.4.3).
    const signInAgain = screen.getByRole('button', { name: /Sign in again/ });
    expect(signInAgain).toHaveFocus();
  });

  it('clicking Sign in again on the persistent banner clears tokens and navigates to /login', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }));
    expect(useAuthStore.getState().sessionExpired).toBe(false);
    expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  });

  it('re-asserting the session (blocked-write path) re-opens the blocking modal and re-focuses it', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Simulate what the query client's global mutation onError does when a
    // write is attempted while in read-only mode (see lib/queryClient.ts).
    act(() => {
      useAuthStore.getState().reassertSessionExpired();
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus();
  });

  it('a fresh session expiry always starts blocking, even if a prior expiry was acknowledged', () => {
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      useAuthStore.getState().clearTokens();
      useAuthStore.getState().markSessionExpired();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
