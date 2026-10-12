import { describe, it, expect, beforeEach } from 'vitest';
import {
  useWsConnectionStore,
  STALE_AFTER_ATTEMPTS,
  fallbackPollInterval,
  FALLBACK_POLL_INTERVAL_MS,
  REFUSED_POLL_INTERVAL_MS,
} from './wsConnectionStore';

beforeEach(() => {
  useWsConnectionStore.setState({ state: 'connecting', reconnectAttempts: 0 });
});

const { getState } = useWsConnectionStore;

describe('wsConnectionStore state machine', () => {
  it('starts in connecting with no reconnect attempts', () => {
    expect(getState().state).toBe('connecting');
    expect(getState().reconnectAttempts).toBe(0);
  });

  it('markLive transitions to live and clears the attempt counter', () => {
    getState().markDisconnected();
    getState().markDisconnected();
    getState().markLive();
    expect(getState().state).toBe('live');
    expect(getState().reconnectAttempts).toBe(0);
  });

  it('first disconnects are reconnecting; escalates to stale at the threshold', () => {
    for (let i = 1; i < STALE_AFTER_ATTEMPTS; i++) {
      getState().markDisconnected();
      expect(getState().reconnectAttempts).toBe(i);
      expect(getState().state).toBe('reconnecting');
    }
    // The STALE_AFTER_ATTEMPTS-th consecutive disconnect tips into stale.
    getState().markDisconnected();
    expect(getState().reconnectAttempts).toBe(STALE_AFTER_ATTEMPTS);
    expect(getState().state).toBe('stale');
  });

  it('stays stale on further disconnects', () => {
    for (let i = 0; i < STALE_AFTER_ATTEMPTS + 2; i++) getState().markDisconnected();
    expect(getState().state).toBe('stale');
  });

  it('a successful reconnect after going stale resets cleanly', () => {
    for (let i = 0; i < STALE_AFTER_ATTEMPTS; i++) getState().markDisconnected();
    expect(getState().state).toBe('stale');
    getState().markLive();
    expect(getState().state).toBe('live');
    expect(getState().reconnectAttempts).toBe(0);
    // The next single drop is reconnecting again, not stale.
    getState().markDisconnected();
    expect(getState().state).toBe('reconnecting');
  });

  it('markFailed is terminal regardless of attempt count', () => {
    getState().markDisconnected();
    getState().markFailed();
    expect(getState().state).toBe('failed');
  });

  it('markConnecting resets state and attempts (leaving the project)', () => {
    getState().markFailed();
    getState().markConnecting();
    expect(getState().state).toBe('connecting');
    expect(getState().reconnectAttempts).toBe(0);
  });
});

describe('refused state and the shared fallback poll (#4375)', () => {
  it('markRefused is terminal-but-not-a-fault: refused, attempt counter cleared', () => {
    getState().markDisconnected();
    getState().markRefused();
    expect(getState().state).toBe('refused');
    expect(getState().reconnectAttempts).toBe(0);
  });

  it('polls never while live, relaxed while refused, at 30 s in every other state', () => {
    expect(fallbackPollInterval('live')).toBe(false);
    expect(fallbackPollInterval('refused')).toBe(REFUSED_POLL_INTERVAL_MS);
    for (const state of ['connecting', 'reconnecting', 'stale', 'failed'] as const) {
      expect(fallbackPollInterval(state)).toBe(FALLBACK_POLL_INTERVAL_MS);
    }
    expect(REFUSED_POLL_INTERVAL_MS).toBeGreaterThan(FALLBACK_POLL_INTERVAL_MS);
  });
});
