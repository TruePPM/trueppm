/**
 * Product backlog / grooming view (ADR-0105 + ADR-0110, #494/#921/#922).
 *
 * The PO's priority-ordered backlog: stories grouped under epics, each carrying a
 * Definition-of-Ready chip, an acceptance-criteria meter, the active model's score, and
 * points; a grooming-health strip; and a "next-sprint ready line" drawn where the cumulative
 * ready points reach the active sprint's capacity.
 *
 * Interactions:
 * - Drag a row by its handle to reorder priority (ADR-0110). Drag is scoped within an epic
 *   group (and within the ungrouped section) — rank-only, never reparenting — and the full
 *   global order is persisted on drop. A concurrent change by another PO returns 409: we snap
 *   back to the server order and show a reload notice.
 * - The score column renders the active prioritization model's computed score (#922); it is
 *   hidden when the project has no model. Auto-rank sorts by score; a manual drag then wins.
 * - The bottom input quick-adds a title-only story (#921): Enter commits and keeps focus, Esc
 *   clears. New stories land at the bottom of the backlog.
 * - Clicking a DoR chip toggles ready/refine (the server enforces the readiness gate).
 *
 * Rendered against the navy/sage design-system tokens.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isAxiosError } from 'axios';
import { Button } from '@/components/Button';
import { useProjectId } from '@/hooks/useProjectId';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import type { Task } from '@/types';
import type { ReorderEntry } from './api';
import { AcMeter, DorChip } from './components/atoms';
import { StoryDetailDrawer } from './components/StoryDetailDrawer';
import { TypeBadge } from './components/TypeBadge';
import {
  useAutoRank,
  useProductBacklog,
  useQuickAddStory,
  useReorderBacklog,
  useSetDor,
} from './hooks/useProductBacklog';
import type { EpicGroup, GroomingHealth, ProductBacklog } from './types';

/** Row grid; the score column is present only when the project has a prioritization model. */
function gridCols(hasScore: boolean): string {
  return hasScore
    ? 'grid grid-cols-[44px_56px_1fr_120px_84px_56px_44px] items-center gap-2.5'
    : 'grid grid-cols-[44px_56px_1fr_120px_84px_44px] items-center gap-2.5';
}

function GroomStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'onTrack' | 'atRisk';
}) {
  const valueColor =
    tone === 'onTrack'
      ? 'text-semantic-on-track'
      : tone === 'atRisk'
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-primary';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        {label}
      </span>
      <span className={`font-mono text-lg font-bold tabular-nums ${valueColor}`}>{value}</span>
      <span className="text-xs text-neutral-text-secondary">{sub}</span>
    </div>
  );
}

function HealthStrip({ health, iterationLower }: { health: GroomingHealth; iterationLower: string }) {
  const dorTone = health.dorPct >= 80 ? 'onTrack' : 'atRisk';
  return (
    <div className="flex flex-wrap items-center gap-x-10 gap-y-3 border-b border-neutral-border bg-neutral-surface-raised px-6 py-3.5">
      <GroomStat
        label="Definition of Ready"
        value={`${health.dorPct}%`}
        sub={`${health.readyCount} of ${health.storyCount} stories ready`}
        tone={dorTone}
      />
      <GroomStat
        label={`Ready for next ${iterationLower}`}
        value={`${health.readyPoints}`}
        sub={
          health.capacityPoints != null
            ? `${health.readyPoints} of ${health.capacityPoints} pts capacity`
            : `no active ${iterationLower} capacity`
        }
      />
      <GroomStat
        label="Unestimated"
        value={`${health.unestimated}`}
        sub={health.unestimated === 0 ? 'all stories pointed' : 'need an estimate'}
        tone={health.unestimated === 0 ? 'onTrack' : undefined}
      />
      <GroomStat
        label="Acceptance criteria"
        value={`${health.acMet}/${health.acTotal}`}
        sub="met across backlog"
      />
    </div>
  );
}

function StoryRow({
  story,
  hasScore,
  selected,
  onToggleDor,
  onOpen,
}: {
  story: Task;
  hasScore: boolean;
  selected: boolean;
  onToggleDor: (story: Task) => void;
  onOpen: (story: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const overSized = (story.storyPoints ?? 0) >= 8;
  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`Open ${story.taskType ?? 'story'} ${story.name}`}
      onClick={() => {
        if (!isDragging) onOpen(story);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(story);
        }
      }}
      className={`${gridCols(hasScore)} cursor-pointer border-b border-neutral-border bg-neutral-surface px-2 py-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset ${
        isDragging
          ? 'rounded-md opacity-60 ring-2 ring-brand-primary'
          : selected
            ? 'ring-2 ring-inset ring-navy-700 dark:ring-reversed'
            : ''
      }`}
    >
      <button
        type="button"
        aria-label={`Reorder ${story.name}`}
        className="flex min-h-[44px] min-w-[44px] cursor-grab touch-none items-center justify-center rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="font-mono text-[11px] text-neutral-text-secondary">{story.shortId}</span>
      <span className="flex min-w-0 items-center gap-2">
        <TypeBadge type={story.taskType} />
        <span className="truncate font-medium text-neutral-text-primary">{story.name}</span>
      </span>
      <AcMeter met={story.acMet ?? 0} total={story.acTotal ?? 0} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleDor(story);
        }}
        className="justify-self-start rounded focus:outline-none focus:ring-2 focus:ring-brand-primary"
        title="Toggle Definition of Ready (ready / refine)"
      >
        <DorChip dor={story.dor ?? 'idea'} />
      </button>
      {hasScore && (
        <span className="text-center font-mono text-[13px] font-semibold tabular-nums text-neutral-text-primary">
          {story.score != null ? (
            story.score.toFixed(1)
          ) : (
            <span className="text-neutral-text-secondary">—</span>
          )}
        </span>
      )}
      <span
        className={`text-center font-mono text-[13px] font-semibold ${
          overSized ? 'text-semantic-at-risk' : 'text-neutral-text-primary'
        }`}
      >
        {story.storyPoints ?? '—'}
      </span>
    </div>
  );
}

/** A drag-scoped section: rows reorder only within this group (rank-only, no reparent). */
function SortableGroup({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(ids, oldIndex, newIndex));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

function EpicHeader({ group }: { group: EpicGroup }) {
  const { epic, rollup } = group;
  const pct =
    rollup.pointsTotal > 0 ? Math.round((rollup.pointsDone / rollup.pointsTotal) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5 rounded-md bg-neutral-surface-sunken px-2 py-2">
      <span className="h-5 w-2 rounded-[2px] bg-brand-primary" aria-hidden />
      <span className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
        Epic
      </span>
      <span className="font-mono text-[11px] text-neutral-text-secondary">{epic.shortId}</span>
      <span className="text-sm font-semibold text-neutral-text-primary">{epic.name}</span>
      <div className="flex-1" />
      <span className="font-mono text-[11px] text-neutral-text-secondary">
        {rollup.pointsDone}/{rollup.pointsTotal} pts · {pct}%
      </span>
    </div>
  );
}

function ReadyLine() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="h-0 flex-1 border-t-2 border-dashed border-brand-primary" />
      <span className="text-xs font-bold uppercase tracking-wide text-brand-primary">
        Next-sprint ready line
      </span>
      <span className="h-0 flex-1 border-t-2 border-dashed border-brand-primary" />
    </div>
  );
}

/** Flatten the displayed backlog to the global ordered reorder payload (ADR-0110). */
function toEntries(d: ProductBacklog): ReorderEntry[] {
  const flat = [...d.epics.flatMap((g) => g.stories), ...d.ungrouped];
  return flat.map((s) => ({ id: s.id, server_version: s.serverVersion ?? 0 }));
}

export function ProductBacklogPage() {
  const projectId = useProjectId();
  const itl = useIterationLabel(projectId);
  const { data, isLoading, isError } = useProductBacklog(projectId);
  const autoRank = useAutoRank(projectId);
  const setDor = useSetDor(projectId);
  const reorder = useReorderBacklog(projectId);
  const quickAdd = useQuickAddStory(projectId);
  const canManageBacklog = useCanManageBacklog(projectId);

  // Context-aware "+ New" (ADR-0130, #1179): a `story` create intent for this project
  // focuses the inline quick-add (the create flow native to the backlog), then clears.
  const quickAddRef = useRef<HTMLInputElement>(null);
  const createIntent = useCreateIntentStore((s) => s.intent);
  const closeCreateIntent = useCreateIntentStore((s) => s.close);
  useEffect(() => {
    if (createIntent?.kind === 'story' && createIntent.projectId === projectId) {
      quickAddRef.current?.focus();
      quickAddRef.current?.scrollIntoView({ block: 'nearest' });
      closeCreateIntent();
    }
  }, [createIntent, projectId, closeCreateIntent]);
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Flatten stories in render order to locate the next-sprint ready line — the row after
  // which cumulative ready points first reach the active sprint's capacity.
  const readyLineAfterId = useMemo(() => {
    if (!data?.health.capacityPoints) return null;
    const cap = data.health.capacityPoints;
    const flat: Task[] = [...data.epics.flatMap((g) => g.stories), ...data.ungrouped];
    let cum = 0;
    for (const s of flat) {
      if (s.dor === 'ready') {
        cum += s.storyPoints ?? 0;
        if (cum >= cap) return s.id;
      }
    }
    return null;
  }, [data]);

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-text-secondary">Loading backlog…</div>;
  }
  if (isError || !data) {
    return (
      <div className="p-6 text-sm text-semantic-critical">Could not load the product backlog.</div>
    );
  }

  const backlog = data;
  const { health, scoring } = backlog;
  const hasScore = scoring.model !== 'none';
  const allEmpty = backlog.epics.length === 0 && backlog.ungrouped.length === 0;
  const selectedStory =
    selectedId == null
      ? null
      : ([...backlog.epics.flatMap((g) => g.stories), ...backlog.ungrouped].find(
          (s) => s.id === selectedId,
        ) ?? null);

  function commitReorder(optimistic: ProductBacklog) {
    setConflict(false);
    reorder.mutate(
      { stories: toEntries(optimistic), optimistic },
      {
        onError: (err) => {
          // 409 = another PO changed the backlog; any other error = save failed. Either way
          // the hook has rolled back + refetched, so we just surface the reload notice.
          setConflict(!isAxiosError(err) || err.response?.status !== 400);
        },
      },
    );
  }

  function reorderEpic(epicId: string, orderedIds: string[]) {
    const optimistic: ProductBacklog = {
      ...backlog,
      epics: backlog.epics.map((g) =>
        g.epic.id === epicId
          ? {
              ...g,
              stories: orderedIds
                .map((id) => g.stories.find((s) => s.id === id))
                .filter((s): s is Task => Boolean(s)),
            }
          : g,
      ),
    };
    commitReorder(optimistic);
  }

  function reorderUngrouped(orderedIds: string[]) {
    const optimistic: ProductBacklog = {
      ...backlog,
      ungrouped: orderedIds
        .map((id) => backlog.ungrouped.find((s) => s.id === id))
        .filter((s): s is Task => Boolean(s)),
    };
    commitReorder(optimistic);
  }

  function toggleDor(story: Task) {
    setDor.mutate({ taskId: story.id, dor: story.dor === 'ready' ? 'refine' : 'ready' });
  }

  function submitDraft() {
    const name = draft.trim();
    if (!name) return;
    setDraft(''); // clear immediately so the PO can keep typing the next story
    quickAdd.mutate({ name }, { onError: () => setDraft(name) });
  }

  function rowsWithReadyLine(stories: Task[]): ReactNode {
    return stories.map((s) => (
      <div key={s.id}>
        <StoryRow
          story={s}
          hasScore={hasScore}
          selected={s.id === selectedId}
          onToggleDor={toggleDor}
          onOpen={(st) => setSelectedId(st.id)}
        />
        {s.id === readyLineAfterId && <ReadyLine />}
      </div>
    ));
  }

  return (
    <div className="relative flex h-full flex-col bg-neutral-surface">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="flex items-center gap-3 border-b border-neutral-border px-6 py-4">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold text-neutral-text-primary">Product backlog</h1>
          <span className="text-xs text-neutral-text-secondary">Backlog / Grooming</span>
        </div>
        <div className="flex-1" />
        {hasScore && (
          <span className="rounded-full bg-brand-primary/10 px-3 py-1 text-xs font-semibold text-brand-primary">
            {scoring.model.toUpperCase()}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => autoRank.mutate()}
          disabled={autoRank.isPending || !hasScore}
          title={
            hasScore
              ? 'Sort the backlog by score (manual drag still wins afterward)'
              : 'Set a prioritization model to auto-rank'
          }
        >
          {autoRank.isPending ? 'Ranking…' : 'Auto-rank'}
        </Button>
      </header>

      <HealthStrip health={health} iterationLower={itl.lower} />

      {conflict && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-semantic-at-risk/80 bg-semantic-warning-bg px-6 py-2 text-xs text-semantic-warning"
        >
          <span>Backlog changed — reloaded. Try your move again.</span>
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => setConflict(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Fixed-column table scrolls horizontally as a unit so header + rows stay aligned
          on narrow viewports (the dense grid exceeds a phone's width). */}
      <div className="min-w-max">
      <div
        className={`${gridCols(hasScore)} border-b border-neutral-border px-6 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary`}
      >
        <span>#</span>
        <span>ID</span>
        <span>Story</span>
        <span>Acceptance</span>
        <span>Readiness</span>
        {hasScore && <span className="text-center">{scoring.model.toUpperCase()}</span>}
        <span className="text-center">Pts</span>
      </div>

      <div className="px-4 pt-2">
        {allEmpty && (
          <div className="p-8 text-center text-sm text-neutral-text-secondary">
            No stories yet. Pull items from the program backlog or add a story below to start
            grooming.
          </div>
        )}

        {backlog.epics.map((group) => (
          <div key={group.epic.id} className="mb-3.5">
            <EpicHeader group={group} />
            <SortableGroup
              ids={group.stories.map((s) => s.id)}
              onReorder={(ids) => reorderEpic(group.epic.id, ids)}
            >
              {rowsWithReadyLine(group.stories)}
            </SortableGroup>
          </div>
        ))}

        {backlog.ungrouped.length > 0 && (
          <div className="mb-3.5">
            <SortableGroup ids={backlog.ungrouped.map((s) => s.id)} onReorder={reorderUngrouped}>
              {rowsWithReadyLine(backlog.ungrouped)}
            </SortableGroup>
          </div>
        )}

        {/* Quick-add (#921): persistent title-only create pinned at the bottom. */}
        <div className="flex items-center gap-2.5 rounded border-t border-neutral-border px-2 py-2.5 focus-within:ring-2 focus-within:ring-brand-primary">
          <span className="flex w-[44px] justify-center text-neutral-text-secondary" aria-hidden>
            +
          </span>
          <input
            ref={quickAddRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitDraft();
              } else if (e.key === 'Escape') {
                setDraft('');
              }
            }}
            placeholder="Add a story…"
            aria-label="Add a story"
            className="flex-1 bg-transparent text-[13px] text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none"
          />
          {draft.trim() && (
            <span className="text-xs text-neutral-text-secondary">↵ to add</span>
          )}
        </div>
      </div>
      </div>
      </div>

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
