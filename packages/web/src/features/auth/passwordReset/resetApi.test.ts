import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import {
  classifyConfirmError,
  confirmPasswordReset,
  isRateLimited,
  redactEmail,
  requestPasswordReset,
} from './resetApi';

/** Build an object the real `axios.isAxiosError` recognizes (checks `isAxiosError === true`). */
function axiosError(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redactEmail', () => {
  it('keeps the first local char and the full domain, masks the rest', () => {
    const r = redactEmail('anna.khoury@example.com');
    expect(r.startsWith('a')).toBe(true);
    expect(r.endsWith('@example.com')).toBe(true);
    // The rest of the 11-char local part ("nna.khoury", 10 chars) is masked.
    expect(r).not.toContain('nna.khoury');
    expect(r.replace(/[^•]/g, '')).toHaveLength(10);
  });

  it('masks at least one character for a single-char local part', () => {
    expect(redactEmail('a@b.com')).toBe('a•@b.com');
  });

  it('falls back to a neutral label for a non-address', () => {
    expect(redactEmail('not-an-email')).toBe('your email address');
    expect(redactEmail('@nope.com')).toBe('your email address');
    expect(redactEmail('a@')).toBe('your email address');
  });
});

describe('classifyConfirmError', () => {
  it('maps 400 invalid_token → invalid_token', () => {
    expect(classifyConfirmError(axiosError(400, { code: 'invalid_token' }))).toEqual({
      kind: 'invalid_token',
    });
  });

  it('maps 400 weak_password → weak_password with string messages only', () => {
    const outcome = classifyConfirmError(
      axiosError(400, { code: 'weak_password', messages: ['Too short.', 42, 'Add a number.'] }),
    );
    expect(outcome).toEqual({ kind: 'weak_password', messages: ['Too short.', 'Add a number.'] });
  });

  it('maps 400 weak_password with no messages → empty messages array', () => {
    expect(classifyConfirmError(axiosError(400, { code: 'weak_password' }))).toEqual({
      kind: 'weak_password',
      messages: [],
    });
  });

  it('maps 429 → rate_limited', () => {
    expect(classifyConfirmError(axiosError(429))).toEqual({ kind: 'rate_limited' });
  });

  it('maps an unknown 400 code → error', () => {
    expect(classifyConfirmError(axiosError(400, { code: 'mystery' }))).toEqual({ kind: 'error' });
  });

  it('maps a non-axios error → error', () => {
    expect(classifyConfirmError(new Error('boom'))).toEqual({ kind: 'error' });
  });

  it('maps a network error (no response) → error', () => {
    expect(classifyConfirmError({ isAxiosError: true })).toEqual({ kind: 'error' });
  });
});

describe('isRateLimited', () => {
  it('is true for a 429, false otherwise', () => {
    expect(isRateLimited(axiosError(429))).toBe(true);
    expect(isRateLimited(axiosError(400))).toBe(false);
    expect(isRateLimited(new Error('x'))).toBe(false);
  });
});

describe('requestPasswordReset', () => {
  it('POSTs the email to the reset endpoint', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await requestPasswordReset('user@example.com');
    expect(post).toHaveBeenCalledWith('/api/v1/auth/password/reset/', {
      email: 'user@example.com',
    });
  });

  it('propagates a transport failure so the caller can show an error', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(axiosError(500));
    await expect(requestPasswordReset('user@example.com')).rejects.toBeTruthy();
  });
});

describe('confirmPasswordReset', () => {
  it('returns success when the POST resolves', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    const outcome = await confirmPasswordReset('UID', 'tok', 'S3cretPassw0rd!');
    expect(outcome).toEqual({ kind: 'success' });
    expect(post).toHaveBeenCalledWith('/api/v1/auth/password/reset/confirm/', {
      uid: 'UID',
      token: 'tok',
      new_password: 'S3cretPassw0rd!',
    });
  });

  it('never throws — folds an invalid-token rejection into an outcome', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(axiosError(400, { code: 'invalid_token' }));
    const outcome = await confirmPasswordReset('UID', 'bad', 'S3cretPassw0rd!');
    expect(outcome).toEqual({ kind: 'invalid_token' });
  });
});
