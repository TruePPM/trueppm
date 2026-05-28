/**
 * NotificationPanel — desktop slide-out for the unread inbox (#311 phase 3).
 *
 * Right-anchored, 420px wide on md+, non-modal so it doesn't trap global
 * focus. Mobile (<md) navigates to /me/notifications instead — see
 * NotificationBell.handleClick.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMarkAllRead, useNotifications } from '@/hooks/useNotifications';
import { NotificationRow } from './NotificationRow';

type Filter = 'all' | 'unread' | 'archived';

interface Props {
  onClose: () => void;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
];

export function NotificationPanel({ onClose }: Props) {
  const [filter, setFilter] = useState<Filter>('unread');
  const { notifications, isLoading, error } = useNotifications({ filter });
  const markAllRead = useMarkAllRead();
  const [announce, setAnnounce] = useState<string>('');

  const sorted = useMemo(
    () => [...notifications].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [notifications],
  );

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="My mentions"
      className="absolute top-full right-0 mt-2 z-50 w-[380px] lg:w-[420px]
        max-h-[80vh] flex flex-col
        bg-neutral-surface border border-neutral-border rounded"
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-neutral-border">
        <h2 className="text-sm font-semibold text-neutral-text-primary">My mentions</h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              markAllRead.mutate(undefined, {
                onSuccess: ({ updated }) =>
                  setAnnounce(
                    updated === 0
                      ? 'No unread notifications.'
                      : `${updated} notification${updated === 1 ? '' : 's'} marked read.`,
                  ),
              })
            }
            disabled={markAllRead.isPending}
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              rounded px-2 h-7
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
              disabled:opacity-50"
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notifications"
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              rounded px-2 h-7
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div
        role="tablist"
        aria-label="Filter notifications"
        className="flex gap-1 px-3 py-2 border-b border-neutral-border"
      >
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={`text-xs px-2 h-7 rounded border
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                ${
                  active
                    ? 'border-brand-primary text-brand-primary bg-brand-primary/5'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-raised'
                }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Bulk-action announcement — drives screen-reader confirmation that
          Mark all read landed (rule WCAG 4.1.3). Visually hidden. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading && (
          <div aria-busy="true" aria-label="Loading notifications" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
              />
            ))}
          </div>
        )}
        {error && (
          <p className="text-sm text-semantic-critical" role="alert">
            Couldn&apos;t load notifications.
          </p>
        )}
        {!isLoading && !error && sorted.length === 0 && (
          <p className="text-sm text-neutral-text-secondary px-1">
            {filter === 'unread' && 'No unread mentions. Caught up!'}
            {filter === 'archived' && 'Nothing archived yet.'}
            {filter === 'all' && 'When someone @-mentions you, it shows up here.'}
          </p>
        )}
        {!isLoading && !error && sorted.length > 0 && (
          <div className="flex flex-col gap-2">
            {sorted.map((n) => (
              <NotificationRow key={n.id} notification={n} onNavigate={onClose} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-neutral-border p-3">
        <Link
          to="/me/settings/notifications"
          onClick={onClose}
          className="text-xs text-brand-primary underline-offset-2 hover:underline
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded"
        >
          Notification preferences →
        </Link>
      </div>
    </aside>
  );
}
