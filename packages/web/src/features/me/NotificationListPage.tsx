/**
 * NotificationListPage — full-screen route for the notification inbox.
 *
 * Primary surface on mobile (<md) where the slide-out panel doesn't scale,
 * and a secondary entry point on desktop for users who prefer a route over
 * the bell click. Mirrors the panel's filter tabs + bulk action + row shape.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMarkAllRead, useNotifications } from '@/hooks/useNotifications';
import { NotificationRow } from '../shell/NotificationRow';

type Filter = 'all' | 'unread' | 'archived';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
];

export function NotificationListPage() {
  const [filter, setFilter] = useState<Filter>('unread');
  const { notifications, isLoading, error } = useNotifications({ filter });
  const markAllRead = useMarkAllRead();

  const sorted = useMemo(
    () => [...notifications].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [notifications],
  );

  return (
    <main aria-label="My mentions" className="flex flex-col gap-4 p-6 max-w-3xl mx-auto">
      <header className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold text-neutral-text-primary">My mentions</h1>
        <button
          type="button"
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending}
          className="ml-auto text-xs border border-neutral-border rounded px-3 h-7 font-medium
            text-neutral-text-secondary hover:bg-neutral-surface-raised
            focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
            disabled:opacity-50"
        >
          Mark all read
        </button>
      </header>

      <div role="tablist" aria-label="Filter notifications" className="flex gap-1 border-b border-neutral-border pb-2">
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={`text-xs px-3 h-7 rounded border
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none
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

      {isLoading && (
        <div aria-busy="true" aria-label="Loading notifications" className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded border border-neutral-border animate-pulse bg-neutral-surface-raised"
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
        <p className="text-sm text-neutral-text-secondary">
          {filter === 'unread' && 'No unread mentions. Caught up!'}
          {filter === 'archived' && 'Nothing archived yet.'}
          {filter === 'all' && 'When someone @-mentions you, it shows up here.'}
        </p>
      )}

      {!isLoading && !error && sorted.length > 0 && (
        <ol className="flex flex-col gap-2 list-none p-0">
          {sorted.map((n) => (
            <li key={n.id} className="list-none">
              <NotificationRow notification={n} />
            </li>
          ))}
        </ol>
      )}

      <Link
        to="/me/settings/notifications"
        className="text-xs text-brand-primary underline-offset-2 hover:underline
          focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded
          self-start"
      >
        Notification preferences →
      </Link>
    </main>
  );
}
