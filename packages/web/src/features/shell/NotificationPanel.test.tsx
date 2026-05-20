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
});
