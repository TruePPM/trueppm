import { describe, it, expect } from 'vitest';
import { axiosNetworkError, axiosRefusal } from '@/test/axiosError';
import { describeWriteRefusal, isRetryableFailure } from './writeRefusal';

const FALLBACK = "Couldn't save.";

describe('isRetryableFailure', () => {
  it('is false across the ordinary 4xx band — the server has already decided', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableFailure(axiosRefusal(status, { detail: 'no' }))).toBe(false);
    }
  });

  it('is TRUE for 408 and 429, which refuse the timing and not the content', () => {
    // The carve-out #3302 established and #3332 must preserve: the same bytes
    // sent later do succeed, so these two are the only 4xx a Retry helps.
    expect(isRetryableFailure(axiosRefusal(408, { detail: 'Request timeout.' }))).toBe(true);
    expect(isRetryableFailure(axiosRefusal(429, { detail: 'Too many requests.' }))).toBe(true);
  });

  it('is true for 5xx, a network loss, and a non-axios throw', () => {
    expect(isRetryableFailure(axiosRefusal(500, {}))).toBe(true);
    expect(isRetryableFailure(axiosRefusal(503, {}))).toBe(true);
    expect(isRetryableFailure(axiosNetworkError())).toBe(true);
    expect(isRetryableFailure(new Error('boom'))).toBe(true);
  });
});

describe('describeWriteRefusal', () => {
  it('returns null for a nullish error so a caller can pass a mutation error straight through', () => {
    expect(describeWriteRefusal(null, FALLBACK)).toBeNull();
    expect(describeWriteRefusal(undefined, FALLBACK)).toBeNull();
  });

  it('surfaces a DRF `detail` verbatim and refuses a retry (403)', () => {
    const refusal = describeWriteRefusal(
      axiosRefusal(403, { detail: 'You do not have permission to perform this action.' }),
      FALLBACK,
    );
    expect(refusal).toEqual({
      message: 'You do not have permission to perform this action.',
      detail: null,
      retryable: false,
    });
  });

  it('surfaces a flat field error (400) without a field prefix', () => {
    const refusal = describeWriteRefusal(
      axiosRefusal(400, { planned_start: ['Enter a valid date.'] }),
      FALLBACK,
    );
    expect(refusal?.message).toBe('Enter a valid date.');
    expect(refusal?.retryable).toBe(false);
  });

  it('surfaces `non_field_errors` ahead of a per-field message', () => {
    const refusal = describeWriteRefusal(
      axiosRefusal(400, {
        non_field_errors: ['Finish must be on or after start.'],
        planned_finish: ['Bad.'],
      }),
      FALLBACK,
    );
    expect(refusal?.message).toBe('Finish must be on or after start.');
  });

  it('descends a NESTED DRF body and keeps the item position (#3325 inherited)', () => {
    // The gap #3325 closed: a `many=True` body used to read as null here, so the
    // reason the server actually sent was discarded for the fallback.
    const refusal = describeWriteRefusal(
      axiosRefusal(400, { tasks: [{}, { name: ['This field is required.'] }] }),
      FALLBACK,
    );
    expect(refusal?.message).toBe('Item 2 → name: This field is required.');
  });

  it('keeps the fallback for a network loss, and marks it retryable', () => {
    expect(describeWriteRefusal(axiosNetworkError(), FALLBACK)).toEqual({
      message: FALLBACK,
      detail: null,
      retryable: true,
    });
  });

  it('keeps the fallback for an opaque 5xx, and marks it retryable', () => {
    expect(describeWriteRefusal(axiosRefusal(500, {}), FALLBACK)).toEqual({
      message: FALLBACK,
      detail: null,
      retryable: true,
    });
  });

  it('refuses to paste an HTML error page into a sentence slot', () => {
    // A genuine crash never reaches DRF's JSON renderer — Django serves an HTML
    // 500 page and axios hands the whole document over as a string.
    const html = '<!doctype html><html><body><h1>Server Error (500)</h1></body></html>';
    const refusal = describeWriteRefusal(axiosRefusal(500, html), FALLBACK);
    expect(refusal?.message).toBe(FALLBACK);
    expect(refusal?.message).not.toContain('<');
  });

  it('refuses a body that is a wall of text rather than a sentence', () => {
    const refusal = describeWriteRefusal(axiosRefusal(400, { detail: 'x'.repeat(301) }), FALLBACK);
    expect(refusal?.message).toBe(FALLBACK);
  });

  it('keeps a sentence right at the length ceiling', () => {
    const message = 'y'.repeat(300);
    expect(describeWriteRefusal(axiosRefusal(400, { detail: message }), FALLBACK)?.message).toBe(
      message,
    );
  });

  it('trims a padded server sentence rather than rendering the padding', () => {
    const refusal = describeWriteRefusal(axiosRefusal(400, { detail: '  Too long.  ' }), FALLBACK);
    expect(refusal?.message).toBe('Too long.');
  });

  it('falls back on an empty-string body rather than rendering nothing', () => {
    expect(describeWriteRefusal(axiosRefusal(400, { detail: '   ' }), FALLBACK)?.message).toBe(
      FALLBACK,
    );
  });

  it('lets a surface add its own second line, and hands it the resolved message', () => {
    const seen: string[] = [];
    const refusal = describeWriteRefusal(
      axiosRefusal(400, { code: 'subtree_too_large', detail: '412 rows exceed the cap of 200.' }),
      FALLBACK,
      (_err, message) => {
        seen.push(message);
        return 'Classify a smaller branch.';
      },
    );
    expect(refusal?.detail).toBe('Classify a smaller branch.');
    // The surface can decline to repeat what the sentence already says only if
    // it is handed the sentence.
    expect(seen).toEqual(['412 rows exceed the cap of 200.']);
  });

  it('leaves `detail` null when the surface supplies no reader', () => {
    expect(describeWriteRefusal(axiosRefusal(400, { detail: 'No.' }), FALLBACK)?.detail).toBeNull();
  });
});
