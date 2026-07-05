/**
 * Unified Assets surface (ADR-0215, #971) — a read-only, newest-first feed that
 * aggregates every task's files (`TaskAttachment`) and external links
 * (`TaskLink`) for a project, or across a program's readable member projects.
 *
 * Chip filters (kind / provider) + a debounced search box drive server-side
 * filtering; a flat chronological list is the default with a group-by-task
 * toggle. Pagination walks the stable opaque keyset cursor via TanStack Query's
 * infinite query ("Load more"). Rows reuse the #970 presentation primitives
 * (provider glyph, status badge, type chip, label pills) so the Assets surface
 * and the task drawer render links identically.
 */

import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { InboxIcon, SearchIcon } from '@/components/Icons';
import { FilterChip } from '@/features/programs/backlog/components/FilterChip';
import { formatRelative } from '@/lib/formatRelative';
import { safeExternalHref } from '@/lib/safeExternalHref';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import {
  isFileProvider,
  LabelPills,
  providerIcon,
  StatusBadge,
  TypeChip,
} from '@/components/linkPresentation';
import type { ExternalLinkStatus } from '@/lib/linkStatus';
import {
  ASSET_PROVIDERS,
  DEFAULT_ASSET_FILTERS,
  openAssetDownload,
  useProgramAssets,
  useProjectAssets,
  type AssetFilterState,
  type AssetItem,
  type AssetKind,
} from './useAssets';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

const KIND_OPTIONS: { value: AssetKind | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'file', label: 'Files' },
  { value: 'link', label: 'Links' },
];

type Scope = 'project' | 'program';

/** Shared Assets view. Both scope hooks are always called (rules of hooks); the
 *  inactive one is disabled by passing `undefined`, so only one fetches. */
function AssetsView({ scope }: { scope: Scope }) {
  const projectId = useProjectId();
  const programId = useProgramId();

  const [filters, setFilters] = useState<AssetFilterState>(DEFAULT_ASSET_FILTERS);
  const [groupByTask, setGroupByTask] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');

  // Debounce the search box → filters.q so each keystroke doesn't refetch.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilters((f) => (f.q === searchDraft ? f : { ...f, q: searchDraft }));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchDraft]);

  const projectQuery = useProjectAssets(scope === 'project' ? projectId : undefined, filters);
  const programQuery = useProgramAssets(scope === 'program' ? programId : undefined, filters);
  const query = scope === 'project' ? projectQuery : programQuery;

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const items = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

  const setKind = (kind: AssetKind | null) => setFilters((f) => ({ ...f, kind }));
  const toggleProvider = (provider: string) =>
    setFilters((f) => ({ ...f, provider: f.provider === provider ? null : provider }));

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-border px-4 py-3">
        <div className="flex items-center gap-2">
          <InboxIcon aria-hidden="true" className="h-4 w-4 text-neutral-text-secondary" />
          <h1 className="text-sm font-semibold text-neutral-text-primary">Assets</h1>
          {!isLoading && !isError && (
            <span className="text-xs text-neutral-text-secondary" aria-live="polite">
              {items.length}
              {hasNextPage ? '+' : ''} {items.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-neutral-text-secondary">
          <input
            type="checkbox"
            checked={groupByTask}
            onChange={(e) => setGroupByTask(e.target.checked)}
            className={`h-4 w-4 rounded border-neutral-border ${FOCUS_RING}`}
          />
          Group by task
        </label>
      </header>

      <div
        className="flex flex-wrap items-center gap-2 border-b border-neutral-border px-4 py-2"
        role="group"
        aria-label="Filter assets"
      >
        {KIND_OPTIONS.map((o) => (
          <FilterChip
            key={o.label}
            label={o.label}
            role="radio"
            aria-checked={filters.kind === o.value}
            active={filters.kind === o.value}
            onClick={() => setKind(o.value)}
          />
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
        {ASSET_PROVIDERS.map((p) => (
          <FilterChip
            key={p.value}
            label={p.label}
            role="checkbox"
            aria-checked={filters.provider === p.value}
            active={filters.provider === p.value}
            // Providers are a link-only concept — selecting one implies Links.
            onClick={() => {
              toggleProvider(p.value);
              if (filters.kind === 'file') setKind(null);
            }}
          />
        ))}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
        <div className="relative flex-1 min-w-[10rem] max-w-xs">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-text-secondary"
          />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search assets…"
            aria-label="Search assets"
            className={`h-8 w-full rounded-control border border-neutral-border bg-neutral-surface pl-7 pr-2 text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary ${FOCUS_RING}`}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AssetsBody
          items={items}
          isLoading={isLoading}
          isError={isError}
          groupByTask={groupByTask}
          scopeIsProgram={scope === 'program'}
        />
        {!isLoading && !isError && hasNextPage && (
          <div className="flex justify-center px-4 py-3">
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className={`inline-flex h-9 items-center rounded-control border border-neutral-border bg-neutral-surface px-4 text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised disabled:opacity-50 ${FOCUS_RING}`}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface AssetsBodyProps {
  items: AssetItem[];
  isLoading: boolean;
  isError: boolean;
  groupByTask: boolean;
  scopeIsProgram: boolean;
}

function AssetsBody({ items, isLoading, isError, groupByTask, scopeIsProgram }: AssetsBodyProps) {
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
        icon={InboxIcon}
        title="Couldn't load assets"
        description="Something went wrong fetching the feed. Try refreshing."
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={InboxIcon}
        title="No assets yet"
        description={
          scopeIsProgram
            ? "Files and links attached to tasks across this program's projects will appear here. Adjust the filters to widen the view."
            : 'Files and links attached to this project’s tasks will appear here. Adjust the filters to widen the view.'
        }
      />
    );
  }

  if (groupByTask) {
    const groups = groupItemsByTask(items);
    return (
      <div data-testid="assets-grouped">
        {groups.map((group) => (
          <section key={group.taskId} aria-label={`Assets for ${group.taskName}`}>
            <h2 className="sticky top-0 bg-neutral-surface-sunken px-4 py-1.5 text-xs font-medium text-neutral-text-secondary">
              {group.taskName}
            </h2>
            <ul className="divide-y divide-neutral-border">
              {group.items.map((item) => (
                <AssetRow key={item.id} item={item} showTask={false} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-border" data-testid="assets-list">
      {items.map((item) => (
        <AssetRow key={item.id} item={item} showTask />
      ))}
    </ul>
  );
}

interface AssetGroup {
  taskId: string;
  taskName: string;
  items: AssetItem[];
}

/** Group a chronological item list by owning task, preserving first-seen order. */
export function groupItemsByTask(items: AssetItem[]): AssetGroup[] {
  const order: string[] = [];
  const byTask = new Map<string, AssetGroup>();
  for (const item of items) {
    let group = byTask.get(item.task.id);
    if (!group) {
      group = { taskId: item.task.id, taskName: item.task.name, items: [] };
      byTask.set(item.task.id, group);
      order.push(item.task.id);
    }
    group.items.push(item);
  }
  return order.map((id) => byTask.get(id)!);
}

/** One asset row — a file or a link, rendered with the shared #970 primitives. */
function AssetRow({ item, showTask }: { item: AssetItem; showTask: boolean }) {
  const when = formatRelative(new Date(item.added_at));
  const glyph = item.kind === 'link' ? providerIcon(item.provider ?? 'generic') : '📎';
  const safeHref = item.url ? safeExternalHref(item.url) : null;

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-base flex-shrink-0" aria-hidden="true">
          {glyph}
        </span>
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`text-sm font-medium text-neutral-text-primary truncate hover:underline rounded-control ${FOCUS_RING}`}
          >
            {item.title || '(untitled)'}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        ) : item.download_url ? (
          <button
            type="button"
            onClick={() => void openAssetDownload(item.download_url as string)}
            className={`text-sm font-medium text-neutral-text-primary truncate hover:underline rounded-control text-left ${FOCUS_RING}`}
          >
            {item.title || '(untitled file)'}
            <span className="sr-only"> (download)</span>
          </button>
        ) : (
          <span className="text-sm font-medium text-neutral-text-secondary truncate">
            {item.title || '(untitled)'}
          </span>
        )}
        <span className="ml-auto flex-shrink-0">
          <AssetRightSlot item={item} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-text-secondary">
        {showTask && (
          <>
            <span className="truncate">{item.task.name}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>{item.added_by ? item.added_by.display_name : 'Added'}</span>
        <span aria-hidden="true">·</span>
        <span className="tppm-mono">{when}</span>
      </div>

      {item.kind === 'link' && item.labels.length > 0 && <LabelPills labels={item.labels} />}
    </li>
  );
}

/** Right-aligned slot: files get a neutral kind chip; links get a preview-type
 *  chip (cloud file) or a git status badge — mirroring the task drawer. */
function AssetRightSlot({ item }: { item: AssetItem }) {
  if (item.kind === 'file') {
    return (
      <span
        className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-neutral-text-secondary"
        aria-label="Asset type: file"
      >
        File
      </span>
    );
  }
  const provider = item.provider ?? 'generic';
  if (isFileProvider(provider)) {
    return item.preview_type ? <TypeChip type={item.preview_type} /> : null;
  }
  return (
    <StatusBadge status={(item.status ?? 'unknown') as ExternalLinkStatus} provider={provider} />
  );
}

/** Project scope: `GET /projects/{id}/assets/`. */
export function ProjectAssetsPage() {
  return <AssetsView scope="project" />;
}

/** Program scope: `GET /programs/{id}/assets/` across readable member projects. */
export function ProgramAssetsPage() {
  return <AssetsView scope="program" />;
}
