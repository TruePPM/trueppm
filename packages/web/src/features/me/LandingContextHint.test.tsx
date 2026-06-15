import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { LandingContextHint, resolveLandingHint } from './LandingContextHint';
import { LANDING_HINT_SEEN_KEY, LANDING_FALLBACK_NOTICE_SEEN_KEY } from './landing';

const useCurrentUser = vi.fn();

vi.mock('@/hooks/useCurrentUser', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useCurrentUser')>('@/hooks/useCurrentUser');
  return { ...actual, useCurrentUser: () => useCurrentUser() as unknown };
});

function userWith(resolvedBy: string, intent: string, defaultLanding: string) {
  return {
    user: {
      id: 'u1',
      default_landing: defaultLanding,
      landing: { intent, path: '/me/work', resolved_by: resolvedBy },
    },
    isLoading: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  useCurrentUser.mockReset();
});

describe('resolveLandingHint — seen-key gating (ADR-0129, #1181)', () => {
  it('shows role_policy when not yet seen for this intent', () => {
    expect(resolveLandingHint('role_policy', 'my_work', 'auto')).toBe('role_policy');
  });

  it('suppresses role_policy once seen for the SAME intent', () => {
    localStorage.setItem(LANDING_HINT_SEEN_KEY, 'my_work');
    expect(resolveLandingHint('role_policy', 'my_work', 'auto')).toBeNull();
  });

  it('still shows role_policy for a DIFFERENT intent after seeing another', () => {
    localStorage.setItem(LANDING_HINT_SEEN_KEY, 'my_work');
    expect(resolveLandingHint('role_policy', 'project_overview', 'auto')).toBe('role_policy');
  });

  it('shows fallback only when a concrete preference was set', () => {
    expect(resolveLandingHint('fallback', 'my_work', 'project_overview')).toBe('fallback');
    expect(resolveLandingHint('fallback', 'my_work', 'auto')).toBeNull();
  });

  it('suppresses fallback once its own key is set', () => {
    localStorage.setItem(LANDING_FALLBACK_NOTICE_SEEN_KEY, '1');
    expect(resolveLandingHint('fallback', 'my_work', 'project_overview')).toBeNull();
  });

  it('shows nothing for a preference-resolved landing', () => {
    expect(resolveLandingHint('preference', 'my_work', 'my_work')).toBeNull();
  });
});

describe('LandingContextHint — render + dismiss', () => {
  it('renders the role_policy copy and a Settings link', () => {
    useCurrentUser.mockReturnValue(userWith('role_policy', 'my_work', 'auto'));
    renderWithRouter(<LandingContextHint />);
    expect(screen.getByRole('status')).toHaveTextContent(/opens here based on your role/i);
    expect(screen.getByRole('link', { name: /Change your home in Settings/i })).toHaveAttribute(
      'href',
      '/me/settings/general',
    );
  });

  it('renders the fallback copy when the saved home was unreachable', () => {
    useCurrentUser.mockReturnValue(userWith('fallback', 'my_work', 'project_overview'));
    renderWithRouter(<LandingContextHint />);
    expect(screen.getByRole('status')).toHaveTextContent(/saved home isn't available/i);
  });

  it('persists the seen key on dismiss and hides the strip', () => {
    useCurrentUser.mockReturnValue(userWith('role_policy', 'my_work', 'auto'));
    renderWithRouter(<LandingContextHint />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(localStorage.getItem(LANDING_HINT_SEEN_KEY)).toBe('my_work');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing for a preference-resolved landing', () => {
    useCurrentUser.mockReturnValue(userWith('preference', 'my_work', 'my_work'));
    const { container } = renderWithRouter(<LandingContextHint />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
