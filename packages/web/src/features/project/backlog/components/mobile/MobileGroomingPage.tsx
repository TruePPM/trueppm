/**
 * Mobile grooming shell (< md) for the PO product backlog (issue 1044).
 *
 * A distinct component, not a responsive squeeze of the dense desktop table
 * (the table's grid exceeds a phone's width — the gap this closes). Each story
 * is a card grouped under its epic; the quick-add and the story drawer rise as
 * full-screen bottom sheets. Shares the grooming query + mutations with the
 * desktop layout through the TanStack Query cache (same projectId key), so the
 * two never diverge and there is no double-fetch.
 */

import { useEffect, useRef, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/Button';
import { PlusIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import type { Task } from '@/types';
import { filterBacklog } from '../../filter';
import { useGroomingFilters } from '../../hooks/useGroomingFilters';
import {
  useProductBacklog,
  useQuickAddStory,
  useSetDor,
} from '../../hooks/useProductBacklog';
import { DOR_FILTER_ORDER, DorFilterChip, ToggleChip } from '../GroomingFilterChips';
import { GroomingSearchInput } from '../GroomingSearchInput';
import { StoryDetailDrawer } from '../StoryDetailDrawer';
import { MobileGroomingCard } from './MobileGroomingCard';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

function HealthStat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="flex shrink-0 flex-col">
      <span className={`font-mono text-sm font-bold tabular-nums ${tone ?? 'text-neutral-text-primary'}`}>
        {value}
      </span>
      <span className="whitespace-nowrap text-xs text-neutral-text-secondary">{label}</span>
    </div>
  );
}

export function MobileGroomingPage() {
  const projectId = useProjectId();
  const itl = useIterationLabel(projectId);
  const { data, isLoading, isError } = useProductBacklog(projectId);
  const setDor = useSetDor(projectId);
  const quickAdd = useQuickAddStory(projectId);
  const canManageBacklog = useCanManageBacklog(projectId);
  const filterCtl = useGroomingFilters();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Focus the quick-add title when the sheet opens (jsx-a11y forbids autoFocus; a
  // ref + effect is the sanctioned equivalent, mirroring StoryDetailDrawer).
  const quickAddRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!quickAddOpen) return undefined;
    const t = setTimeout(() => quickAddRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [quickAddOpen]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col bg-app-canvas">
        <div className="border-b border-neutral-border bg-neutral-surface-raised px-4 py-3">
          <div aria-hidden className="h-3 w-28 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken" />
          <div aria-hidden className="mt-2 h-5 w-24 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken" />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-neutral-text-secondary">Loading backlog…</span>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center bg-app-canvas p-6 text-center text-sm text-semantic-critical">
        Could not load the product backlog.
      </div>
    );
  }

  const backlog = data;
  const { health } = backlog;
  const allStories: Task[] = [...backlog.epics.flatMap((g) => g.stories), ...backlog.ungrouped];
  const allEmpty = allStories.length === 0;
  const selectedStory = selectedId == null ? null : (allStories.find((s) => s.id === selectedId) ?? null);

  const filtered = filterBacklog(backlog, filterCtl.filters);
  const filterActive = filterCtl.active;
  const totalCount = allStories.length;
  const matchCount = filterActive ? filtered.matchCount : totalCount;

  function toggleDor(story: Task) {
    setDor.mutate({ taskId: story.id, dor: story.dor === 'ready' ? 'refine' : 'ready' });
  }

  function submitQuickAdd() {
    const name = draft.trim();
    if (!name) return;
    quickAdd.mutate(
      { name },
      {
        onSuccess: () => {
          setDraft('');
          setQuickAddOpen(false);
        },
      },
    );
  }

  const dorTone = health.dorPct >= 80 ? 'text-semantic-on-track' : 'text-semantic-at-risk';

  return (
    <div className="flex h-full flex-col bg-app-canvas">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-neutral-border bg-neutral-surface-raised px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-text-secondary">
            Grooming
          </div>
          <h1 className="text-base font-bold text-neutral-text-primary">Product backlog</h1>
        </div>
        {canManageBacklog && (
          <button
            type="button"
            onClick={() => setQuickAddOpen(true)}
            aria-label="Add story"
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary text-neutral-text-inverse ${FOCUS_RING}`}
          >
            <PlusIcon aria-hidden className="h-4 w-4" />
          </button>
        )}
      </header>

      {allEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <h2 className="text-base font-semibold text-neutral-text-primary">
            The product backlog is empty
          </h2>
          <p className="mt-2 max-w-[300px] text-xs text-neutral-text-secondary">
            Add a story to start grooming, or pull items from the program backlog.
          </p>
        </div>
      ) : (
        <>
          {/* Condensed health summary */}
          <div className="flex gap-5 overflow-x-auto border-b border-neutral-border px-4 py-2">
            <HealthStat value={`${health.dorPct}%`} label="Ready (DoR)" tone={dorTone} />
            <HealthStat
              value={`${health.readyPoints}${health.capacityPoints != null ? `/${health.capacityPoints}` : ''}`}
              label={`Ready ${itl.lower} pts`}
            />
            <HealthStat value={`${health.unestimated}`} label="Unestimated" />
          </div>

          {/* Filter toolbar */}
          <div className="space-y-2 border-b border-neutral-border px-4 py-2.5">
            <GroomingSearchInput
              value={filterCtl.filters.query}
              onChange={filterCtl.setQuery}
              resultCount={matchCount}
              totalCount={totalCount}
              fullWidth
            />
            <div
              role="group"
              aria-label="Filter by readiness"
              className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5"
            >
              {DOR_FILTER_ORDER.map((dor) => (
                <DorFilterChip
                  key={dor}
                  dor={dor}
                  size="md"
                  active={filterCtl.filters.dorStates.includes(dor)}
                  onClick={() => filterCtl.toggleDor(dor)}
                />
              ))}
              <ToggleChip
                label="Unestimated"
                size="md"
                active={filterCtl.filters.unestimatedOnly}
                onClick={() => filterCtl.setUnestimatedOnly(!filterCtl.filters.unestimatedOnly)}
              />
            </div>
          </div>

          {/* Card list */}
          <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
            {filterActive && matchCount === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <p className="text-sm text-neutral-text-secondary">No stories match your filters.</p>
                <Button variant="secondary" size="sm" onClick={filterCtl.reset}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <>
                {filtered.epics.map((group) => (
                  <section key={group.epic.id} aria-label={group.epic.name}>
                    <div className="flex items-center justify-between px-1 py-1">
                      <h2 className="truncate text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
                        {group.epic.name}
                      </h2>
                      <span className="shrink-0 font-mono text-xs text-neutral-text-secondary">
                        {group.stories.length} · {group.rollup.pointsTotal} pts
                      </span>
                    </div>
                    <div className="space-y-2">
                      {group.stories.map((s) => (
                        <MobileGroomingCard
                          key={s.id}
                          story={s}
                          onOpen={() => setSelectedId(s.id)}
                          onToggleDor={() => toggleDor(s)}
                        />
                      ))}
                    </div>
                  </section>
                ))}

                {filtered.ungrouped.length > 0 && (
                  <section aria-label="No epic">
                    <div className="flex items-center px-1 py-1">
                      <h2 className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
                        No epic
                      </h2>
                    </div>
                    <div className="space-y-2">
                      {filtered.ungrouped.map((s) => (
                        <MobileGroomingCard
                          key={s.id}
                          story={s}
                          onOpen={() => setSelectedId(s.id)}
                          onToggleDor={() => toggleDor(s)}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Quick-add sheet */}
      <BottomSheet
        isOpen={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        ariaLabel="Add a story"
        size="full"
      >
        <div className="flex h-full flex-col gap-4 px-4 pb-[env(safe-area-inset-bottom)] pt-2">
          <h2 className="text-sm font-semibold text-neutral-text-primary">Add a story</h2>
          <input
            ref={quickAddRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitQuickAdd();
              }
            }}
            placeholder="Story title…"
            aria-label="Story title"
            className={`h-11 rounded-control border border-neutral-border bg-neutral-surface px-3 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary ${FOCUS_RING}`}
          />
          {quickAdd.isError && (
            <p role="alert" className="text-xs text-semantic-critical">
              Couldn&apos;t add the story — try again.
            </p>
          )}
          <Button
            variant="primary"
            size="md"
            onClick={submitQuickAdd}
            disabled={!draft.trim() || quickAdd.isPending}
          >
            {quickAdd.isPending ? 'Adding…' : 'Add story'}
          </Button>
        </div>
      </BottomSheet>

      {/* Story drawer — the shared drawer renders as a full-height sheet at this breakpoint. */}
      {selectedStory && (
        <StoryDetailDrawer
          key={selectedStory.id}
          projectId={projectId as string}
          story={selectedStory}
          backlog={backlog}
          canManageBacklog={canManageBacklog}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
