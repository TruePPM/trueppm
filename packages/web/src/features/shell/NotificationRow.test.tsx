import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '@/test/utils';
import { NotificationRow } from './NotificationRow';

const mutateMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useNotifications', () => ({
  useUpdateNotification: () => ({ mutate: mutateMock, isPending: false }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

function row(overrides = {}) {
  return {
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
    snippet: 'Take a look',
    task_id: 't1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NotificationRow', () => {
  it('renders mention text and snippet for an individual mention', () => {
    renderWithRouter(<NotificationRow notification={row()} />);
    expect(screen.getByText('Bob mentioned you')).toBeTruthy();
    expect(screen.getByText('Take a look')).toBeTruthy();
  });

  it('renders the group-mention variant when mentioned_group_key is set', () => {
    renderWithRouter(
      <NotificationRow
        notification={row({
          mention: { ...row().mention, mentioned_group_key: 'team' },
        })}
      />,
    );
    expect(screen.getByText('Bob mentioned @team')).toBeTruthy();
  });

  it('falls back to "Someone" when mention author is missing', () => {
    renderWithRouter(
      <NotificationRow notification={row({ mention: null })} />,
    );
    expect(screen.getByText(/Someone mentioned you/)).toBeTruthy();
  });

  it('falls back to placeholder snippet when comment is unavailable', () => {
    renderWithRouter(
      <NotificationRow notification={row({ snippet: '' })} />,
    );
    expect(screen.getByText('(comment unavailable)')).toBeTruthy();
  });

  it('navigates to the source task and marks read on row click', () => {
    const onNavigate = vi.fn();
    renderWithRouter(
      <NotificationRow notification={row()} onNavigate={onNavigate} />,
    );
    fireEvent.click(screen.getByText('Bob mentioned you'));
    expect(mutateMock).toHaveBeenCalledWith({ id: 'n1', is_read: true });
    expect(navigateMock).toHaveBeenCalledWith(
      '/projects/p1/schedule?task=t1',
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it('navigates to the project board when task_id is missing', () => {
    renderWithRouter(
      <NotificationRow notification={row({ task_id: null })} />,
    );
    fireEvent.click(screen.getByText('Bob mentioned you'));
    expect(navigateMock).toHaveBeenCalledWith('/projects/p1/board');
  });

  it('does not call PATCH on click when already read', () => {
    renderWithRouter(
      <NotificationRow notification={row({ is_read: true })} />,
    );
    fireEvent.click(screen.getByText('Bob mentioned you'));
    expect(mutateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ is_read: true }),
    );
  });

  it('toggles read state via the Mark unread / Mark read button', () => {
    const { rerender } = renderWithRouter(
      <NotificationRow notification={row()} />,
    );
    fireEvent.click(screen.getByText('Mark read'));
    expect(mutateMock).toHaveBeenLastCalledWith({ id: 'n1', is_read: true });

    rerender(<NotificationRow notification={row({ is_read: true })} />);
    fireEvent.click(screen.getByText('Mark unread'));
    expect(mutateMock).toHaveBeenLastCalledWith({ id: 'n1', is_read: false });
  });

  it('archives via the Archive button (only visible when not archived)', () => {
    renderWithRouter(<NotificationRow notification={row()} />);
    fireEvent.click(screen.getByText('Archive'));
    expect(mutateMock).toHaveBeenLastCalledWith({ id: 'n1', is_archived: true });
  });

  it('hides the Archive button when the row is already archived', () => {
    renderWithRouter(
      <NotificationRow notification={row({ is_archived: true })} />,
    );
    expect(screen.queryByText('Archive')).toBeNull();
  });
});
