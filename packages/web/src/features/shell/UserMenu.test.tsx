import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import { UserMenu } from './UserMenu';

// ---------------------------------------------------------------------------
// vi.hoisted() — runs before vi.mock hoisting, so these values are available
// inside the factory closures without TDZ errors.
// ---------------------------------------------------------------------------

const { mockClearTokens, mockQueryClientClear, mockSetTheme, mockUserResult } = vi.hoisted(() => {
  const mockClearTokens = vi.fn();
  const mockQueryClientClear = vi.fn();
  const mockSetTheme = vi.fn();

  const mockUserResult = {
    value: {
      user: {
        id: '1',
        username: 'sarah',
        display_name: 'Sarah Chen',
        initials: 'SC',
        email: 'sarah@example.com',
      } as { id: string; username: string; display_name: string; initials: string; email: string } | undefined,
      isLoading: false,
    },
  };

  return { mockClearTokens, mockQueryClientClear, mockSetTheme, mockUserResult };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUserResult.value,
}));

vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { clearTokens: () => void }) => unknown) =>
    selector({ clearTokens: mockClearTokens }),
}));

vi.mock('@/lib/queryClient', () => ({
  queryClient: { clear: mockQueryClientClear },
}));

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: (selector: (s: { theme: string; setTheme: (t: string) => void }) => unknown) =>
    selector({ theme: 'light', setTheme: mockSetTheme }),
}));

// Mock useNavigate to avoid react-router AbortSignal cross-realm errors in JSDOM.
const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function openMenu() {
  const chips = screen.getAllByRole('button', { name: /user menu/i });
  fireEvent.click(chips[0]);
}

function resetUser() {
  mockUserResult.value = {
    user: {
      id: '1',
      username: 'sarah',
      display_name: 'Sarah Chen',
      initials: 'SC',
      email: 'sarah@example.com',
    },
    isLoading: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUser();
  });

  it('renders initials "SC" in the avatar chip', () => {
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /user menu/i });
    expect(chips[0].textContent).toBe('SC');
  });

  it('click chip → dropdown content is visible (shows display name)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop and mobile variants render in JSDOM (CSS media queries not applied).
    const matches = screen.getAllByText('Sarah Chen');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('click outside (backdrop) → mobile bottom-sheet closes', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Verify content is visible (both desktop + mobile render in JSDOM).
    expect(screen.getAllByText('Sarah Chen').length).toBeGreaterThan(0);
    // Click the mobile backdrop (fixed inset-0 z-40 aria-hidden div).
    const backdrop = document.querySelector(
      '.fixed.inset-0.z-40[aria-hidden="true"]',
    );
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    // After close, no "Sarah Chen" text should remain in the DOM.
    expect(screen.queryByText('Sarah Chen')).toBeNull();
  });

  it('Escape key → dropdown closes', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    expect(screen.getAllByText('Sarah Chen').length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Sarah Chen')).toBeNull();
  });

  it('renders the "My Work" menu item linking to /me/work', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop + mobile variants render in JSDOM (CSS media queries not applied).
    const items = screen.getAllByRole('menuitem', { name: /my work/i });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('href')).toBe('/me/work');
  });

  it('click "Sign out" → calls clearTokens() and queryClient.clear()', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // JSDOM renders both desktop and mobile variants — use the first match.
    const signOutBtns = screen.getAllByRole('menuitem', { name: /sign out/i });
    fireEvent.click(signOutBtns[0]);
    expect(mockClearTokens).toHaveBeenCalledOnce();
    expect(mockQueryClientClear).toHaveBeenCalledOnce();
  });

  it('loading state → avatar shows skeleton with animate-pulse (no initials text)', () => {
    mockUserResult.value = { user: undefined, isLoading: true };
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /user menu/i });
    expect(chips[0].className).toContain('animate-pulse');
    expect(chips[0].textContent).toBe('');
  });

  it('error state (isLoading false, user undefined) → "?" in avatar', () => {
    mockUserResult.value = { user: undefined, isLoading: false };
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /user menu/i });
    expect(chips[0].textContent).toBe('?');
  });

  it('theme toggle: clicking "Dark" calls setTheme("dark")', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // JSDOM renders both desktop and mobile variants — use the first Dark mode button.
    const darkBtns = screen.getAllByRole('button', { name: /dark mode/i });
    fireEvent.click(darkBtns[0]);
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });
});
