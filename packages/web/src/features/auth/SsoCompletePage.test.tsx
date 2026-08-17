import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SsoCompletePage } from './SsoCompletePage';

/** AuthShell renders a real <Link>, which needs a Router context. */
function renderPage() {
  return render(
    <MemoryRouter>
      <SsoCompletePage />
    </MemoryRouter>,
  );
}

// Control the ?error param per test and capture navigation.
let searchString = '';
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams(searchString), vi.fn()],
  };
});

const mockBootstrap = vi.fn<() => Promise<boolean>>();
vi.mock('@/api/client', () => ({
  bootstrapAccessToken: () => mockBootstrap(),
}));
vi.mock('@/lib/queryClient', () => ({ queryClient: { clear: vi.fn() } }));

describe('SsoCompletePage', () => {
  beforeEach(() => {
    searchString = '';
    mockNavigate.mockClear();
    mockBootstrap.mockReset();
  });

  it('mints the session and enters the app on the success path', async () => {
    mockBootstrap.mockResolvedValue(true);
    renderPage();

    expect(screen.getByText('Identity verified')).toBeInTheDocument();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('renders the not-a-member state with the SSO_NO_MEMBER code', () => {
    searchString = 'error=sso_no_member';
    renderPage();

    expect(screen.getByText(/not a member yet/i)).toBeInTheDocument();
    expect(screen.getByTestId('sso-error-code')).toHaveTextContent('SSO_NO_MEMBER');
    // Success path must not run when an error is present.
    expect(mockBootstrap).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders the canceled state for access_denied', () => {
    searchString = 'error=access_denied';
    renderPage();
    expect(screen.getByText('Sign-in was canceled')).toBeInTheDocument();
    expect(screen.getByTestId('sso-error-code')).toHaveTextContent('SSO_ACCESS_DENIED');
  });

  it('falls back to a generic error for an unrecognized code (never echoes the raw code)', () => {
    searchString = 'error=weird_backend_code';
    renderPage();
    expect(screen.getByText(/couldn't complete sign-in/i)).toBeInTheDocument();
    expect(screen.getByTestId('sso-error-code')).toHaveTextContent('SSO_WEIRD_BACKEND_CODE');
  });

  it('distinguishes a deactivated account from a non-member (#2875)', () => {
    // sso_no_member's "ask an admin to invite you" is the wrong remedy here — the
    // account already exists and is a member; it was switched off.
    searchString = 'error=sso_account_disabled';
    renderPage();
    expect(screen.getByText('Your account is deactivated')).toBeInTheDocument();
    expect(screen.getByText(/ask a workspace admin to reactivate it/i)).toBeInTheDocument();
    expect(screen.getByTestId('sso-error-code')).toHaveTextContent('SSO_ACCOUNT_DISABLED');
  });

  it.each([
    ['email_unverified', 'SSO_EMAIL_UNVERIFIED', /email address is not verified/i],
    ['provider_unreachable', 'SSO_PROVIDER_UNREACHABLE', /couldn't reach your identity provider/i],
    ['invalid_id_token', 'SSO_INVALID_ID_TOKEN', /couldn't verify your identity provider/i],
    ['token_exchange_failed', 'SSO_TOKEN_EXCHANGE_FAILED', /declined the sign-in/i],
  ])('maps the backend %s code to its own copy (#2876)', (code, uiCode, titlePattern) => {
    // All four previously fell through to the generic "Something went wrong".
    searchString = `error=${code}`;
    renderPage();
    expect(screen.getByText(titlePattern)).toBeInTheDocument();
    expect(screen.getByTestId('sso-error-code')).toHaveTextContent(uiCode);
  });

  it('never tells a user to "try again" when the outcome is a policy refusal', () => {
    // email_unverified is a policy decision at the IdP; retrying cannot change it.
    searchString = 'error=email_unverified';
    renderPage();
    expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
  });

  it('shows an error when the session bootstrap fails on the success path', async () => {
    mockBootstrap.mockResolvedValue(false);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/couldn't complete sign-in/i)).toBeInTheDocument(),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
