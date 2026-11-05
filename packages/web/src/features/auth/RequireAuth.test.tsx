import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useAuthStore } from '@/stores/authStore';
import * as client from '@/api/client';
import { RequireAuth, resetSilentDemoAttempt } from './RequireAuth';
import * as demoSession from './demoSession';

// Render RequireAuth as a layout route with a protected child and a /login
// route, so we can assert on whether the Outlet (protected content) renders,
// whether we hold (nothing rendered), or whether we redirect to /login.
function renderGuard(initialEntries: string[] = ['/app']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/app" element={<RequireAuth />}>
            <Route index element={<div>Protected content</div>} />
          </Route>
          <Route path="/login" element={<div>Login page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSilentDemoAttempt();
    // Default: not a demo host, so the silent login declines.
    vi.spyOn(demoSession, 'silentDemoLogin').mockResolvedValue(false);
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      _hasHydrated: true,
    });
  });

  it('renders the protected outlet immediately when a token is already in memory', () => {
    const spy = vi.spyOn(client, 'bootstrapAccessToken');
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'tok' });

    renderGuard();

    expect(screen.getByText('Protected content')).toBeInTheDocument();
    // No bootstrap refresh needed when the token is present.
    expect(spy).not.toHaveBeenCalled();
  });

  it('redirects to /login when not authenticated', async () => {
    renderGuard();
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
  });

  it('renders nothing until the store has rehydrated', () => {
    useAuthStore.setState({ isAuthenticated: true, accessToken: 'tok', _hasHydrated: false });
    renderGuard();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  // #911: authenticated (persisted hint) but no in-memory token → hold rendering
  // and mint a token from the cookie before any child query mounts.
  it('holds rendering and bootstraps a token when authenticated without one', async () => {
    // Keep the refresh pending so the held window is observable; the mock that
    // resolves synchronously would mint the token before the first assertion.
    let resolveBootstrap!: (ok: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolveBootstrap = resolve;
    });
    const spy = vi.spyOn(client, 'bootstrapAccessToken').mockReturnValue(pending);
    useAuthStore.setState({ isAuthenticated: true, accessToken: null });

    renderGuard();

    // Held while the bootstrap refresh is in flight — the protected outlet (and
    // therefore its data queries) must not mount yet.
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    // Token lands → guard renders the protected outlet.
    act(() => {
      useAuthStore.getState().setAccessToken('minted');
      resolveBootstrap(true);
    });
    await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
  });

  it('falls through to the session-expired outlet when the bootstrap refresh fails', async () => {
    vi.spyOn(client, 'bootstrapAccessToken').mockImplementation(() => {
      useAuthStore.getState().markSessionExpired();
      return Promise.resolve(false);
    });
    useAuthStore.setState({ isAuthenticated: true, accessToken: null });

    renderGuard();

    // On failure we hold the current screen (Outlet) so the SessionExpiredBanner
    // can surface (#352) rather than bouncing to /login.
    await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  describe('silent demo re-login (#4500)', () => {
    it('re-logs in on a failed reload bootstrap and never shows the expired outlet first', async () => {
      vi.spyOn(client, 'bootstrapAccessToken').mockImplementation(() => {
        useAuthStore.getState().markSessionExpired();
        return Promise.resolve(false);
      });
      const silent = vi.spyOn(demoSession, 'silentDemoLogin').mockImplementation(() => {
        useAuthStore.getState().setAccessToken('demo');
        return Promise.resolve(true);
      });
      useAuthStore.setState({ isAuthenticated: true, accessToken: null });

      renderGuard();

      await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
      expect(silent).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().sessionExpired).toBe(false);
    });

    it('lets a fresh visitor deep link through when the demo login succeeds', async () => {
      vi.spyOn(demoSession, 'silentDemoLogin').mockImplementation(() => {
        useAuthStore.getState().setAccessToken('demo');
        return Promise.resolve(true);
      });
      renderGuard();
      await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
    });

    it('falls back to the login redirect once when the silent login declines', async () => {
      const silent = vi.spyOn(demoSession, 'silentDemoLogin').mockResolvedValue(false);
      renderGuard();
      await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
      expect(silent).toHaveBeenCalledTimes(1);
    });

    it('does not re-log in after an explicit sign-out', async () => {
      const silent = vi.spyOn(demoSession, 'silentDemoLogin');
      useAuthStore.setState({ signedOut: true });
      renderGuard();
      await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
      expect(silent).not.toHaveBeenCalled();
    });

    it('leaves the bare origin alone so the demo front door keeps its button', async () => {
      const silent = vi.spyOn(demoSession, 'silentDemoLogin');
      const queryClient = new QueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<RequireAuth />}>
                <Route index element={<div>Protected content</div>} />
              </Route>
              <Route path="/login" element={<div>Login page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
      expect(silent).not.toHaveBeenCalled();
    });

    it('does not blank the shell for a mid-app expiry after the page load settled', () => {
      const silent = vi.spyOn(demoSession, 'silentDemoLogin');
      useAuthStore.setState({ isAuthenticated: true, accessToken: 'tok' });
      renderGuard();
      expect(screen.getByText('Protected content')).toBeInTheDocument();
      act(() => useAuthStore.getState().markSessionExpired());
      expect(screen.getByText('Protected content')).toBeInTheDocument();
      expect(silent).not.toHaveBeenCalled();
    });
  });
});
