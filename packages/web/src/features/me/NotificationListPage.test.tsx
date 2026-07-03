import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import { NotificationListPage } from './NotificationListPage';

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

describe('NotificationListPage', () => {
  it('renders the empty state for the default unread filter', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationListPage />);
    expect(screen.getByText('No unread mentions. Caught up!')).toBeTruthy();
  });

  it('renders rows when notifications are present', () => {
    useNotificationsMock.mockReturnValue({
      notifications: [rowFactory()],
      isLoading: false,
      error: null,
    });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationListPage />);
    expect(screen.getByText(/Bob mentioned you/)).toBeTruthy();
  });

  // Filter-tab style drift fix (issue 576, rule 38): ViewTabs-family active
  // state is an underline, never a filled/bordered pill.
  it('renders filter tabs with underline active state, not pill', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationListPage />);

    const active = screen.getByRole('tab', { name: 'Unread' });
    expect(active.className).toContain('border-b-2');
    expect(active.className).toContain('border-brand-primary');
    expect(active.className).toContain('text-brand-primary');
    expect(active.className).not.toContain('bg-brand-primary/5');
    expect(active.className).not.toContain('rounded-control');

    const inactive = screen.getByRole('tab', { name: 'All' });
    expect(inactive.className).toContain('border-transparent');
    expect(inactive.className).not.toContain('border-neutral-border');
  });

  it('switches filter tabs and re-queries the hook', () => {
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    renderWithRouter(<NotificationListPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(useNotificationsMock).toHaveBeenLastCalledWith({ filter: 'archived' });
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(useNotificationsMock).toHaveBeenLastCalledWith({ filter: 'all' });
  });

  it('triggers Mark all read and announces the result', () => {
    type Opts = { onSuccess?: (data: { updated: number }) => void };
    const mutate = vi.fn((_arg: unknown, opts?: Opts) => {
      opts?.onSuccess?.({ updated: 2 });
    });
    useNotificationsMock.mockReturnValue({ notifications: [], isLoading: false, error: null });
    useMarkAllReadMock.mockReturnValue({ mutate, isPending: false });
    renderWithRouter(<NotificationListPage />);
    fireEvent.click(screen.getByText('Mark all read'));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('2 notifications marked read');
  });
});
