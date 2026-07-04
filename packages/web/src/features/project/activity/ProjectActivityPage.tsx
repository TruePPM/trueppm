/**
 * Project Activity tab — the unified "what changed" changelog (ADR-0199, #371).
 *
 * A read-only, project-wide, newest-first stream aggregated across every
 * project-scoped historical table. Filter chips (object type, change type, date
 * range, user) drive server-side filtering; the URL search params are the filter
 * source of truth, so the view is deep-linkable (Copy link). Infinite scroll
 * pages the stable opaque keyset cursor via TanStack Query; clicking a row
 * navigates to the affected object.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ActivityIcon, LinkIcon } from '@/components/Icons';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/formatRelative';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectMembers } from '@/hooks/useProjectMembers';
import { FilterChip } from '@/features/programs/backlog/components/FilterChip';
import { clickThroughPath, filtersToSearchParams, searchParamsToFilters } from './changelogUrl';
import {
  CHANGE_TYPE_META,
  OBJECT_TYPE_META,
  useProjectChangelog,
  type ChangelogEntry,
  type ChangelogObjectType,
  type ChangeType,
  type TimeRange,
} from './useProjectChangelog';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

const OBJECT_TYPE_ORDER: ChangelogObjectType[] = [
  'task',
  'sprint',
  'risk',
  'dependency',
  'project',
];
const CHANGE_TYPE_ORDER: ChangeType[] = ['created', 'updated', 'deleted'];
const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export function ProjectActivityPage() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL search params are the filter source of truth (deep-linkable).
  const filters = useMemo(() => searchParamsToFilters(searchParams), [searchParams]);
  const { members } = useProjectMembers(projectId);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useProjectChangelog(projectId, filters);

  const entries = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

  const applyParams = useCallback(
    (next: URLSearchParams) => setSearchParams(next, { replace: true }),
    [setSearchParams],
  );

  const toggleObjectType = (t: ChangelogObjectType) => {
    const nextTypes = new Set(filters.objectTypes);
    if (nextTypes.has(t)) nextTypes.delete(t);
    else nextTypes.add(t);
    applyParams(filtersToSearchParams({ ...filters, objectTypes: nextTypes }));
  };

  const toggleChangeType = (c: ChangeType) => {
    const nextTypes = new Set(filters.changeTypes);
    if (nextTypes.has(c)) nextTypes.delete(c);
    else nextTypes.add(c);
    applyParams(filtersToSearchParams({ ...filters, changeTypes: nextTypes }));
  };

  const setRange = (range: TimeRange) =>
    applyParams(filtersToSearchParams({ ...filters, range }));

  const setUser = (userId: string | null) =>
    applyParams(filtersToSearchParams({ ...filters, userId }));

  // Infinite scroll: fetch the next page when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((observed) => {
      if (observed[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, entries.length]);

  const [copied, setCopied] = useState(false);
  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permissions) — no-op; the URL is
      // still copyable from the address bar.
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ActivityIcon aria-hidden="true" className="h-4 w-4 text-neutral-text-secondary" />
          <h1 className="text-sm font-semibold text-neutral-text-primary">Activity</h1>
        </div>
        <button
          type="button"
          onClick={() => void copyLink()}
          className={`inline-flex h-9 min-h-[44px] items-center gap-1.5 rounded-control border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised ${FOCUS_RING}`}
        >
          <LinkIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </header>

      <div
        className="flex flex-wrap items-center gap-2 border-b border-neutral-border px-4 py-2"
        role="group"
        aria-label="Filter activity"
      >
        {OBJECT_TYPE_ORDER.map((t) => (
          <FilterChip
            key={t}
            label={OBJECT_TYPE_META[t].label}
            role="checkbox"
            aria-checked={filters.objectTypes.has(t)}
            active={filters.objectTypes.has(t)}
            onClick={() => toggleObjectType(t)}
          />
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
        {CHANGE_TYPE_ORDER.map((c) => (
          <FilterChip
            key={c}
            label={CHANGE_TYPE_META[c].verb}
            role="checkbox"
            aria-checked={filters.changeTypes.has(c)}
            active={filters.changeTypes.has(c)}
            onClick={() => toggleChangeType(c)}
          />
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
        <label className="sr-only" htmlFor="activity-range">
          Date range
        </label>
        <select
          id="activity-range"
          value={filters.range}
          onChange={(e) => setRange(e.target.value as TimeRange)}
          className={`h-7 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-secondary ${FOCUS_RING}`}
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="activity-user">
          Filter by user
        </label>
        <select
          id="activity-user"
          value={filters.userId ?? ''}
          onChange={(e) => setUser(e.target.value || null)}
          className={`h-7 max-w-[10rem] rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-secondary ${FOCUS_RING}`}
        >
          <option value="">Anyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.username}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ActivityBody
          projectId={projectId}
          entries={entries}
          isLoading={isLoading}
          isError={isError}
          onNavigate={(entry) => {
            void navigate(clickThroughPath(projectId ?? '', entry));
          }}
        />
        <div ref={sentinelRef} aria-hidden="true" className="h-4" />
        {isFetchingNextPage && (
          <p className="px-4 py-3 text-center text-xs text-neutral-text-secondary" role="status">
            Loading more…
          </p>
        )}
      </div>
    </div>
  );
}

interface ActivityBodyProps {
  projectId: string | undefined;
  entries: ChangelogEntry[];
  isLoading: boolean;
  isError: boolean;
  onNavigate: (entry: ChangelogEntry) => void;
}

function ActivityBody({ entries, isLoading, isError, onNavigate }: ActivityBodyProps) {
  if (isLoading) {
    return (
      <ul className="divide-y divide-neutral-border" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="px-4 py-3">
            <div className="h-4 w-2/3 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
          </li>
        ))}
      </ul>
    );
  }
  if (isError) {
    return (
      <EmptyState
        icon={ActivityIcon}
        title="Couldn't load activity"
        description="Something went wrong fetching the changelog. Try refreshing."
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={ActivityIcon}
        title="No activity yet"
        description="Changes to tasks, sprints, risks, and project settings will appear here newest-first. Adjust the filters to widen the view."
      />
    );
  }
  return (
    <ul className="divide-y divide-neutral-border" data-testid="changelog-list">
      {entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} onNavigate={onNavigate} />
      ))}
    </ul>
  );
}

function ActivityRow({
  entry,
  onNavigate,
}: {
  entry: ChangelogEntry;
  onNavigate: (entry: ChangelogEntry) => void;
}) {
  const objectMeta = OBJECT_TYPE_META[entry.object_type];
  const changeMeta = CHANGE_TYPE_META[entry.change_type];
  const when = formatRelative(new Date(entry.history_date));
  const actor = entry.user?.display_name ?? 'System';

  return (
    <li>
      <button
        type="button"
        onClick={() => onNavigate(entry)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-neutral-surface-raised ${FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          className="mt-0.5 w-4 shrink-0 text-center text-sm text-neutral-text-secondary"
        >
          {objectMeta.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className={`font-medium ${changeMeta.tint}`}>{changeMeta.verb}</span>
            <span className="text-neutral-text-secondary">{objectMeta.label}</span>
            <span className="truncate font-medium text-neutral-text-primary">
              {entry.object_label}
            </span>
          </span>
          {entry.changes.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-neutral-text-secondary">
              {entry.changes.map((c) => c.field).join(', ')}
            </span>
          )}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-neutral-text-secondary">
          {actor} · <span className="tppm-mono">{when}</span>
        </span>
      </button>
    </li>
  );
}
