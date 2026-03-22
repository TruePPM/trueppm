import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clearTokens();
  });

  it('starts unauthenticated with null tokens', () => {
    const { accessToken, refreshToken, isAuthenticated } = useAuthStore.getState();
    expect(accessToken).toBeNull();
    expect(refreshToken).toBeNull();
    expect(isAuthenticated).toBe(false);
  });

  it('setTokens authenticates the user', () => {
    useAuthStore.getState().setTokens('access-abc', 'refresh-xyz');
    const { accessToken, refreshToken, isAuthenticated } = useAuthStore.getState();
    expect(accessToken).toBe('access-abc');
    expect(refreshToken).toBe('refresh-xyz');
    expect(isAuthenticated).toBe(true);
  });

  it('clearTokens resets to unauthenticated state', () => {
    useAuthStore.getState().setTokens('access-abc', 'refresh-xyz');
    useAuthStore.getState().clearTokens();
    const { accessToken, refreshToken, isAuthenticated } = useAuthStore.getState();
    expect(accessToken).toBeNull();
    expect(refreshToken).toBeNull();
    expect(isAuthenticated).toBe(false);
  });
});
