import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

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
});
