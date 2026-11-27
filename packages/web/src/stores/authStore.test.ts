import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { READ_ONLY_VIEW_WINDOW_MS, registerSessionBridge, useAuthStore } from './authStore';
import * as authBroadcast from '@/lib/authBroadcast';
import { useLastTaskStore } from './lastTaskStore';
import { purgePwaUserData } from '@/lib/pwa/pwaStore';

vi.mock('@/lib/pwa/pwaStore', () => ({ purgePwaUserData: vi.fn(() => Promise.resolve()) }));

afterEach(() => {
  registerSessionBridge(null);
  vi.restoreAllMocks();
});

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clearTokens();
    localStorage.clear();
  });

  it('starts unauthenticated with a null access token', () => {
    const { accessToken, isAuthenticated } = useAuthStore.getState();
    expect(accessToken).toBeNull();
    expect(isAuthenticated).toBe(false);
  });

  it('setAccessToken stores the access token in memory and authenticates', () => {
    useAuthStore.getState().setAccessToken('access-abc');
    const { accessToken, isAuthenticated, sessionExpired } = useAuthStore.getState();
    expect(accessToken).toBe('access-abc');
    expect(isAuthenticated).toBe(true);
    expect(sessionExpired).toBe(false);
  });

  it('clearTokens resets to unauthenticated state', () => {
    useAuthStore.getState().setAccessToken('access-abc');
    useAuthStore.getState().clearTokens();
    const { accessToken, isAuthenticated } = useAuthStore.getState();
    expect(accessToken).toBeNull();
    expect(isAuthenticated).toBe(false);
  });

  it("clearTokens purges the installed app's offline copy (ADR-1523 §4)", () => {
    // Every sign-out funnels through clearTokens (menu, session-expired Sign in,
    // workspace deletion, a sibling's sign-out), and the snapshot is read only
    // offline, where the next user cannot be checked against it.
    useAuthStore.getState().setAccessToken('access-abc');
    vi.mocked(purgePwaUserData).mockClear();
    useAuthStore.getState().clearTokens();
    expect(purgePwaUserData).toHaveBeenCalledOnce();
  });

  it('markSessionExpired clears the access token and sets the expired flag', () => {
    useAuthStore.getState().setAccessToken('access-abc');
    useAuthStore.getState().markSessionExpired();
    const { accessToken, isAuthenticated, sessionExpired } = useAuthStore.getState();
    expect(accessToken).toBeNull();
    expect(isAuthenticated).toBe(false);
    expect(sessionExpired).toBe(true);
  });

  // #897: tokens must never be persisted to localStorage. The access token is
  // held in memory only; the refresh token lives in an httpOnly cookie. Only the
  // non-sensitive `isAuthenticated` hint is allowed in the persisted partition.
  it('does not persist the access token to localStorage', () => {
    useAuthStore.getState().setAccessToken('super-secret-access');
    const persisted = localStorage.getItem('trueppm-auth') ?? '';
    expect(persisted).not.toContain('super-secret-access');
    expect(persisted).not.toContain('accessToken');
    // No refresh token concept exists in the store at all anymore.
    expect(persisted).not.toContain('refreshToken');
  });

  it('does not expose a refreshToken field on the store', () => {
    const state = useAuthStore.getState() as unknown as Record<string, unknown>;
    expect('refreshToken' in state).toBe(false);
  });

  // #1922: the read-only escape hatch on SessionExpiredBanner.
  describe('sessionExpiredReadOnly', () => {
    it('enterReadOnlyMode flips the flag without touching sessionExpired', () => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      const { sessionExpired, sessionExpiredReadOnly } = useAuthStore.getState();
      expect(sessionExpired).toBe(true);
      expect(sessionExpiredReadOnly).toBe(true);
    });

    it('reassertSessionExpired answers the first blocked write with a cue, the second with the modal (#4316)', () => {
      vi.useFakeTimers();
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      expect(useAuthStore.getState().reassertSessionExpired()).toBe('cue');
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
      vi.runAllTimers(); // the repeat is a later action, not the same one
      expect(useAuthStore.getState().reassertSessionExpired()).toBe('modal');
      vi.useRealTimers();
      expect(useAuthStore.getState().sessionExpiredInterrupted).toBe(true);
      const { sessionExpired, sessionExpiredReadOnly } = useAuthStore.getState();
      expect(sessionExpired).toBe(true);
      expect(sessionExpiredReadOnly).toBe(false);
    });

    it('two writes refused in the same tick are one action: the second does not escalate', () => {
      vi.useFakeTimers();
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      expect(useAuthStore.getState().reassertSessionExpired()).toBe('cue');
      expect(useAuthStore.getState().reassertSessionExpired()).toBe('none');
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
      vi.runAllTimers();
      expect(useAuthStore.getState().reassertSessionExpired()).toBe('modal');
      vi.useRealTimers();
    });

    it('reassertSessionExpired is a no-op when the modal is already blocking', () => {
      useAuthStore.getState().markSessionExpired();
      // sessionExpiredReadOnly is already false here — reassert should not
      // throw or otherwise change unrelated state.
      useAuthStore.getState().reassertSessionExpired();
      const { sessionExpired, sessionExpiredReadOnly } = useAuthStore.getState();
      expect(sessionExpired).toBe(true);
      expect(sessionExpiredReadOnly).toBe(false);
    });

    it('markSessionExpired always resets a stale read-only acknowledgment from a prior expiry', () => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      useAuthStore.getState().setAccessToken('fresh-token');
      useAuthStore.getState().markSessionExpired();
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
    });

    it('clearTokens and setAccessToken reset sessionExpiredReadOnly', () => {
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      useAuthStore.getState().clearTokens();
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);

      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      useAuthStore.getState().setAccessToken('new-token');
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
    });
  });

  describe('last-opened task hand-off (#1211)', () => {
    const TASK = { taskId: 't1', projectId: 'p1', name: 'Wire OAuth', ref: null };

    it.each([
      ['clearTokens', () => useAuthStore.getState().clearTokens()],
      ['markSessionExpired', () => useAuthStore.getState().markSessionExpired()],
    ])("%s drops the previous user's last task", (_name, signOut) => {
      useLastTaskStore.getState().setOpened(TASK);
      signOut();
      expect(useLastTaskStore.getState().opened).toBeNull();
    });
  });

  // #4316 / #4313: what the data layer saw when the session ended picks the surface.
  describe('session end context (#4316, #4313)', () => {
    it('skips the modal for a plain expiry with content loaded and no write in flight', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache: () => {},
      });
      useAuthStore.getState().markSessionExpired();
      const s = useAuthStore.getState();
      expect(s.sessionExpiredReadOnly).toBe(true);
      expect(s.sessionExpiredInterrupted).toBe(false);
      // Focus must not be pulled out of whatever the user was typing into.
      expect(s.focusReadOnlyBar).toBe(false);
    });

    it('keeps the modal, flagged interrupted, when a write was in flight', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: true, hasContent: true }),
        clearCache: () => {},
      });
      useAuthStore.getState().markSessionExpired();
      const s = useAuthStore.getState();
      expect(s.sessionExpiredReadOnly).toBe(false);
      expect(s.sessionExpiredInterrupted).toBe(true);
      expect(s.sessionExpiredCanView).toBe(true);
    });

    it('keeps the modal and withdraws "Continue viewing" on a cold load', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: false }),
        clearCache: () => {},
      });
      useAuthStore.getState().markSessionExpired();
      const s = useAuthStore.getState();
      expect(s.sessionExpiredReadOnly).toBe(false);
      expect(s.sessionExpiredCanView).toBe(false);
    });

    it('endReadOnlyViewing clears the cache and returns to a sign-in-only modal', () => {
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache,
      });
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().endReadOnlyViewing();
      const s = useAuthStore.getState();
      expect(clearCache).toHaveBeenCalledOnce();
      expect(s.sessionExpired).toBe(true);
      expect(s.sessionExpiredReadOnly).toBe(false);
      expect(s.sessionExpiredCanView).toBe(false);
    });

    it('endReadOnlyViewing does nothing when the session is fine', () => {
      const clearCache = vi.fn();
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache,
      });
      useAuthStore.getState().endReadOnlyViewing();
      expect(clearCache).not.toHaveBeenCalled();
    });

    // The window is anchored to when the session ENDED, and nothing may move it (#4313).
    it('records sessionEndedAt only on a fresh expiry; nothing afterwards moves it', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
      registerSessionBridge({
        inspect: () => ({ interrupted: false, hasContent: true }),
        clearCache: () => {},
      });
      useAuthStore.getState().setAccessToken('live');
      useAuthStore.getState().markSessionExpired();
      const endedAt = useAuthStore.getState().sessionEndedAt;
      expect(endedAt).toBe(Date.now());

      vi.advanceTimersByTime(60_000);
      useAuthStore.getState().markSessionExpired(); // a second 401 / a WS 4001
      useAuthStore.getState().enterReadOnlyMode(); // this tab's choice
      useAuthStore.getState().enterReadOnlyMode({ broadcast: false }); // a sibling's
      useAuthStore.getState().reassertSessionExpired();
      vi.runAllTimers();
      useAuthStore.getState().reassertSessionExpired(); // back to the modal
      useAuthStore.getState().enterReadOnlyMode();
      expect(useAuthStore.getState().sessionEndedAt).toBe(endedAt);
      vi.useRealTimers();
    });

    it('a second markSessionExpired does not re-open a modal the user already left', () => {
      useAuthStore.getState().setAccessToken('live');
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().enterReadOnlyMode();
      useAuthStore.getState().markSessionExpired();
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(true);
    });

    it('enterReadOnlyMode cannot bring the view back once the window lapsed', () => {
      registerSessionBridge({
        inspect: () => ({ interrupted: true, hasContent: true }),
        clearCache: () => {},
      });
      useAuthStore.getState().markSessionExpired();
      useAuthStore.getState().endReadOnlyViewing();
      useAuthStore.getState().enterReadOnlyMode({ broadcast: false });
      expect(useAuthStore.getState().sessionExpiredReadOnly).toBe(false);
      expect(useAuthStore.getState().sessionExpiredCanView).toBe(false);
    });

    it('exposes the view window as 15 minutes', () => {
      expect(READ_ONLY_VIEW_WINDOW_MS).toBe(15 * 60 * 1000);
    });
  });

  // #4296: which transitions tell sibling tabs.
  describe('cross-tab broadcast (#4296)', () => {
    it('broadcasts expiry, read-only, restore and an explicit sign-out', () => {
      const post = vi.spyOn(authBroadcast, 'postAuthMessage').mockImplementation(() => {});
      useAuthStore.getState().setAccessToken('a');
      expect(post).toHaveBeenLastCalledWith('restored');
      useAuthStore.getState().setAccessToken('b'); // a rotation, not news
      expect(post).toHaveBeenCalledTimes(1);
      useAuthStore.getState().markSessionExpired();
      expect(post).toHaveBeenLastCalledWith('expired');
      useAuthStore.getState().enterReadOnlyMode();
      expect(post).toHaveBeenLastCalledWith('readonly');
      useAuthStore.getState().setAccessToken('c');
      post.mockClear();
      useAuthStore.getState().clearTokens();
      expect(post).toHaveBeenCalledWith('cleared');
    });

    it("does not broadcast when applying a sibling tab's message, or when leaving an expired session", () => {
      const post = vi.spyOn(authBroadcast, 'postAuthMessage').mockImplementation(() => {});
      useAuthStore.getState().markSessionExpired({ broadcast: false });
      expect(post).not.toHaveBeenCalled();
      // The modal's "Sign in" clears tokens from an expired state: siblings stay put.
      useAuthStore.getState().clearTokens();
      expect(post).not.toHaveBeenCalled();
    });
  });
});
