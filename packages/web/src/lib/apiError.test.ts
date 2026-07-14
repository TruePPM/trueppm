import { describe, it, expect } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { isClientRejection, extractValidationMessage } from './apiError';

function axios4xx(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = { status, data } as AxiosResponse;
  return err;
}

describe('isClientRejection', () => {
  it('is true for a 400 validation rejection', () => {
    expect(isClientRejection(axios4xx(400, { entry_date: ['nope'] }))).toBe(true);
  });

  it('is true across the whole 4xx range (403, 404, 409)', () => {
    expect(isClientRejection(axios4xx(403, {}))).toBe(true);
    expect(isClientRejection(axios4xx(404, {}))).toBe(true);
    expect(isClientRejection(axios4xx(409, {}))).toBe(true);
  });

  it('is false for a 5xx server error — replaying it may still succeed', () => {
    expect(isClientRejection(axios4xx(500, {}))).toBe(false);
    expect(isClientRejection(axios4xx(503, {}))).toBe(false);
  });

  it('is false for a network error (no response) — that is an offline/pending write', () => {
    expect(isClientRejection(new AxiosError('Network Error'))).toBe(false);
  });

  it('is false for a plain non-axios error', () => {
    expect(isClientRejection(new Error('Session expired'))).toBe(false);
    expect(isClientRejection('boom')).toBe(false);
    expect(isClientRejection(null)).toBe(false);
  });
});

describe('extractValidationMessage', () => {
  it('reads a DRF field error list (first message)', () => {
    const err = axios4xx(400, { minutes: ['Ensure this value is greater than 0.'] });
    expect(extractValidationMessage(err, 'fallback')).toBe(
      'Ensure this value is greater than 0.',
    );
  });

  it('reads a non_field_errors validation message', () => {
    const err = axios4xx(400, {
      non_field_errors: ['Time cannot be logged against a phase.'],
    });
    expect(extractValidationMessage(err, 'fallback')).toBe(
      'Time cannot be logged against a phase.',
    );
  });

  it('prefers detail over field errors', () => {
    const err = axios4xx(400, { detail: 'Entry date cannot be in the future.', minutes: ['x'] });
    expect(extractValidationMessage(err, 'fallback')).toBe('Entry date cannot be in the future.');
  });

  it('reads a bare string body', () => {
    expect(extractValidationMessage(axios4xx(400, 'Rejected.'), 'fallback')).toBe('Rejected.');
  });

  it('falls back when the body shape is unrecognized or the error is not axios', () => {
    expect(extractValidationMessage(axios4xx(400, {}), 'fallback')).toBe('fallback');
    expect(extractValidationMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});
