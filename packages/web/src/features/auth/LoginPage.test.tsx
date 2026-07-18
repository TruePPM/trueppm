import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { renderWithRouter } from '@/test/utils';
import { useAuthStore } from '@/stores/authStore';
import { queryClient } from '@/lib/queryClient';
import type { CurrentUser } from '@/hooks/useCurrentUser';
import { LoginPage, loginRedirectDest } from './LoginPage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// Stub useNavigate so the success-path tests can assert the post-login
// destination without depending on the MemoryRouter actually swapping routes
// (renderWithRouter's single catch-all "*" route renders the same element
// regardless of where navigate() sends it).
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

function makeCurrentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-1',
    username: 'anna@example.com',
    display_name: 'Anna Khoury',
    initials: 'AK',
    email: 'anna@example.com',
    max_project_role: 300,
    workspace_role: 100,
    can_access_admin_settings: false,
    default_landing: 'auto',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'role_policy' },
    hidden_views: [],
    role_context: 'unified',
    schedule_in_deliver: false,
    dnd_enabled: false,
    timezone: 'auto',
    date_format: 'auto',
    ...overrides,
  };
}

// LoginPage makes two kinds of GET via bare axios: a mount-time SSO discovery
// (`/auth/oidc/discover/`) and, during sign-in, the `me` fetch. Route by URL so
// the mount discovery never steals a `mockResolvedValueOnce` meant for `me`.
let ssoProviders: { slug: string; display_name: string }[] = [];
let meHandler: () => Promise<{ data: CurrentUser }> = () =>
  Promise.reject(new Error('no me handler set'));

// useNavigate and useSearchParams come from the MemoryRouter in renderWithRouter.
describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    ssoProviders = [];
    meHandler = () => Promise.reject(new Error('no me handler set'));
    mockedAxios.get.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/auth/oidc/discover/')) {
        return Promise.resolve({
          data: { provider_present: ssoProviders.length > 0, providers: ssoProviders },
        });
      }
      if (typeof url === 'string' && url.includes('/auth/me/')) {
        return meHandler();
      }
      return Promise.reject(new Error(`unmocked GET ${String(url)}`));
    });
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      sessionExpired: false,
      _hasHydrated: true,
    });
    queryClient.clear();
  });

  it('renders the brand, email field, password field, and sign-in button', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // Two-color wordmark splits "True"/"PPM" across spans; assert accessible name.
    expect(screen.getByLabelText('TruePPM')).toBeInTheDocument();
    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the remember-me checkbox', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(screen.getByLabelText('Keep me signed in for 30 days')).toBeInTheDocument();
  });

  it('sign-in button is disabled when both fields are empty', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('sign-in button is disabled when only email is filled', async () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('sign-in button is enabled when both email and password are filled', async () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows error message on 401 response', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), {
        isAxiosError: true,
        response: { status: 401 },
      }),
    );
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
    });
  });

  it('shows generic error on unexpected failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'any');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('unexpected error');
    });
  });

  it('completes sign-in: stores the token, seeds the me cache, and navigates to the resolved landing', async () => {
    const currentUser = makeCurrentUser({
      landing: { intent: 'project_overview', path: '/projects/abc/overview', resolved_by: 'role_policy' },
    });
    mockedAxios.post.mockResolvedValueOnce({ data: { access: 'minted-token' } });
    meHandler = () => Promise.resolve({ data: currentUser });

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/projects/abc/overview', { replace: true });
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- mockedAxios.post is a vi.mocked mock, not a bound method
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/v1/auth/token/', {
      username: 'anna@example.com',
      password: 'correct-horse',
      remember_me: false,
    });
    expect(useAuthStore.getState().accessToken).toBe('minted-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(queryClient.getQueryData(['current-user'])).toEqual(currentUser);
  });

  it('completes sign-in and falls back to the root path when the me fetch fails', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { access: 'minted-token' } });
    meHandler = () => Promise.reject(new Error('me fetch failed'));

    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email'), 'anna@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Sign-in still completes — a failed `me` fetch must not block login. There
    // is no landing path to defer to, so navigation falls through to `/`
    // (RootRedirect resolves the real landing once `me` lands in the cache).
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });

    expect(useAuthStore.getState().accessToken).toBe('minted-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(queryClient.getQueryData(['current-user'])).toBeUndefined();
  });

  it('renders one sign-in button per enabled provider, discovered on mount', async () => {
    ssoProviders = [
      { slug: 'keycloak', display_name: 'Keycloak' },
      { slug: 'github', display_name: 'GitHub' },
    ];
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    expect(
      await screen.findByRole('button', { name: 'Continue with Keycloak' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
  });

  it('hands off to the provider-scoped RP login endpoint on click', async () => {
    // jsdom's window.location.assign isn't spyable, so replace location for this test.
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    ssoProviders = [{ slug: 'keycloak', display_name: 'Keycloak' }];
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Continue with Keycloak' }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/api/v1/auth/oidc/login?provider=keycloak'),
    );
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('shows no SSO section when no provider is configured (password-only install)', async () => {
    ssoProviders = [];
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // The mount discovery resolves to an empty list, so no provider buttons and
    // no dangling OR divider — just the password form.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mockedAxios.get is a vi.mocked mock, not a bound method
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Continue with/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('links Forgot? to the self-service password reset flow (issue 765)', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // The control is now a real link into the /forgot-password flow, not a
    // "coming soon" tooltip — self-service reset shipped in issue 765.
    const forgot = screen.getByRole('link', { name: 'Forgot password?' });
    expect(forgot).toHaveAttribute('href', '/forgot-password');
  });

  it('directs new users to their admin instead of a dead signup link', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // TruePPM is invite-based; there is no self-service signup, so the footer
    // is honest static copy — not a link to a nonexistent /signup route.
    expect(
      screen.getByText('Need access? Ask your workspace admin to invite you.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /request access/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request access/i })).not.toBeInTheDocument();
  });

  it('remember-me checkbox toggles', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });
    const checkbox = screen.getByLabelText('Keep me signed in for 30 days');

    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it('renders the marketing panel with status pill and mini-Gantt on desktop', () => {
    renderWithRouter(<LoginPage />, { initialEntries: ['/login'] });

    // The "hidden md:flex" panel is in the DOM even on jsdom — just hidden via CSS.
    // We can still assert on its text content.
    expect(screen.getByText('Schedules that hold under pressure.')).toBeInTheDocument();
    expect(screen.getByText(/CPM v.*live/)).toBeInTheDocument();
  });
});

describe('loginRedirectDest — post-login destination transform', () => {
  it('redirects /projects/{id}/board to /projects/{id}/overview', () => {
    expect(loginRedirectDest('/projects/abc-123/board')).toBe('/projects/abc-123/overview');
  });

  it('redirects nested board paths (e.g. /board?view=foo) to overview, dropping board children', () => {
    expect(loginRedirectDest('/projects/abc-123/board/anything')).toBe(
      '/projects/abc-123/overview',
    );
  });

  it('preserves the project id with hyphens and uuids', () => {
    const id = 'e2e-332-00000000-0000-0000-0000-000000000332';
    expect(loginRedirectDest(`/projects/${id}/board`)).toBe(`/projects/${id}/overview`);
  });

  it('passes through non-board project routes untouched (deep-link preservation)', () => {
    expect(loginRedirectDest('/projects/abc-123/risk')).toBe('/projects/abc-123/risk');
    expect(loginRedirectDest('/projects/abc-123/schedule')).toBe('/projects/abc-123/schedule');
    expect(loginRedirectDest('/projects/abc-123/sprints')).toBe('/projects/abc-123/sprints');
    expect(loginRedirectDest('/projects/abc-123/resources/roster')).toBe(
      '/projects/abc-123/resources/roster',
    );
  });

  it('passes through the root path untouched', () => {
    expect(loginRedirectDest('/')).toBe('/');
  });

  it('does not match unrelated paths that contain the substring "board"', () => {
    // "/dashboard" or "/projects/abc/dashboards" must not be rewritten.
    expect(loginRedirectDest('/dashboard')).toBe('/dashboard');
    expect(loginRedirectDest('/projects/abc/dashboards')).toBe('/projects/abc/dashboards');
  });
});

describe('loginRedirectDest — open redirect hardening (#899)', () => {
  it('rejects a protocol-relative URL (//evil.com)', () => {
    expect(loginRedirectDest('//evil.com/')).toBe('/');
    expect(loginRedirectDest('//evil.com/projects/abc/board')).toBe('/');
  });

  it('rejects a backslash-smuggled URL (/\\evil.com)', () => {
    expect(loginRedirectDest('/\\evil.com')).toBe('/');
    expect(loginRedirectDest('/\\/evil.com')).toBe('/');
  });

  it('rejects an absolute off-origin URL', () => {
    expect(loginRedirectDest('https://evil.com')).toBe('/');
    expect(loginRedirectDest('http://evil.com/projects/abc/board')).toBe('/');
  });

  it('rejects a javascript: scheme', () => {
    expect(loginRedirectDest('javascript:alert(1)')).toBe('/');
  });

  it('still applies the board→overview rewrite for safe same-origin paths', () => {
    expect(loginRedirectDest('/projects/abc-123/board')).toBe('/projects/abc-123/overview');
  });

  it('passes a normal same-origin relative path through untouched', () => {
    expect(loginRedirectDest('/projects/x/tasks')).toBe('/projects/x/tasks');
  });
});

describe('loginRedirectDest — defers to the landing path (ADR-0129, #1181)', () => {
  it('returns the guarded landing path when there is no safe next', () => {
    expect(loginRedirectDest('', '/me/work')).toBe('/me/work');
    expect(loginRedirectDest('', '/projects/abc/overview')).toBe('/projects/abc/overview');
  });

  it('falls back to / when no landing path is given (legacy behavior)', () => {
    expect(loginRedirectDest('')).toBe('/');
  });

  it('a safe next deep link still wins over the landing path', () => {
    expect(loginRedirectDest('/projects/abc/risk', '/me/work')).toBe('/projects/abc/risk');
  });

  it('an unsafe next falls through to the guarded landing path, not the open redirect', () => {
    expect(loginRedirectDest('//evil.com', '/me/work')).toBe('/me/work');
    expect(loginRedirectDest('https://evil.com', '/projects/abc/overview')).toBe(
      '/projects/abc/overview',
    );
  });

  it('an off-allowlist landing path degrades to My Work', () => {
    expect(loginRedirectDest('', '/portfolio')).toBe('/me/work');
  });
});
