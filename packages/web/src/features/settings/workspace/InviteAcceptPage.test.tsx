import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InviteAcceptPage } from './InviteAcceptPage';
import { acceptInvite } from './inviteApi';

// Stub only the network call; the page logic (error routing, association) is real.
vi.mock('./inviteApi', async (importActual) => {
  const actual = await importActual<typeof import('./inviteApi')>();
  return { ...actual, acceptInvite: vi.fn() };
});
const mockAccept = vi.mocked(acceptInvite);

/** A password that satisfies the client-side requirements (≥10 chars + a digit). */
const STRONG_PASSWORD = 'Str0ngPass99';

afterEach(() => vi.clearAllMocks());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invite/accept" element={<InviteAcceptPage />} />
        <Route path="/login" element={<div>login-screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InviteAcceptPage', () => {
  it('associates the "username taken" error with the username input (#2183)', async () => {
    const user = userEvent.setup();
    mockAccept.mockResolvedValueOnce({ kind: 'username_taken' });
    renderAt('/invite/accept?token=tok123');

    const username = screen.getByLabelText('Username');
    await user.type(username, 'anna_khoury');
    await user.type(screen.getByLabelText('Password'), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account & join' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already taken/i);
    expect(username).toHaveAttribute('aria-invalid', 'true');
    expect(username).toHaveAttribute('aria-describedby', alert.getAttribute('id'));
  });

  it('associates the "weak password" error with the password input (#2183)', async () => {
    const user = userEvent.setup();
    mockAccept.mockResolvedValueOnce({ kind: 'weak_password', message: 'Too common.' });
    renderAt('/invite/accept?token=tok123');

    const password = screen.getByLabelText('Password');
    await user.type(screen.getByLabelText('Username'), 'anna_khoury');
    await user.type(password, STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account & join' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too common.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', alert.getAttribute('id'));
  });

  it('clears the invalid state on the username field once the user edits it', async () => {
    const user = userEvent.setup();
    mockAccept.mockResolvedValueOnce({ kind: 'username_taken' });
    renderAt('/invite/accept?token=tok123');

    const username = screen.getByLabelText('Username');
    await user.type(username, 'anna_khoury');
    await user.type(screen.getByLabelText('Password'), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account & join' }));

    await waitFor(() => expect(username).toHaveAttribute('aria-invalid', 'true'));

    await user.type(username, '_2');
    expect(username).toHaveAttribute('aria-invalid', 'false');
    expect(username).not.toHaveAttribute('aria-describedby');
  });
});
