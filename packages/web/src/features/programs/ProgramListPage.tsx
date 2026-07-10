import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePrograms } from '@/hooks/usePrograms';
import { useShellStore } from '@/stores/shellStore';
import { EmptyState } from '@/components/EmptyState';
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
  readProgramSortPref,
  writeProgramSortPref,
  type ProgramSortKey,
} from './programListSort';

/**
 * /programs — list of programs the current user is a member of (ADR-0070).
 *
 * Empty state hero introduces the concept and provides a single "create first
 * program" CTA. Otherwise renders a responsive card grid (1/2/3 columns) above a
 * header toolbar with an inline name filter, a methodology facet, and a sort
 * control (issue #1796). Filter/sort run entirely client-side over the
 * already-fetched list (it is small and fully fetched — no server pagination);
 * the sort choice persists per-browser in localStorage. Order is deliberate:
 * pinned programs float to the top of every sort, then the chosen key.
 */
export function ProgramListPage() {
  const { data: programs, isLoading, error } = usePrograms();
  const pinnedProgramIds = useShellStore((s) => s.pinnedProgramIds);
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');
  const [methodology, setMethodology] = useState<MethodologyFilterValue>('ALL');
  const [sortKey, setSortKey] = useState<ProgramSortKey>(() => readProgramSortPref());
  const navigate = useNavigate();
  const sortSelectId = useId();

  const hasPrograms = !isLoading && !error && !!programs && programs.length > 0;
  const isEmpty = !isLoading && !error && programs && programs.length === 0;

  const visible = useMemo(
    () =>
      programs
        ? filterAndSortPrograms(programs, {
            query,
            methodology,
            sortKey,
            pinnedIds: pinnedProgramIds,
          })
        : [],
    [programs, query, methodology, sortKey, pinnedProgramIds],
  );

  const hasActiveFilter = query.trim().length > 0 || methodology !== 'ALL';
  const noMatches = hasPrograms && visible.length === 0;

  function handleSortChange(next: ProgramSortKey) {
    setSortKey(next);
    writeProgramSortPref(next);
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
            className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
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
            <label
              htmlFor={sortSelectId}
              className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-neutral-text-secondary"
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
          {/* Deliberate default order is announced so the ordering never reads as
              arbitrary (rule 6/7): pinned programs always lead. */}
          <p className="text-xs text-neutral-text-secondary">Pinned programs shown first.</p>
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
          <p role="alert" className="text-sm text-semantic-critical">
            Failed to load programs — please refresh.
          </p>
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
                className="h-10 rounded-control bg-brand-primary px-5 text-sm font-medium text-white
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
                {visible.map((p) => (
                  <ProgramCard key={p.id} program={p} />
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
