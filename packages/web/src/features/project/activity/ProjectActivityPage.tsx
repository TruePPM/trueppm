/**
 * Project Activity tab — the project's "what happened here" surface.
 *
 * Two sub-views behind a segmented control (#2481, ADR-0677):
 *
 * - **Changes** (default) — the unified changelog (ADR-0201, issue 371): a
 *   read-only, project-wide, newest-first stream aggregated across every
 *   project-scoped historical table. Filter chips (object type, change type, date
 *   range, user) drive server-side filtering; the URL search params are the filter
 *   source of truth, so the view is deep-linkable (Copy link). Infinite scroll
 *   pages the stable opaque keyset cursor via TanStack Query; clicking a row
 *   navigates to the affected object.
 * - **Agents** — the team-facing read of the hash-chained `AgentAction` log
 *   (ADR-0112/0421) scoped to this project.
 *
 * The two are separate queries and separate components on purpose: an agent
 * *read* changed nothing, and folding it into the changelog would render it as
 * though it had.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ActivityIcon, LinkIcon } from '@/components/Icons';
import { EmptyState } from '@/components/EmptyState';
import { formatRelative } from '@/lib/formatRelative';
import { useElementRef } from '@/hooks/useElementRef';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjectMembers } from '@/hooks/useProjectMembers';
import { FilterChip } from '@/features/programs/backlog/components/FilterChip';
import { clickThroughPath, filtersToSearchParams, searchParamsToFilters } from './changelogUrl';
import { ActivitySubViewTabs } from './ActivitySubViewTabs';
import { ProjectAgentActivity } from './ProjectAgentActivity';
import {
  AGENT_RANGES,
  agentParams,
  agentRangeFromParams,
  refusalsOnlyFromParams,
  subViewFromParams,
  type ActivitySubView,
  type AgentRange,
} from './agentActivityUrl';
import {
  CHANGE_TYPE_META,
  OBJECT_TYPE_META,
  useProjectChangelog,
  type ChangelogEntry,
  type ChangelogObjectType,
  type ChangeType,
  type TimeRange,
} from './useProjectChangelog';

/** Form fields (the range / user selects) — browsers always match `:focus-visible`
 *  on an editable control, and a persistent ring on a field is noise (rule 4). */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/** Standalone buttons and list rows — `focus:`, because Firefox and desktop Safari
 *  withhold `:focus-visible` on pointer-initiated focus of a button, leaving these
 *  controls with no visible focus after a click (rule 214). */
const FOCUS_RING_BUTTON =
  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1';

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

  // Sub-view state (ADR-0677). `changes` is the parameterless default, so every
  // Activity link written before #2481 resolves exactly as it did.
  const subView = subViewFromParams(searchParams);
  const refusalsOnly = refusalsOnlyFromParams(searchParams);
  const agentRange = agentRangeFromParams(searchParams);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useProjectChangelog(projectId, filters, subView === 'changes');

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

  const setRange = (range: TimeRange) => applyParams(filtersToSearchParams({ ...filters, range }));

  const setUser = (userId: string | null) =>
    applyParams(filtersToSearchParams({ ...filters, userId }));

  // Switching sub-views swaps the whole param set rather than merging: the
  // changelog's chips (`type`/`change`/`user`/`range`) cannot be applied to an
  // agent action, and carrying them across would narrow a feed by filters the
  // visible controls no longer show (ADR-0677).
  const setSubView = (next: ActivitySubView) =>
    applyParams(
      next === 'agents'
        ? agentParams({ refusalsOnly: false, range: agentRange })
        : filtersToSearchParams(filters),
    );

  const setRefusalsOnly = (next: boolean) =>
    applyParams(agentParams({ refusalsOnly: next, range: agentRange }));

  const setAgentRange = (next: AgentRange) =>
    applyParams(agentParams({ refusalsOnly, range: next }));

  // Infinite scroll: fetch the next page when the sentinel scrolls into view.
  // The sentinel unmounts while the Agents sub-view is showing, so the node must
  // be state, not a `RefObject` — an effect keyed on `.current` would not re-run
  // when it remounts and infinite scroll would be silently dead on return
  // (web-rule 279, #2365).
  const { el: sentinelEl, setEl: setSentinelEl } = useElementRef<HTMLDivElement>();
  useEffect(() => {
    if (!sentinelEl || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((observed) => {
      if (observed[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  }, [sentinelEl, hasNextPage, isFetchingNextPage, fetchNextPage, entries.length]);

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
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <ActivityIcon aria-hidden="true" className="h-4 w-4 text-neutral-text-secondary" />
            <h1 className="text-sm font-semibold text-neutral-text-primary">Activity</h1>
          </div>
          <ActivitySubViewTabs view={subView} onChange={setSubView} />
        </div>
        <button
          type="button"
          onClick={() => void copyLink()}
          className={`inline-flex h-9 min-h-[44px] items-center gap-1.5 rounded-control border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised ${FOCUS_RING_BUTTON}`}
        >
          <LinkIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </header>

      {/* The band persists across sub-views and swaps its contents, so switching
          never shifts the feed vertically. The changelog's per-user select is
          deliberately absent on Agents: an AgentAction's actor is a token
          principal, not a project member, so a member list could never match. */}
      {subView === 'agents' ? (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-neutral-border px-4 py-2"
          role="group"
          aria-label="Filter agent activity"
        >
          <FilterChip
            label="Refusals only"
            role="checkbox"
            aria-checked={refusalsOnly}
            active={refusalsOnly}
            onClick={() => setRefusalsOnly(!refusalsOnly)}
          />
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
          <label className="sr-only" htmlFor="agent-activity-range">
            Agent activity date range
          </label>
          <select
            id="agent-activity-range"
            value={agentRange}
            onChange={(e) => setAgentRange(e.target.value as AgentRange)}
            className={`h-7 rounded-control border border-neutral-border bg-neutral-surface px-2 text-xs text-neutral-text-secondary ${FOCUS_RING}`}
          >
            {AGENT_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
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
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {subView === 'agents' ? (
          <ProjectAgentActivity
            projectId={projectId}
            refusalsOnly={refusalsOnly}
            range={agentRange}
          />
        ) : (
          <>
            <ActivityBody
              projectId={projectId}
              entries={entries}
              isLoading={isLoading}
              isError={isError}
              onNavigate={(entry) => {
                void navigate(clickThroughPath(projectId ?? '', entry));
              }}
            />
            <div ref={setSentinelEl} aria-hidden="true" className="h-4" />
            {isFetchingNextPage && (
              <p
                className="px-4 py-3 text-center text-xs text-neutral-text-secondary"
                role="status"
              >
                Loading more…
              </p>
            )}
          </>
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
        className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-neutral-surface-raised ${FOCUS_RING_BUTTON}`}
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
