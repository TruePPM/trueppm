import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RateLimitDisabledBanner } from './RateLimitDisabledBanner';

// Mock the two data hooks so the banner's gating is exercised in isolation
// (mirrors OfflineBanner.test.tsx, which drives navigator.onLine directly).
const useCurrentUser = vi.fn();
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUser() as unknown,
}));

const useSystemHealth = vi.fn();
vi.mock('@/hooks/useSystemHealth', () => ({
  useSystemHealth: (opts?: unknown) => useSystemHealth(opts) as unknown,
}));

const admin = { can_access_admin_settings: true };
const nonAdmin = { can_access_admin_settings: false };

describe('RateLimitDisabledBanner (#2316)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the live region mounted but empty when rate limiting is enabled (#2203)', () => {
    // Persisted so switching to disabled injects text into an existing live node.
    useCurrentUser.mockReturnValue({ user: admin, isLoading: false });
    useSystemHealth.mockReturnValue({ data: { security: { rate_limiting_enabled: true } } });
    render(<RateLimitDisabledBanner />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('stays empty while the health query is loading — tri-state, no flash', () => {
    useCurrentUser.mockReturnValue({ user: admin, isLoading: false });
    useSystemHealth.mockReturnValue({ data: undefined });
    render(<RateLimitDisabledBanner />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('renders a critical status banner when rate limiting is disabled for an admin', () => {
    useCurrentUser.mockReturnValue({ user: admin, isLoading: false });
    useSystemHealth.mockReturnValue({ data: { security: { rate_limiting_enabled: false } } });
    render(<RateLimitDisabledBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent(/rate limiting is disabled/i);
    expect(banner).toHaveTextContent(/denial-of-service protection is\s+off/i);
    // Names the env var to re-enable it; does NOT offer an in-app control.
    expect(banner).toHaveTextContent(/TRUEPPM_RATE_LIMIT_ENABLED/);
    expect(banner.querySelector('a')).toBeNull();
  });

  it('gates the health fetch on admin (enabled:true only for admins)', () => {
    useCurrentUser.mockReturnValue({ user: admin, isLoading: false });
    useSystemHealth.mockReturnValue({ data: { security: { rate_limiting_enabled: true } } });
    render(<RateLimitDisabledBanner />);
    expect(useSystemHealth).toHaveBeenCalledWith({ poll: false, enabled: true });
  });

  it('never shows for a non-admin and skips the health fetch entirely', () => {
    useCurrentUser.mockReturnValue({ user: nonAdmin, isLoading: false });
    // Even if the endpoint somehow returned a disabled payload, a non-admin sees nothing.
    useSystemHealth.mockReturnValue({ data: { security: { rate_limiting_enabled: false } } });
    render(<RateLimitDisabledBanner />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    // enabled:false → react-query never issues the (guaranteed-403) request.
    expect(useSystemHealth).toHaveBeenCalledWith({ poll: false, enabled: false });
  });

  it('never shows for an anonymous / unresolved user', () => {
    useCurrentUser.mockReturnValue({ user: undefined, isLoading: true });
    useSystemHealth.mockReturnValue({ data: undefined });
    render(<RateLimitDisabledBanner />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(useSystemHealth).toHaveBeenCalledWith({ poll: false, enabled: false });
  });
});
