import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePrograms } from '@/hooks/usePrograms';
import { EmptyState } from '@/components/EmptyState';
import { QueryErrorState } from '@/components/QueryErrorState';
import { SearchIcon } from '@/components/Icons';
import { ProgramCard } from './ProgramCard';
import { NewProgramModal } from './NewProgramModal';
import { UngroupedProjectsSection } from './UngroupedProjectsSection';
import { ImportProgramButton } from './ImportProgramButton';
import { LoadSampleButton } from './LoadSampleButton';
import { ProgramSearchInput } from './ProgramSearchInput';
import { MethodologyFilter, type MethodologyFilterValue } from './MethodologyFilter';
import {
  PROGRAM_SORT_OPTIONS,
  filterAndSortPrograms,
  readPinnedFirstPref,
  readProgramSortPref,
  writePinnedFirstPref,
  writeProgramSortPref,
  type ProgramSortKey,
} from './programListSort';

/**
 * One group heading inside the program grid (#2390, design §5.2).
 *
 * A real `<h2>` so "Pinned · 3" is reachable by screen-reader rotor, wrapped in a
 * presentational `<li>` so it spans the grid without being counted as one of the
 * programs in the list.
 */
function GroupHeading({
  label,
  count,
  sortLabel,
}: {
  label: string;
  count: number;
  sortLabel: string;
}) {
  return (
    <li role="presentation" className="col-span-full flex items-baseline gap-2 pt-1">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        {label} <span className="tppm-mono">· {count}</span>
      </h2>
      <span className="text-xs text-neutral-text-secondary">
        sorted by {sortLabel.toLowerCase()}, like everything else
      </span>
    </li>
  );
}

/**
 * /programs — list of programs the current user is a member of (ADR-0070).
 *
 * Empty state hero introduces the concept and provides a single "create first
 * program" CTA. Otherwise renders a responsive card grid (1/2/3 columns) above a
 * header toolbar with an inline name filter, a methodology facet, and a sort
 * control (issue #1796). Filter/sort run entirely client-side over the
 * already-fetched list (it is small and fully fetched — no server pagination);
 * the sort choice persists per-browser in localStorage.
 *
 * Pinned programs are lifted into a labelled "Pinned · N" group above
 * "Everything else · N" (#2390, design §5.2) rather than floated silently inside
 * the sort, and that grouping is **deferred** — see `groupedPinnedIds` — so a
 * card never leaps out from under the pointer that just pinned it.
 */
export function ProgramListPage() {
  const { data: programs, isLoading, error, refetch } = usePrograms();
  // Pins are server-persisted per user (#2390) and ride along on each program
  // row, so grouping reads them from the list itself rather than from a separate
  // client store that could disagree with it.
  const livePinnedIds = useMemo(
    () => (programs ?? []).filter((p) => p.is_pinned).map((p) => p.id),
    [programs],
  );
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');
  const [methodology, setMethodology] = useState<MethodologyFilterValue>('ALL');
  const [sortKey, setSortKey] = useState<ProgramSortKey>(() => readProgramSortPref());
  const [pinnedFirst, setPinnedFirst] = useState<boolean>(() => readPinnedFirstPref());
  const navigate = useNavigate();
  const sortSelectId = useId();
  const pinnedFirstId = useId();

  /**
   * Grouping membership is **deferred**, never live (design §5.2).
   *
   * `groupedPinnedIds` is seeded once when the list first arrives and then held
   * still, so pinning a card marks it in place instead of teleporting it into
   * the Pinned group — which would slide the next card under a pointer that is
   * still traveling and turn every pin into a mis-click. The move lands on the
   * next visit to this page (the component remounts and re-seeds) or immediately
   * via the toast's "Re-sort now".
   */
  const [groupedPinnedIds, setGroupedPinnedIds] = useState<readonly string[]>(livePinnedIds);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !programs) return;
    seededRef.current = true;
    setGroupedPinnedIds(livePinnedIds);
  }, [programs, livePinnedIds]);

  const resort = useCallback(() => setGroupedPinnedIds(livePinnedIds), [livePinnedIds]);

  const hasPrograms = !isLoading && !error && !!programs && programs.length > 0;
  const isEmpty = !isLoading && !error && programs && programs.length === 0;

  const visible = useMemo(
    () => (programs ? filterAndSortPrograms(programs, { query, methodology, sortKey }) : []),
    [programs, query, methodology, sortKey],
  );

  // Searching flattens the groups (design §4.5): relevance ranking must never be
  // overridden by pin state mid-search.
  const hasActiveFilter = query.trim().length > 0 || methodology !== 'ALL';
  const grouped = pinnedFirst && !hasActiveFilter;
  const { pinnedVisible, restVisible } = useMemo(() => {
    if (!grouped) return { pinnedVisible: [], restVisible: visible };
    const ids = new Set(groupedPinnedIds);
    return {
      pinnedVisible: visible.filter((p) => ids.has(p.id)),
      restVisible: visible.filter((p) => !ids.has(p.id)),
    };
  }, [grouped, visible, groupedPinnedIds]);

  // An "Everything else" heading with nothing above it explains nothing, so the
  // groups appear only once there is at least one pinned card to separate out.
  const showGroups = grouped && pinnedVisible.length > 0;
  const sortLabel = PROGRAM_SORT_OPTIONS.find((o) => o.value === sortKey)?.label ?? '';

  const noMatches = hasPrograms && visible.length === 0;

  function handleSortChange(next: ProgramSortKey) {
    setSortKey(next);
    writeProgramSortPref(next);
  }

  function handlePinnedFirstChange(next: boolean) {
    setPinnedFirst(next);
    writePinnedFirstPref(next);
    // Turning grouping back on should reflect reality, not a stale snapshot.
    if (next) resort();
  }

  function clearFilters() {
    setQuery('');
    setMethodology('ALL');
  }

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-neutral-border px-6 py-4">
        <h1 className="text-lg font-semibold text-neutral-text-primary">Programs</h1>
        <div className="flex items-center gap-2">
          <LoadSampleButton variant="header" />
          <ImportProgramButton variant="header" />
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
              hover:bg-brand-primary/90
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + New program
          </button>
        </div>
      </header>

      {/* Filter / sort toolbar — only when there is a directory to scan (#1796). */}
      {hasPrograms && (
        <div className="flex flex-col gap-2 border-b border-neutral-border px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <ProgramSearchInput
              value={query}
              onChange={setQuery}
              resultCount={visible.length}
              totalCount={programs.length}
            />
            {/* The escape hatch (design §5.2): grouping off returns one flat list
                in pure sort order, pinned cards keeping their glyph. Sort and
                grouping are independent controls — neither silently overrides
                the other. */}
            <label
              htmlFor={pinnedFirstId}
              className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-neutral-text-secondary"
            >
              <input
                id={pinnedFirstId}
                type="checkbox"
                checked={pinnedFirst}
                onChange={(e) => handlePinnedFirstChange(e.target.checked)}
                className="h-4 w-4 rounded-control border-neutral-border text-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <span className="whitespace-nowrap">Pinned first</span>
            </label>
            <label
              htmlFor={sortSelectId}
              className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-text-secondary"
            >
              <span className="whitespace-nowrap">Sort</span>
              <select
                id={sortSelectId}
                value={sortKey}
                onChange={(e) => handleSortChange(e.target.value as ProgramSortKey)}
                className="h-9 appearance-none rounded-control border border-neutral-border bg-neutral-surface-raised
                  pl-2.5 pr-7 text-[13px] text-neutral-text-primary
                  hover:bg-neutral-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {PROGRAM_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <MethodologyFilter value={methodology} onChange={setMethodology} />
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-6">
        {isLoading && (
          <ul aria-label="Loading programs" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <li
                key={i}
                aria-hidden="true"
                className="h-32 motion-safe:animate-pulse rounded-card bg-neutral-surface-raised"
              />
            ))}
          </ul>
        )}

        {error && (
          <QueryErrorState
            variant="inline"
            message="Couldn't load programs."
            onRetry={() => void refetch()}
          />
        )}

        {isEmpty && (
          <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
            <h2 className="text-base font-semibold text-neutral-text-primary">
              Programs group related projects
            </h2>
            <p className="mt-2 text-sm text-neutral-text-secondary">
              Create a program when you&rsquo;re managing several related projects and want a shared
              backlog or combined burndown. New to TruePPM? Load the demo to explore a populated
              program.
            </p>
            <div className="mt-6 flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="h-10 rounded-control bg-brand-primary px-5 text-sm font-medium text-neutral-text-inverse
                  hover:bg-brand-primary/90
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                + Create your first program
              </button>
              <p className="text-xs text-neutral-text-secondary">or</p>
              <LoadSampleButton />
              <ImportProgramButton variant="hero" />
            </div>
          </div>
        )}

        {hasPrograms && (
          <>
            {noMatches ? (
              <EmptyState
                icon={SearchIcon}
                title="No programs match your filter"
                description="Try a different name, or clear the filter to see every program you belong to."
                action={
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-4 text-sm font-medium text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Clear filter
                  </button>
                }
              />
            ) : (
              <ul aria-label="Programs" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {/* Two labelled groups, not a silent float. Each heading carries
                    its count AND restates that the chosen sort still applies
                    inside it — without that, a 40m-ago card sitting below a
                    3d-ago card under a control reading "Recently active" is
                    indistinguishable from a broken sort. Headings live in
                    presentational <li>s so the grid keeps one row track and the
                    list keeps one accessible name. */}
                {showGroups && (
                  <GroupHeading label="Pinned" count={pinnedVisible.length} sortLabel={sortLabel} />
                )}
                {(showGroups ? pinnedVisible : []).map((p) => (
                  <ProgramCard key={p.id} program={p} onResort={resort} />
                ))}
                {showGroups && (
                  <GroupHeading
                    label="Everything else"
                    count={restVisible.length}
                    sortLabel={sortLabel}
                  />
                )}
                {restVisible.map((p) => (
                  <ProgramCard key={p.id} program={p} onResort={grouped ? resort : undefined} />
                ))}
              </ul>
            )}
            {/* Standalone projects that aren't in any program (ADR-0171, #697).
                Self-hides when there are none. Not affected by the directory filter —
                it is a separate "needs a home" surface. */}
            {!hasActiveFilter && <UngroupedProjectsSection />}
          </>
        )}
      </div>

      {showCreate && (
        <NewProgramModal
          onClose={() => setShowCreate(false)}
          onCreated={(programId) => {
            setShowCreate(false);
            void navigate(`/programs/${programId}/projects`);
          }}
        />
      )}
    </div>
  );
}
