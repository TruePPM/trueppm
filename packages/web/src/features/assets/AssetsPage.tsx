/**
 * Unified Assets surface (ADR-0215, issue 971) — a read-only, newest-first feed that
 * aggregates every task's files (`TaskAttachment`) and external links
 * (`TaskLink`) for a project, or across a program's readable member projects.
 *
 * Chip filters (kind / provider) + a debounced search box drive server-side
 * filtering; a flat chronological list is the default with a group-by-task
 * toggle. Pagination walks the stable opaque keyset cursor via TanStack Query's
 * infinite query ("Load more"). Rows reuse the issue 970 presentation primitives
 * (provider glyph, status badge, type chip, label pills) so the Assets surface
 * and the task drawer render links identically.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { InboxIcon, PaperclipIcon, SearchIcon } from '@/components/Icons';
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
  useMyAssets,
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

// Providers are mutually exclusive (the filter holds one value), so they belong
// in a radiogroup with an explicit "All providers" option — never role="checkbox"
// chips whose multi-select ARIA semantics contradict the single-value behavior
// (WCAG 4.1.2, #2177).
const PROVIDER_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: 'All providers' },
  ...ASSET_PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
];

type Scope = 'project' | 'program' | 'me';

interface ChipOption<V extends string | null> {
  value: V;
  label: string;
}

/**
 * Single-select facet filter built as an accessible radiogroup (WCAG 2.1.1 /
 * 4.1.2, rule 167) — the house pattern shared with RiskSegmentedFilter.
 *
 * Roving tabindex: only the focused option is tabbable. Arrow / Home / End move
 * DOM focus without committing; the filter applies on activation (click / Enter /
 * Space via the native button), so a keyboard user can scan segments without
 * firing a filter on every passing option.
 */
function ChipRadioGroup<V extends string | null>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly ChipOption<V>[];
  value: V;
  onChange: (value: V) => void;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIdx = options.findIndex((o) => o.value === value);
  const [focusIdx, setFocusIdx] = useState(selectedIdx >= 0 ? selectedIdx : 0);
  useEffect(() => {
    if (selectedIdx >= 0) setFocusIdx(selectedIdx);
  }, [selectedIdx]);

  function moveFocus(next: number) {
    const i = Math.max(0, Math.min(options.length - 1, next));
    setFocusIdx(i);
    btnRefs.current[i]?.focus(); // focus only — commit happens on activation
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(focusIdx + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(focusIdx - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        moveFocus(options.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-wrap items-center gap-2"
    >
      {options.map((o, i) => (
        <FilterChip
          key={String(o.value)}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          label={o.label}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === focusIdx ? 0 : -1}
          active={o.value === value}
          // Meet the 44px touch floor on mobile, relaxing to the compact 32px
          // toolbar height on md+ (mirrors RiskSegmentedFilter, rule 167).
          className="min-h-[44px] md:min-h-[32px]"
          onClick={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

/** Shared Assets view. All scope hooks are always called (rules of hooks); the
 *  inactive ones are disabled (undefined id / enabled:false), so only one fetches.
 *  `me` is the personal cross-project tier — `GET /assets/?mine=true` (ADR-0428). */
function AssetsView({ scope }: { scope: Scope }) {
  const projectId = useProjectId();
  const programId = useProgramId();
  const isMe = scope === 'me';

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
  const myQuery = useMyAssets(filters, isMe);
  const query = scope === 'project' ? projectQuery : scope === 'program' ? programQuery : myQuery;

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    query;
  const items = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

  const setKind = (kind: AssetKind | null) => setFilters((f) => ({ ...f, kind }));
  // Providers are a link-only concept — selecting one clears a conflicting
  // Files-only kind filter so the two facets can't produce an empty impossible
  // intersection. "All providers" (null) leaves kind untouched.
  const setProvider = (provider: string | null) =>
    setFilters((f) => ({
      ...f,
      provider,
      kind: provider !== null && f.kind === 'file' ? null : f.kind,
    }));

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-border px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {isMe ? (
              <PaperclipIcon aria-hidden="true" className="h-4 w-4 text-neutral-text-secondary" />
            ) : (
              <InboxIcon aria-hidden="true" className="h-4 w-4 text-neutral-text-secondary" />
            )}
            <h1 className="text-sm font-semibold text-neutral-text-primary">
              {isMe ? 'My Assets' : 'Assets'}
            </h1>
            {!isLoading && !isError && (
              <span className="text-xs text-neutral-text-secondary" aria-live="polite">
                {items.length}
                {hasNextPage ? '+' : ''} {items.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>
          {isMe && (
            <p className="text-xs text-neutral-text-secondary">
              Files and links on tasks assigned to you.
            </p>
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
        <ChipRadioGroup
          label="Filter by kind"
          options={KIND_OPTIONS}
          value={filters.kind}
          onChange={setKind}
        />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-neutral-border" />
        <ChipRadioGroup
          label="Filter by provider"
          options={PROVIDER_OPTIONS}
          value={filters.provider}
          onChange={setProvider}
        />
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
          onRetry={() => void refetch()}
          groupByTask={groupByTask}
          scope={scope}
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
  onRetry: () => void;
  groupByTask: boolean;
  scope: Scope;
}

function AssetsBody({ items, isLoading, isError, onRetry, groupByTask, scope }: AssetsBodyProps) {
  const isMe = scope === 'me';
  const loadingLabel = isMe ? 'Loading your assets…' : 'Loading assets…';
  if (isLoading) {
    return (
      <ul
        className="divide-y divide-neutral-border"
        role="status"
        aria-label={loadingLabel}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i} className="px-4 py-3" aria-hidden="true">
            <div className="h-4 w-2/3 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
          </li>
        ))}
      </ul>
    );
  }
  if (isError) {
    // A dead feed on a primary surface is an assertive, retry-able failure —
    // never an empty state that reads as "nothing here yet" (rule 246, #1764).
    return (
      <QueryErrorState
        message={isMe ? "Couldn't load your assets." : "Couldn't load assets."}
        onRetry={onRetry}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={isMe ? PaperclipIcon : InboxIcon}
        title={isMe ? 'No assets on your tasks yet' : 'No assets yet'}
        description={emptyDescription(scope)}
      />
    );
  }

  // Cross-project ("me") tier: each row needs its own project context because the
  // list spans projects; the nested tiers show it implicitly.
  const showProject = isMe;

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
                <AssetRow key={item.id} item={item} showTask={false} showProject={showProject} />
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
        <AssetRow key={item.id} item={item} showTask showProject={showProject} />
      ))}
    </ul>
  );
}

function emptyDescription(scope: Scope): string {
  if (scope === 'me') {
    return 'Files and links added to tasks assigned to you will show up here. Adjust the filters to widen the view.';
  }
  if (scope === 'program') {
    return "Files and links attached to tasks across this program's projects will appear here. Adjust the filters to widen the view.";
  }
  return 'Files and links attached to this project’s tasks will appear here. Adjust the filters to widen the view.';
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

/** Hostname for a link asset's meta line. The house kind-glyph (#1748) no longer
 *  differentiates provider on the Assets surface, which — unlike the task-drawer
 *  sections — does not otherwise render the host, so the provider identity is
 *  carried here as text instead. Unparseable URLs fall back to a neutral label. */
function assetLinkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'external link';
  }
}

/** One asset row — a file or a link, rendered with the shared issue 970 primitives. */
function AssetRow({
  item,
  showTask,
  showProject = false,
}: {
  item: AssetItem;
  showTask: boolean;
  showProject?: boolean;
}) {
  const when = formatRelative(new Date(item.added_at));
  // Links render a house provider kind-mark (#1748); uploaded attachments render
  // the paperclip mark — never an emoji, matching the drawer sections.
  const glyph =
    item.kind === 'link' ? (
      providerIcon(item.provider ?? 'generic')
    ) : (
      <PaperclipIcon className="h-4 w-4 text-neutral-text-secondary" aria-hidden="true" />
    );
  const safeHref = item.url ? safeExternalHref(item.url) : null;

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-start gap-2 min-w-0">
        <span className="flex-shrink-0" aria-hidden="true">
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
        {showProject && (
          <>
            {item.program && (
              <span className="hidden truncate text-neutral-text-secondary lg:inline">
                {item.program.name} /
              </span>
            )}
            <span className="truncate font-medium text-neutral-text-primary">
              {item.project.name}
            </span>
            <span aria-hidden="true">·</span>
          </>
        )}
        {showTask && (
          <>
            <span className="truncate">{item.task.name}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        {item.kind === 'link' && item.url && (
          <>
            <span className="truncate tppm-mono">{assetLinkHost(item.url)}</span>
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

/** Personal scope: `GET /assets/?mine=true` — files and links on the current
 *  user's assigned tasks, across every project they can read (ADR-0428). */
export function MyAssetsPage() {
  return <AssetsView scope="me" />;
}
