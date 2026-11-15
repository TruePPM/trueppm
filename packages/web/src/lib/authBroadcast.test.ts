import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CHANNEL_NAME,
  postAuthMessage,
  resetAuthBroadcastForTests,
  subscribeAuthMessages,
} from './authBroadcast';

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthBroadcastForTests();
});

describe('authBroadcast (#4296)', () => {
  it('is a silent no-op where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    resetAuthBroadcastForTests();
    const handler = vi.fn();
    const unsubscribe = subscribeAuthMessages(handler);
    expect(() => postAuthMessage('expired')).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers a sibling instance's message, ignores malformed ones, and never carries a token", async () => {
    resetAuthBroadcastForTests();
    const handler = vi.fn();
    subscribeAuthMessages(handler);
    const sibling = new BroadcastChannel(AUTH_CHANNEL_NAME);
    sibling.postMessage({ type: 'restored' });
    sibling.postMessage({ type: 'bogus' });
    sibling.postMessage('not-an-object');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('restored'));
    expect(handler).toHaveBeenCalledTimes(1);
    sibling.close();
  });

  it("does not deliver this tab's own post back to its own handlers", async () => {
    resetAuthBroadcastForTests();
    const handler = vi.fn();
    subscribeAuthMessages(handler);
    postAuthMessage('expired');
    await new Promise((r) => setTimeout(r, 30));
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    resetAuthBroadcastForTests();
    const handler = vi.fn();
    subscribeAuthMessages(handler)();
    const sibling = new BroadcastChannel(AUTH_CHANNEL_NAME);
    sibling.postMessage({ type: 'expired' });
    await new Promise((r) => setTimeout(r, 30));
    expect(handler).not.toHaveBeenCalled();
    sibling.close();
  });
});
