import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
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
      } as
        | {
            id: string;
            username: string;
            display_name: string;
            initials: string;
            email: string;
            can_access_admin_settings?: boolean;
            workspace_role?: number | null;
          }
        | undefined,
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

// The wildcard test route never populates the `:projectId` param, so mock the
// hook. Defaults to undefined (no project in context) to preserve the existing
// tests; the #2147 tests below set it to bring a project into scope.
const mockUseProjectId = vi.fn<() => string | undefined>(() => undefined);
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => mockUseProjectId(),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function openMenu() {
  const chips = screen.getAllByRole('button', { name: /account/i });
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
    // clearAllMocks wipes call history but not the implementation, so restore
    // the default "no project in context" between tests.
    mockUseProjectId.mockReturnValue(undefined);
  });

  it('renders initials "SC" in the avatar chip', () => {
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /account/i });
    expect(chips[0].textContent).toBe('SC');
  });

  it('the chip self-identifies: accessible name and tooltip include the user (#1792)', () => {
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: 'Account — Sarah Chen' });
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('title')).toBe('Account — Sarah Chen');
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
    const backdrop = document.querySelector('.fixed.inset-0.z-40[aria-hidden="true"]');
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

  it('the desktop dropdown is a non-modal dialog, not a menu (#2167)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // The desktop surface holds heterogeneous controls (theme/view toggle groups),
    // so it must be a dialog — a role="menu" advertised an arrow-roving keyboard
    // model it never implemented and made its non-menuitem children invalid.
    const dropdown = screen.getByTestId('user-menu-dropdown');
    expect(dropdown).toHaveAttribute('role', 'dialog');
    expect(dropdown).toHaveAttribute('aria-modal', 'false');
    expect(dropdown).toHaveAttribute('aria-label', 'User menu');
    // No row still claims the menuitem role anywhere in the tree.
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('the avatar chip advertises aria-haspopup="dialog" (#2167)', () => {
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /account/i });
    expect(chips[0]).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('seats focus inside the desktop dropdown on open (WCAG 2.4.3, rule 260, #2167)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    const dropdown = screen.getByTestId('user-menu-dropdown');
    // Focus must move into the dropdown (the old role="menu" never seated it).
    expect(dropdown.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('renders the "My Work" item linking to /me/work', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop + mobile variants render in JSDOM (CSS media queries not applied).
    const items = screen.getAllByRole('link', { name: /my work/i });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('href')).toBe('/me/work');
  });

  it('renders the "General" item linking to /me/settings/general (ADR-0129, #1181)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop + mobile variants render in JSDOM.
    const items = screen.getAllByRole('link', { name: /^General$/i });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('href')).toBe('/me/settings/general');
  });

  it('workspace admin → renders "Workspace settings" linking to /settings#members (#2033)', () => {
    mockUserResult.value = {
      user: {
        id: '1',
        username: 'sarah',
        display_name: 'Sarah Chen',
        initials: 'SC',
        email: 'sarah@example.com',
        can_access_admin_settings: true,
        // WorkspaceRole.ADMIN — the threshold RequireWorkspaceAdmin enforces (#2012).
        workspace_role: 300,
      },
      isLoading: false,
    };
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop + mobile variants render in JSDOM.
    const items = screen.getAllByRole('link', { name: /workspace settings/i });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('href')).toBe('/settings#members');
  });

  it('project-admin who is a plain workspace member → no "Workspace settings" row (RequireWorkspaceAdmin would bounce them, #2012)', () => {
    mockUserResult.value = {
      user: {
        id: '1',
        username: 'sarah',
        display_name: 'Sarah Chen',
        initials: 'SC',
        email: 'sarah@example.com',
        // can_access_admin_settings is true (admin of some project) but the
        // workspace role is below ADMIN — the exact #2012 profile.
        can_access_admin_settings: true,
        workspace_role: 100,
      },
      isLoading: false,
    };
    renderWithRouter(<UserMenu />);
    openMenu();
    expect(screen.queryByRole('link', { name: /workspace settings/i })).toBeNull();
  });

  it('project in context + admin → renders "Project settings" linking to the members section (#2147)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUserResult.value = {
      user: {
        id: '1',
        username: 'sarah',
        display_name: 'Sarah Chen',
        initials: 'SC',
        email: 'sarah@example.com',
        can_access_admin_settings: true,
      },
      isLoading: false,
    };
    renderWithRouter(<UserMenu />);
    openMenu();
    const items = screen.getAllByRole('link', { name: /project settings/i });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].getAttribute('href')).toBe('/projects/proj-1/settings/members');
  });

  it('project in context + non-admin → no "Project settings" row (RequireAdminSettings would bounce them, #2147)', () => {
    mockUseProjectId.mockReturnValue('proj-1');
    mockUserResult.value = {
      user: {
        id: '1',
        username: 'sarah',
        display_name: 'Sarah Chen',
        initials: 'SC',
        email: 'sarah@example.com',
        can_access_admin_settings: false,
      },
      isLoading: false,
    };
    renderWithRouter(<UserMenu />);
    openMenu();
    expect(screen.queryByRole('link', { name: /project settings/i })).toBeNull();
  });

  it('groups personal settings under a "Personal" header (design §10, #1804)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // Both desktop + mobile variants render in JSDOM.
    const groups = screen.getAllByRole('group', { name: 'Personal' });
    expect(groups.length).toBeGreaterThan(0);
    const items = within(groups[0]).getAllByRole('link');
    expect(items.map((i) => i.textContent)).toEqual([
      'General',
      'Notifications',
      'Connected accounts',
      'Personal access tokens',
    ]);
  });

  it('click "Sign out" → calls clearTokens() and queryClient.clear()', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // JSDOM renders both desktop and mobile variants — use the first match.
    const signOutBtns = screen.getAllByRole('button', { name: /sign out/i });
    fireEvent.click(signOutBtns[0]);
    expect(mockClearTokens).toHaveBeenCalledOnce();
    expect(mockQueryClientClear).toHaveBeenCalledOnce();
  });

  it('loading state → avatar shows skeleton with animate-pulse (no initials text)', () => {
    mockUserResult.value = { user: undefined, isLoading: true };
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: /account/i });
    expect(chips[0].className).toContain('animate-pulse');
    expect(chips[0].textContent).toBe('');
  });

  it('error state (isLoading false, user undefined) → neutral "··", never "?" (#1792)', () => {
    mockUserResult.value = { user: undefined, isLoading: false };
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: 'Account' });
    expect(chips[0].textContent).toBe('··');
    expect(chips[0].textContent).not.toContain('?');
  });

  it('email-only user → initials + accessible name derive from the email local-part (#1792)', () => {
    mockUserResult.value = {
      user: {
        id: '1',
        username: '',
        display_name: '',
        initials: '',
        email: 'kelly.hair@example.com',
      },
      isLoading: false,
    };
    renderWithRouter(<UserMenu />);
    const chips = screen.getAllByRole('button', { name: 'Account — kelly.hair' });
    expect(chips[0].textContent).toBe('KH');
  });

  it('theme toggle: clicking "Dark" calls setTheme("dark")', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    // JSDOM renders both desktop and mobile variants — use the first Dark mode button.
    const darkBtns = screen.getAllByRole('button', { name: /dark mode/i });
    fireEvent.click(darkBtns[0]);
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('pointerdown on a control inside the mobile sheet does not close the menu (#1679)', () => {
    // Regression: the document "click outside to close" handler only recognized
    // the desktop dropdown (menuRef) as inside — a pointerdown inside the mobile
    // bottom sheet was misclassified as an outside click, closed the sheet on
    // pointerdown, and the control's click never fired. Result: the mobile theme
    // switcher did nothing while the identical desktop dropdown worked. A plain
    // fireEvent.click (the existing test above) never dispatches the pointerdown,
    // so it did not catch this — the real pointer sequence must be simulated.
    renderWithRouter(<UserMenu />);
    openMenu();
    const sheet = screen.getByTestId('user-menu-sheet');
    const darkBtn = within(sheet).getByRole('button', { name: /dark mode/i });

    fireEvent.pointerDown(darkBtn);
    // The sheet must still be open after pointerdown lands on one of its controls.
    expect(screen.queryByTestId('user-menu-sheet')).not.toBeNull();

    fireEvent.click(darkBtn);
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  // Both surfaces are now role="dialog" (the desktop dropdown became a non-modal
  // dialog in #2167), so JSDOM renders two dialogs named "User menu" — target the
  // modal mobile sheet by its data-testid instead of getByRole('dialog').
  const TRAP_FOCUSABLES =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  it('traps Tab focus inside the mobile bottom sheet (Tab from last → first)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    const sheet = screen.getByTestId('user-menu-sheet');
    const focusables = sheet.querySelectorAll<HTMLElement>(TRAP_FOCUSABLES);
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('traps Shift+Tab focus inside the mobile bottom sheet (Shift+Tab from first → last)', () => {
    renderWithRouter(<UserMenu />);
    openMenu();
    const sheet = screen.getByTestId('user-menu-sheet');
    const focusables = sheet.querySelectorAll<HTMLElement>(TRAP_FOCUSABLES);
    const first = focusables[0];
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });
});
