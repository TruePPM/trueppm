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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { SessionExpiredBanner, SessionExpiredReadOnlyBar } from './SessionExpiredBanner';
import { READ_ONLY_VIEW_WINDOW_MS, registerSessionBridge, useAuthStore } from '@/stores/authStore';

// Exposes the login route's full path + search so tests can assert the ?next=
// param the re-auth handlers carry (#2052).
function LoginScreen() {
  const location = useLocation();
  return <div data-testid="login-screen" data-loc={location.pathname + location.search} />;
}

function renderWithLoginRoute(entry = '/projects') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionExpiredBanner />
      <SessionExpiredReadOnlyBar />
      <Routes>
        <Route path="/projects" element={<div data-testid="projects-screen" />} />
        <Route path="/projects/:id/schedule" element={<div data-testid="schedule-screen" />} />
        <Route path="/login" element={<LoginScreen />} />
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
      sessionExpiredCanView: true,
      sessionExpiredInterrupted: false,
      focusReadOnlyBar: false,
      sessionEndedAt: null,
    });
  });

  afterEach(() => {
    registerSessionBridge(null);
    vi.useRealTimers();
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
    const dialog = screen.getByRole('dialog', { name: /You've been signed out/ });
    expect(dialog).toBeInTheDocument();
    // Body wording is deliberately distinct from the title ("session was ended" vs.
    // "signed out") so the dialog doesn't repeat itself (#4256) — and distinct from
    // the retired cause-naming copy ("your session expired"), which would not match
    // this pattern either.
    expect(dialog).toHaveTextContent(/your session was ended/i);
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

  it('Sign in carries the current location as ?next= so re-auth returns the user (#2052)', () => {
    renderWithLoginRoute('/projects/p1/schedule?task=t9');
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByTestId('login-screen')).toHaveAttribute(
      'data-loc',
      `/login?next=${encodeURIComponent('/projects/p1/schedule?task=t9')}`,
    );
  });

  it('read-only banner "Sign in again" also carries ?next= (#2052)', () => {
    renderWithLoginRoute('/projects/p1/schedule?task=t9');
    act(() => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
    });
    fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }));
    expect(screen.getByTestId('login-screen')).toHaveAttribute(
      'data-loc',
      `/login?next=${encodeURIComponent('/projects/p1/schedule?task=t9')}`,
    );
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
    // Lead sentence is cause-agnostic too (#4256) — this is a genuine negative
    // control: the retired "Your session expired." wording would fail this
    // assertion while still passing the "viewing cached content" one below.
    expect(persistentBanner).toHaveTextContent(/you've been signed out/i);
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
    vi.useFakeTimers();
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Simulate what the query client's global mutation onError does when a
    // write is attempted while in read-only mode (see lib/queryClient.ts).
    act(() => {
      // The first refused write is only a cue (#4316); a later repeat re-opens the modal.
      useAuthStore.getState().reassertSessionExpired();
      vi.runAllTimers();
      useAuthStore.getState().reassertSessionExpired();
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus();
  });

  it('a fresh expiry re-reads the data layer instead of inheriting a prior read-only acknowledgment', () => {
    // Production registers a bridge (lib/queryClient); the surface follows what it sees.
    let ctx = { interrupted: false, hasContent: true };
    registerSessionBridge({ inspect: () => ctx, clearCache: () => {} });
    renderWithLoginRoute();
    act(() => {
      useAuthStore.getState().markSessionExpired();
    });
    // Nothing in flight: the quiet bar, no modal.
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      useAuthStore.getState().clearTokens();
      ctx = { interrupted: true, hasContent: true };
      useAuthStore.getState().markSessionExpired();
    });
    // The second session ended mid-write: blocking again, not the bar from last time.
    expect(screen.getByRole('dialog')).toHaveTextContent('Your last change did not go through.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  describe('bound to mutation state (#4316)', () => {
    it('neutral body when no write was interrupted; interrupted body names the lost change', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: true, hasContent: true }),
        clearCache: () => {},
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      expect(screen.getByRole('dialog')).toHaveTextContent('Your last change did not go through.');
      // Cause-agnostic (#4256): never asserts why the session ended.
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/expired/i);

      act(() => {
        useAuthStore.setState({ sessionExpiredInterrupted: false });
      });
      expect(screen.getByRole('dialog')).not.toHaveTextContent('last change');
      expect(screen.getByRole('dialog')).toHaveTextContent(/keep viewing the read-only content/);
    });

    it('skips the modal and shows the quiet banner when nothing was in flight', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache: () => {},
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/viewing cached content read-only/);
      // The banner appeared on its own: it must not steal focus from the user's field.
      expect(screen.getByRole('button', { name: /Sign in again/ })).not.toHaveFocus();
    });
  });

  describe('cold load and the view window (#4313)', () => {
    it('offers only Sign in when nothing had loaded before the session ended', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: false }),
        clearCache: () => {},
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Continue viewing/ })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog')).not.toHaveTextContent(/keep viewing/);
    });

    it('clears the cache and returns to a sign-in-only modal when the window lapses', () => {
      vi.useFakeTimers();
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache,
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      expect(screen.getByRole('status')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(READ_ONLY_VIEW_WINDOW_MS - 1000);
      });
      expect(clearCache).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(clearCache).toHaveBeenCalledOnce();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Continue viewing/ })).not.toBeInTheDocument();
    });

    // The window runs from when the session ENDED. None of these may extend it.
    it('runs behind the modal too: a write in flight at expiry does not leave the cache up', () => {
      vi.useFakeTimers();
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: true, hasContent: true }),
        clearCache,
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(READ_ONLY_VIEW_WINDOW_MS);
      });
      expect(clearCache).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: /Continue viewing/ })).not.toBeInTheDocument();
    });

    it('"Continue viewing" late in the window does not start a fresh one', () => {
      vi.useFakeTimers();
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: true, hasContent: true }),
        clearCache,
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      act(() => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      fireEvent.click(screen.getByRole('button', { name: /Continue viewing/ }));
      expect(screen.getByRole('status')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(clearCache).toHaveBeenCalledOnce();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it("two stray writes and a sibling tab's read-only choice do not extend the window", () => {
      vi.useFakeTimers();
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache,
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        // Two refused writes, in separate actions: the second re-opens the modal.
        useAuthStore.getState().reassertSessionExpired();
        vi.advanceTimersByTime(1);
        useAuthStore.getState().reassertSessionExpired();
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        // A sibling tab chose "Continue viewing".
        useAuthStore.getState().enterReadOnlyMode({ broadcast: false });
      });
      expect(clearCache).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(clearCache).toHaveBeenCalledOnce();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Continue viewing/ })).not.toBeInTheDocument();
    });

    it('also checks on return to the tab, since a backgrounded tab throttles its timers', () => {
      vi.useFakeTimers();
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache,
      });
      renderWithLoginRoute();
      act(() => {
        useAuthStore.getState().markSessionExpired();
      });
      // Jump the clock without running timers, as a suspended tab effectively does.
      vi.setSystemTime(Date.now() + READ_ONLY_VIEW_WINDOW_MS + 1);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(clearCache).toHaveBeenCalledOnce();
    });
  });
});
