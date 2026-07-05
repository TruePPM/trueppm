/**
 * Shared notification filter definitions (ADR-0213 §4, #1558).
 *
 * The desktop slide-out (`NotificationPanel`) and the mobile route
 * (`NotificationListPage`) previously each declared their own `FILTERS` array,
 * which drifted. This is the single source of truth for BOTH the read-state
 * tabs (All / Unread / Archived / Snoozed) and the orthogonal category selector
 * (All / Mentions / Tasks / Signals / Project), plus the friendly empty-state
 * copy shown when a given (filter, category) combination has no rows.
 */

/** Read-state axis — mutually exclusive; drives which server list view loads. */
export type NotificationFilter = 'all' | 'unread' | 'archived' | 'snoozed';

/** Category axis — orthogonal to read-state; maps to the `?category=` filter. */
export type NotificationCategory = 'all' | 'mentions' | 'tasks' | 'signals' | 'project';

export const READ_STATE_FILTERS: { value: NotificationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'archived', label: 'Archived' },
  { value: 'snoozed', label: 'Snoozed' },
];

export const CATEGORY_FILTERS: { value: NotificationCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'signals', label: 'Signals' },
  { value: 'project', label: 'Project' },
];

/** Plain-noun label per category, used to compose category-scoped empty copy. */
const CATEGORY_EMPTY_NOUN: Record<Exclude<NotificationCategory, 'all'>, string> = {
  mentions: 'mentions',
  tasks: 'task updates',
  signals: 'schedule signals',
  project: 'project updates',
};

export interface EmptyCopy {
  /** Decorative glyph (aria-hidden at the call site). */
  emoji: string;
  title: string;
  body: string;
}

/**
 * Friendly empty-state copy for a (read-state, category) combination.
 *
 * Read-state takes precedence: `snoozed` and `archived` have their own copy
 * regardless of category. For `all`/`unread`, a non-`all` category yields
 * category-scoped copy; `all` category preserves the original @mention-flavored
 * strings (the panel's shipped "You're all caught up" / "No unread mentions
 * right now." copy the existing specs assert on).
 */
export function notificationEmptyCopy(
  filter: NotificationFilter,
  category: NotificationCategory,
): EmptyCopy {
  if (filter === 'snoozed') {
    return {
      emoji: '😴',
      title: 'Nothing snoozed',
      body: 'Notifications you snooze wait here until their time comes back around.',
    };
  }
  if (filter === 'archived') {
    return {
      emoji: '🗂️',
      title: 'Nothing archived yet',
      body: 'Archived notifications will collect here.',
    };
  }
  if (category !== 'all') {
    const noun = CATEGORY_EMPTY_NOUN[category];
    return {
      emoji: '🎉',
      title: "You're all caught up",
      body:
        filter === 'unread'
          ? `No unread ${noun} right now.`
          : `No ${noun} to show yet.`,
    };
  }
  if (filter === 'unread') {
    return {
      emoji: '🎉',
      title: "You're all caught up",
      body: 'No unread mentions right now.',
    };
  }
  return {
    emoji: '🎉',
    title: "You're all caught up",
    body: 'When someone @-mentions you, it shows up here.',
  };
}
