import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import { AuthShell } from './AuthShell';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ForgotPasswordSentPage } from './ForgotPasswordSentPage';
import { ResetPasswordConfirmPage } from './ResetPasswordConfirmPage';
import { ResetPasswordDonePage } from './ResetPasswordDonePage';
import { ResetPasswordExpiredPage } from './ResetPasswordExpiredPage';
import { confirmPasswordReset, requestPasswordReset } from './resetApi';

// Keep the pure helpers (redactEmail, isRateLimited, classifyConfirmError) real —
// they have their own unit tests — and stub only the two network calls.
vi.mock('./resetApi', async (importActual) => {
  const actual = await importActual<typeof import('./resetApi')>();
  return {
    ...actual,
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
  };
});

const mockRequest = vi.mocked(requestPasswordReset);
const mockConfirm = vi.mocked(confirmPasswordReset);

/** A password that satisfies the client-side requirements (≥10 chars + a digit). */
const STRONG_PASSWORD = 'Str0ngPass99';

afterEach(() => {
  vi.clearAllMocks();
});

/** Render an element inside a router with named landing routes to assert navigation. */
function renderAt(path: string, routes: Array<{ path: string; element: ReactNode }>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthShell', () => {
  it('renders the brand, title, subtitle and back-to-sign-in link', () => {
    renderAt('/', [
      {
        path: '/',
        element: (
          <AuthShell title="Reset your password" subtitle="Do the thing">
            <p>body</p>
          </AuthShell>
        ),
      },
    ]);
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows the progress dots when a step is given and hides the footer link when disabled', () => {
    renderAt('/', [
      { path: '/', element: <AuthShell step={2} title="Step two" backToSignIn={false} /> },
    ]);
    expect(screen.getByRole('img', { name: 'Step 2 of 3' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to sign in' })).not.toBeInTheDocument();
  });
});

describe('ForgotPasswordPage', () => {
  it('sends the reset link and advances to the sent screen on success', async () => {
    const user = userEvent.setup();
    mockRequest.mockResolvedValueOnce(undefined);
    renderAt('/forgot-password', [
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/forgot-password/sent', element: <div>sent-screen</div> },
    ]);

    await user.type(screen.getByLabelText('Work email'), 'anna@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(mockRequest).toHaveBeenCalledWith('anna@example.com');
    expect(await screen.findByText('sent-screen')).toBeInTheDocument();
  });

  it('surfaces an inline error when the request fails', async () => {
    const user = userEvent.setup();
    mockRequest.mockRejectedValueOnce(new Error('network'));
    renderAt('/forgot-password', [{ path: '/forgot-password', element: <ForgotPasswordPage /> }]);

    const email = screen.getByLabelText('Work email');
    await user.type(email, 'anna@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    // Error is associated with the email input for SR users (#2183).
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', alert.getAttribute('id'));
  });
});

describe('ForgotPasswordSentPage', () => {
  it('shows the redacted address and resends on demand', async () => {
    const user = userEvent.setup();
    mockRequest.mockResolvedValueOnce(undefined);
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/forgot-password/sent', state: { email: 'anna@example.com' } },
        ]}
      >
        <Routes>
          <Route path="/forgot-password/sent" element={<ForgotPasswordSentPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Redacted: first local char kept, domain intact.
    expect(screen.getByText(/@example\.com/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resend' }));
    expect(mockRequest).toHaveBeenCalledWith('anna@example.com');
    expect(await screen.findByText(/sent — check your inbox/i)).toBeInTheDocument();
  });

  it('routes back to the request screen when no address is in state', async () => {
    const user = userEvent.setup();
    renderAt('/forgot-password/sent', [
      { path: '/forgot-password/sent', element: <ForgotPasswordSentPage /> },
      { path: '/forgot-password', element: <div>request-screen</div> },
    ]);

    await user.click(screen.getByRole('button', { name: 'Resend' }));
    expect(await screen.findByText('request-screen')).toBeInTheDocument();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('ResetPasswordConfirmPage', () => {
  const CONFIRM_PATH = '/reset-password/confirm/:uid/:token';
  const START = '/reset-password/confirm/uid123/tok456';

  async function fillPasswords(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('New password'), STRONG_PASSWORD);
    await user.type(screen.getByLabelText('Confirm new password'), STRONG_PASSWORD);
  }

  it('submits uid + token and navigates to the done screen on success', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce({ kind: 'success' });
    renderAt(START, [
      { path: CONFIRM_PATH, element: <ResetPasswordConfirmPage /> },
      { path: '/reset-password/done', element: <div>done-screen</div> },
    ]);

    await fillPasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(mockConfirm).toHaveBeenCalledWith('uid123', 'tok456', STRONG_PASSWORD);
    expect(await screen.findByText('done-screen')).toBeInTheDocument();
  });

  it('navigates to the expired screen when the token is invalid', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce({ kind: 'invalid_token' });
    renderAt(START, [
      { path: CONFIRM_PATH, element: <ResetPasswordConfirmPage /> },
      { path: '/reset-password/expired', element: <div>expired-screen</div> },
    ]);

    await fillPasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('expired-screen')).toBeInTheDocument();
  });

  it('renders server-side policy messages inline on a weak password', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce({
      kind: 'weak_password',
      messages: ['This password is too common.'],
    });
    renderAt(START, [{ path: CONFIRM_PATH, element: <ResetPasswordConfirmPage /> }]);

    await fillPasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('This password is too common.'),
    );
  });

  it('warns when the confirmation does not match', async () => {
    const user = userEvent.setup();
    renderAt(START, [{ path: CONFIRM_PATH, element: <ResetPasswordConfirmPage /> }]);

    await user.type(screen.getByLabelText('New password'), STRONG_PASSWORD);
    const confirm = screen.getByLabelText('Confirm new password');
    await user.type(confirm, 'different99');
    const mismatch = screen.getByText(/passwords don’t match/i);
    expect(mismatch).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
    // Mismatch message is associated with the confirm input (#2206).
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).toHaveAttribute('aria-describedby', mismatch.getAttribute('id'));
  });

  it('associates server policy errors with the new-password input (#2206)', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce({
      kind: 'weak_password',
      messages: ['This password is too common.'],
    });
    renderAt(START, [{ path: CONFIRM_PATH, element: <ResetPasswordConfirmPage /> }]);

    const newPassword = screen.getByLabelText('New password');
    await fillPasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    const alert = await screen.findByRole('alert');
    expect(newPassword).toHaveAttribute('aria-invalid', 'true');
    expect(newPassword).toHaveAttribute('aria-describedby', alert.getAttribute('id'));
  });
});

describe('terminal screens', () => {
  it('ResetPasswordDonePage confirms success and links to sign in', () => {
    renderAt('/reset-password/done', [
      { path: '/reset-password/done', element: <ResetPasswordDonePage /> },
    ]);
    expect(screen.getByRole('heading', { name: "You're all set" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('ResetPasswordExpiredPage offers a fresh link', () => {
    renderAt('/reset-password/expired', [
      { path: '/reset-password/expired', element: <ResetPasswordExpiredPage /> },
    ]);
    expect(screen.getByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
