import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { acceptInvite, classifyAcceptError } from './inviteApi';

/** Build an object the real `axios.isAxiosError` recognizes (checks `isAxiosError === true`). */
function axiosError(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyAcceptError', () => {
  it('maps a 400 invalid/expired link → invalid_token', () => {
    expect(
      classifyAcceptError(axiosError(400, { detail: 'This invitation link is invalid or has expired.' })),
    ).toEqual({ kind: 'invalid_token' });
  });

  it('maps a 400 username-taken → username_taken', () => {
    expect(
      classifyAcceptError(axiosError(400, { detail: 'That username is already taken.' })),
    ).toEqual({ kind: 'username_taken' });
  });

  it('maps the token-only path with no account → account_required', () => {
    expect(
      classifyAcceptError(
        axiosError(400, { detail: 'A username and password are required to accept this invitation.' }),
      ),
    ).toEqual({ kind: 'account_required' });
  });

  it('maps a deactivated membership → deactivated with the server message', () => {
    const detail = 'Membership is deactivated; an admin must reactivate it before this invite can be used.';
    expect(classifyAcceptError(axiosError(400, { detail }))).toEqual({
      kind: 'deactivated',
      message: detail,
    });
  });

  it('falls through to weak_password for a joined policy message', () => {
    const detail = 'This password is too short. This password is too common.';
    expect(classifyAcceptError(axiosError(400, { detail }))).toEqual({
      kind: 'weak_password',
      message: detail,
    });
  });

  it('maps 429 → rate_limited', () => {
    expect(classifyAcceptError(axiosError(429))).toEqual({ kind: 'rate_limited' });
  });

  it('maps a 400 with no detail → error (never an opaque object blob)', () => {
    expect(classifyAcceptError(axiosError(400, { token: ['This field is required.'] }))).toEqual({
      kind: 'error',
    });
  });

  it('maps a non-axios error → error', () => {
    expect(classifyAcceptError(new Error('boom'))).toEqual({ kind: 'error' });
  });

  it('maps a network error (no response) → error', () => {
    expect(classifyAcceptError({ isAxiosError: true })).toEqual({ kind: 'error' });
  });
});

describe('acceptInvite', () => {
  it('POSTs token + trimmed username + password and returns the server username', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { detail: 'Invitation accepted.', username: 'anna_khoury' } });
    const outcome = await acceptInvite({ token: 'tok', username: '  anna_khoury  ', password: 'S3cret!!' });
    expect(outcome).toEqual({ kind: 'success', username: 'anna_khoury' });
    expect(post).toHaveBeenCalledWith('/api/v1/workspace/invites/accept/', {
      token: 'tok',
      username: 'anna_khoury',
      password: 'S3cret!!',
    });
  });

  it('omits username/password on the existing-account (token-only) path', async () => {
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { detail: 'Invitation accepted.', username: 'existing_user' } });
    const outcome = await acceptInvite({ token: 'tok' });
    expect(outcome).toEqual({ kind: 'success', username: 'existing_user' });
    expect(post).toHaveBeenCalledWith('/api/v1/workspace/invites/accept/', { token: 'tok' });
  });

  it('never throws — folds a rejection into an outcome', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(
      axiosError(400, { detail: 'That username is already taken.' }),
    );
    const outcome = await acceptInvite({ token: 'tok', username: 'taken', password: 'S3cret!!' });
    expect(outcome).toEqual({ kind: 'username_taken' });
  });
});
