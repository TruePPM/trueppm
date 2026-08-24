import { describe, it, expect } from 'vitest';
import {
  pullCountLabel,
  syncFailureMessage,
  syncFailureNeedsReconnect,
  truncationNotice,
  type ExternalSyncOutcome,
} from './syncOutcome';

const ok: ExternalSyncOutcome = {
  at: '2026-08-23T09:00:00Z',
  ok: true,
  reason: '',
  fetched: 12,
  stored: 12,
  total_available: 12,
  truncated: false,
};

describe('truncationNotice', () => {
  it('is silent when nothing was cut', () => {
    expect(truncationNotice(ok)).toBeNull();
  });

  it('is silent when there is no outcome yet', () => {
    expect(truncationNotice(null)).toBeNull();
    expect(truncationNotice(undefined)).toBeNull();
  });

  it('names both numbers when the provider reported a total', () => {
    expect(
      truncationNotice({
        ...ok,
        fetched: 100,
        stored: 100,
        total_available: 412,
        truncated: true,
      }),
    ).toBe('Showing the first 100 of 412 items assigned to you.');
  });

  it('omits the denominator when the provider reported no total', () => {
    // `total_available: null` means the source did not say. Inventing a total
    // here would be a fabricated number in the one place this feature exists to
    // stop guessing.
    const notice = truncationNotice({
      ...ok,
      fetched: 100,
      stored: 100,
      total_available: null,
      truncated: true,
    });
    expect(notice).toBe('Showing the first 100 items assigned to you — there may be more.');
    expect(notice).not.toMatch(/of \d/);
  });

  it('omits the denominator when the reported total does not exceed what was stored', () => {
    // A total that contradicts the truncation flag must not produce "the first
    // 100 of 100", which reads as a cap that did not bite.
    expect(
      truncationNotice({ ...ok, stored: 100, total_available: 100, truncated: true }),
    ).toBe('Showing the first 100 items assigned to you — there may be more.');
  });

  it('says nothing about truncation on a failed pull', () => {
    // A failure stores nothing, so "showing the first 0" would describe the
    // failure as a cap. The failure message is the right surface for that.
    expect(
      truncationNotice({ ...ok, ok: false, reason: 'unreachable', truncated: true, stored: 0 }),
    ).toBeNull();
  });
});

describe('pullCountLabel', () => {
  it('counts a normal pull', () => {
    expect(pullCountLabel(ok)).toBe('12 items pulled');
  });

  it('does not pluralize a single item', () => {
    expect(pullCountLabel({ ...ok, stored: 1 })).toBe('1 item pulled');
  });

  it('distinguishes an empty pull from no pull at all', () => {
    expect(pullCountLabel({ ...ok, stored: 0 })).toBe('No assigned items pulled');
    expect(pullCountLabel(null)).toBeNull();
  });

  it('reports no count for a failed pull', () => {
    expect(pullCountLabel({ ...ok, ok: false, reason: 'auth_failed' })).toBeNull();
  });
});

describe('syncFailureMessage', () => {
  it.each([
    ['auth_failed', /rejected the saved token/],
    ['invalid_filter', /filter or project keys/],
    ['rate_limited', /rate-limiting/],
    ['credential_unreadable', /could not be read/],
    ['unreachable', /Couldn't reach/],
  ])('maps %s to its own remedy', (reason, matcher) => {
    expect(syncFailureMessage({ ...ok, ok: false, reason }, 'Jira')).toMatch(matcher);
  });

  it('does not promise automatic recovery on a rate limit', () => {
    // Polling is default-off with no toggle and a pull has no resume cursor, so
    // "the next sync will pick up where this one stopped" would be a capability
    // claim with no code path behind it.
    const msg = syncFailureMessage({ ...ok, ok: false, reason: 'rate_limited' }, 'Jira');
    expect(msg).not.toMatch(/pick up where/i);
    expect(msg).toMatch(/Sync now/);
  });

  it('falls back rather than rendering an unknown token at the user', () => {
    // The backend vocabulary is closed, but a client can be older than the
    // server. A raw token in the UI would be worse than a generic sentence.
    const msg = syncFailureMessage({ ...ok, ok: false, reason: 'some_new_token' }, 'Jira');
    expect(msg).not.toMatch(/some_new_token/);
    expect(msg).toMatch(/didn't complete/);
  });
});

describe('syncFailureNeedsReconnect', () => {
  it('is true only where the connect wizard is actually the fix', () => {
    // A notice must not name a remedy the surface cannot offer, and must not
    // offer one for a fault that clears on its own.
    expect(
      syncFailureNeedsReconnect({ ...ok, ok: false, reason: 'credential_unreadable' }),
    ).toBe(true);
    expect(syncFailureNeedsReconnect({ ...ok, ok: false, reason: 'auth_failed' })).toBe(true);
    expect(syncFailureNeedsReconnect({ ...ok, ok: false, reason: 'unreachable' })).toBe(false);
    expect(syncFailureNeedsReconnect({ ...ok, ok: false, reason: 'rate_limited' })).toBe(false);
  });
});
