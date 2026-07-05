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
import {
  CATEGORY_FILTERS,
  type NotificationCategory,
  type NotificationFilter,
  READ_STATE_FILTERS,
  notificationEmptyCopy,
} from '../shell/notificationFilters';
import { NotificationRow } from '../shell/NotificationRow';

export function NotificationListPage() {
  const [filter, setFilter] = useState<NotificationFilter>('unread');
  const [category, setCategory] = useState<NotificationCategory>('all');
  const { notifications, isLoading, error } = useNotifications({ filter, category });
  const markAllRead = useMarkAllRead();
  const [announce, setAnnounce] = useState<string>('');

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
          className="ml-auto text-xs border border-neutral-border rounded-control px-3 h-7 font-medium
            text-neutral-text-secondary hover:bg-neutral-surface-raised
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
            disabled:opacity-50"
        >
          Mark all read
        </button>
      </header>
      {/* Bulk-action announcement — drives screen-reader confirmation that
          Mark all read landed (rule WCAG 4.1.3). Visually hidden. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>

      <div
        role="tablist"
        aria-label="Filter notifications"
        className="flex gap-1 border-b border-neutral-border pb-2 overflow-x-auto"
      >
        {READ_STATE_FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={`text-xs px-3 h-7 font-medium border-b-2 whitespace-nowrap transition-colors
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                ${
                  active
                    ? 'border-brand-primary text-brand-primary'
                    : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary'
                }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Category selector — orthogonal to read-state (ADR-0216 §3). Radiogroup,
          not a tablist, so its "All" doesn't collide with the read-state "All". */}
      <div
        role="radiogroup"
        aria-label="Filter by category"
        className="flex gap-1 overflow-x-auto"
      >
        {CATEGORY_FILTERS.map((c) => {
          const active = category === c.value;
          return (
            <button
              key={c.value}
              role="radio"
              type="button"
              aria-checked={active}
              onClick={() => setCategory(c.value)}
              className={`text-xs px-3 h-7 rounded-control font-medium whitespace-nowrap transition-colors
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
                ${
                  active
                    ? 'bg-brand-primary/10 text-brand-primary'
                    : 'text-neutral-text-secondary hover:text-neutral-text-primary'
                }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {isLoading && (
        <div aria-busy="true" aria-label="Loading notifications" className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded-card border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-semantic-critical" role="alert">
          Couldn&apos;t load notifications.
        </p>
      )}

      {!isLoading && !error && sorted.length === 0 && (() => {
        const copy = notificationEmptyCopy(filter, category);
        return (
          <div className="flex flex-col items-center gap-1 py-12 text-center px-4">
            <span aria-hidden="true" className="text-3xl">
              {copy.emoji}
            </span>
            <p className="text-sm font-medium text-neutral-text-primary">{copy.title}</p>
            <p className="text-xs text-neutral-text-secondary">{copy.body}</p>
          </div>
        );
      })()}

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
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none rounded-control
          self-start"
      >
        Notification preferences →
      </Link>
    </main>
  );
}
