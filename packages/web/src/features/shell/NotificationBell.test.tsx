import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import { NotificationBell } from './NotificationBell';

const useUnreadMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useNotifications', () => ({
  useUnreadNotificationCount: useUnreadMock,
  // NotificationPanel imports these — return enough to render without crashing.
  useNotifications: () => ({ notifications: [], isLoading: false, error: null }),
  useMarkAllRead: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNotification: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: useCurrentUserMock }));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: DND off (no muted state) unless a test opts in.
  useCurrentUserMock.mockReturnValue({ user: { dnd_enabled: false }, isLoading: false });
  // Default desktop width
  Object.defineProperty(window, 'innerWidth', { writable: true, value: 1280 });
});

describe('NotificationBell', () => {
  it('renders an active bell (never a muted/slashed glyph) and the SR label when there are no unread', () => {
    useUnreadMock.mockReturnValue({ count: 0, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: 'Notifications' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // The bell is an inline SVG (BellIcon), not an emoji — the resting state must
    // not read as "notifications off" (#1707). No muted/slashed emoji glyph.
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.textContent).not.toContain('🔕');
    expect(button.textContent).not.toContain('🔔');
    // No count badge in the resting state (icon-only, no visible text).
    expect(button.textContent).toBe('');
  });

  it('shows the unread count badge when count > 0 (bell shape unchanged)', () => {
    useUnreadMock.mockReturnValue({ count: 3, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: 'Notifications, 3 unread' });
    // Same SVG bell as the resting state — unread is conveyed by the badge, not
    // by swapping the icon.
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.textContent).toContain('3');
  });

  it('caps the badge at 99+ when the count exceeds the threshold', () => {
    useUnreadMock.mockReturnValue({ count: 142, isLoading: false });
    renderWithRouter(<NotificationBell />);
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('opens the slide-out panel on desktop click', () => {
    useUnreadMock.mockReturnValue({ count: 1, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: /Notifications/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('navigates to /me/notifications on mobile click (< md)', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, value: 500 });
    useUnreadMock.mockReturnValue({ count: 1, isLoading: false });
    renderWithRouter(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(navigateMock).toHaveBeenCalledWith('/me/notifications');
  });

  it('closes the panel when Escape is pressed', () => {
    useUnreadMock.mockReturnValue({ count: 1, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: /Notifications/ });
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the panel on outside mousedown', () => {
    useUnreadMock.mockReturnValue({ count: 1, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: /Notifications/ });
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  // Do Not Disturb (#1707) — a real muted state (web-rule 240). The bell keeps
  // its active shape + count; a crescent moon chip is added, and the DND fact
  // lives in the aria-label so it is never signalled by color/glyph alone.
  it('shows the DND moon indicator and DND aria-label when dnd_enabled (0 unread)', () => {
    useUnreadMock.mockReturnValue({ count: 0, isLoading: false });
    useCurrentUserMock.mockReturnValue({ user: { dnd_enabled: true }, isLoading: false });
    renderWithRouter(<NotificationBell />);
    // aria-label states DND is on AND that the in-app inbox stays active.
    const button = screen.getByRole('button', {
      name: 'Notifications. Do Not Disturb on — email and push paused, in-app inbox still active',
    });
    // Two SVGs now: the (unchanged) bell + the added moon chip.
    expect(button.querySelectorAll('svg')).toHaveLength(2);
  });

  it('combines the unread count and the DND state in the label', () => {
    useUnreadMock.mockReturnValue({ count: 3, isLoading: false });
    useCurrentUserMock.mockReturnValue({ user: { dnd_enabled: true }, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', {
      name: 'Notifications, 3 unread. Do Not Disturb on — email and push paused, in-app inbox still active',
    });
    // Count badge still renders under DND (never downgraded to a bare dot).
    expect(button.textContent).toContain('3');
  });

  it('renders no moon chip and a plain label when DND is off', () => {
    useUnreadMock.mockReturnValue({ count: 2, isLoading: false });
    useCurrentUserMock.mockReturnValue({ user: { dnd_enabled: false }, isLoading: false });
    renderWithRouter(<NotificationBell />);
    const button = screen.getByRole('button', { name: 'Notifications, 2 unread' });
    // Only the bell SVG — no moon chip.
    expect(button.querySelectorAll('svg')).toHaveLength(1);
  });
});
