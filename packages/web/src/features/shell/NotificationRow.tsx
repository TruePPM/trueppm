/**
 * NotificationRow — single notification entry shown in both the slide-out
 * panel and the /me/notifications full-screen route (#311 phase 3).
 *
 * Click → navigate to source task; mark read on the way. Per-row [Mark read]
 * and [Archive] buttons keep the bulk actions discoverable.
 */

import { useNavigate } from 'react-router';
import {
  type NotificationRow as NotificationRowType,
  useUpdateNotification,
} from '@/hooks/useNotifications';
import { formatRelative } from '@/lib/formatRelative';

interface Props {
  notification: NotificationRowType;
  /** Called after the row navigates so the parent can close the slide-out panel. */
  onNavigate?: () => void;
}

export function NotificationRow({ notification, onNavigate }: Props) {
  const navigate = useNavigate();
  const update = useUpdateNotification();

  const mentioner = notification.mention?.mentioner?.display_name ?? 'Someone';
  const isGroup = !!notification.mention?.mentioned_group_key;
  const groupKey = notification.mention?.mentioned_group_key;
  const subject = isGroup ? `mentioned @${groupKey}` : 'mentioned you';
  const ts = formatRelative(new Date(notification.created_at));
  const snippet = notification.snippet || '(comment unavailable)';

  function handleNavigate() {
    if (!notification.is_read) {
      update.mutate({ id: notification.id, is_read: true });
    }
    if (notification.task_id) {
      void navigate(`/projects/${notification.project}/schedule?task=${notification.task_id}`);
    } else {
      void navigate(`/projects/${notification.project}/board`);
    }
    onNavigate?.();
  }

  function handleMarkRead() {
    update.mutate({ id: notification.id, is_read: !notification.is_read });
  }

  function handleArchive() {
    update.mutate({ id: notification.id, is_archived: true });
  }

  return (
    <article
      aria-label={`Mention by ${mentioner}, ${ts}${notification.is_read ? '' : ', unread'}`}
      className="flex flex-col gap-1 p-3 rounded border border-neutral-border bg-neutral-surface-raised"
    >
      <button
        type="button"
        onClick={handleNavigate}
        className="flex flex-col gap-1 text-left
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded"
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          {!notification.is_read && (
            <span
              aria-label="Unread"
              className="inline-block w-2 h-2 rounded-full bg-brand-primary flex-shrink-0"
            />
          )}
          <span className="text-sm font-medium text-neutral-text-primary">
            {mentioner} {subject}
          </span>
          <span className="text-xs text-neutral-text-secondary tppm-mono ml-auto">{ts}</span>
        </div>
        <p className="text-xs text-neutral-text-secondary truncate">{snippet}</p>
      </button>
      <div className="flex items-center gap-1 mt-1">
        <button
          type="button"
          onClick={handleMarkRead}
          disabled={update.isPending}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            rounded px-2 h-7
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
            disabled:opacity-50"
        >
          {notification.is_read ? 'Mark unread' : 'Mark read'}
        </button>
        {!notification.is_archived && (
          <button
            type="button"
            onClick={handleArchive}
            disabled={update.isPending}
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              rounded px-2 h-7
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50"
          >
            Archive
          </button>
        )}
      </div>
    </article>
  );
}
