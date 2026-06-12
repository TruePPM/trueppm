import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import { NotificationPanel } from './NotificationPanel';

const useNotificationsMock = vi.hoisted(() => vi.fn());
const useMarkAllReadMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: useNotificationsMock,
  useMarkAllRead: useMarkAllReadMock,
  useUpdateNotification: () => ({ mutate: vi.fn(), isPending: false }),
}));

const rowFactory = (override = {}) => ({
  id: 'n1',
  recipient: 'u1',
  mention: {
    id: 'm1',
    mentioner: { id: 'u2', username: 'bob', display_name: 'Bob' },
    mentioned_user: { id: 'u1', username: 'alice', display_name: 'Alice' },
    mentioned_group_key: '',
    scope: 'individual',
    task_comment: 'c1',
    created_at: '2026-05-19T00:00:00Z',
  },
  event_type: '',
  subject: '',
  body: '',
  project: 'p1',
  is_read: false,
  is_archived: false,
  created_at: '2026-05-19T00:00:00Z',
  read_at: null,
  snippet: 'Take a look at this',
  task_id: 't1',
  ...override,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationPanel', () => {
  it('renders the loading state', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: true, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByLabelText('Loading notifications')).toBeTruthy();
  });

  it('renders the empty state copy for the unread filter', () => {
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByText('No unread mentions. Caught up!')).toBeTruthy();
  });

  it('renders the error state', () => {
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: new Error('boom'),
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load");
  });

  it('renders rows when notifications are present', () => {
    useNotificationsMock.mockReturnValue({
      notifications: [rowFactory()],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByText(/Bob mentioned you/)).toBeTruthy();
  });

  it('switches filter tabs and re-queries the hook', () => {
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(useNotificationsMock).toHaveBeenLastCalledWith({ filter: 'archived' });
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(useNotificationsMock).toHaveBeenLastCalledWith({ filter: 'all' });
  });

  it('triggers Mark all read and announces the result', () => {
    type Opts = { onSuccess?: (data: { updated: number }) => void };
    const mutate = vi.fn((_arg: unknown, opts?: Opts) => {
      opts?.onSuccess?.({ updated: 3 });
    });
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate, isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Mark all read'));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('3 notifications marked read');
  });

  it('announces empty result when Mark all read affects zero rows', () => {
    type Opts = { onSuccess?: (data: { updated: number }) => void };
    const mutate = vi.fn((_arg: unknown, opts?: Opts) => {
      opts?.onSuccess?.({ updated: 0 });
    });
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate, isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Mark all read'));
    expect(screen.getByRole('status').textContent).toContain('No unread notifications.');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    useNotificationsMock.mockReturnValue({
      notifications: [],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close notifications'));
    expect(onClose).toHaveBeenCalled();
  });

  // WAI-ARIA non-modal dialog pattern (#1031, WCAG 2.4.3).
  it('moves focus to the first control on open', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByText('Mark all read')).toHaveFocus();
  });

  it('restores focus to the trigger on close (WCAG 2.4.3)', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    // Stand-in for the bell trigger that has focus when the panel opens.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    expect(screen.getByText('Mark all read')).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  // Roving-tabindex arrow navigation across the filter tablist (#1022).
  it('navigates filter tabs with arrow keys and roves tabindex', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    const unread = screen.getByRole('tab', { name: 'Unread' });
    expect(unread).toHaveAttribute('aria-selected', 'true');
    expect(unread).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('tabindex', '-1');
    // FILTERS order is all, unread, archived → ArrowRight from unread selects archived.
    fireEvent.keyDown(unread, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true');
  });

  // WAI-ARIA tab pattern (#1022): the list is the tabpanel for the active filter.
  it('exposes the list as a tabpanel labelled by the active filter tab', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationPanel onClose={vi.fn()} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'notif-panel');
    // Default filter is "unread".
    expect(panel).toHaveAttribute('aria-labelledby', 'notif-tab-unread');
    for (const f of ['all', 'unread', 'archived']) {
      const tab = document.getElementById(`notif-tab-${f}`);
      expect(tab).toHaveAttribute('aria-controls', 'notif-panel');
    }
  });
});
