/**
 * Product backlog / grooming view (ADR-0105 + ADR-0110, 494/921/922).
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
 * - The score column renders the active prioritization model's computed score (922); it is
 *   hidden when the project has no model. Auto-rank sorts by score; a manual drag then wins.
 * - The bottom input quick-adds a title-only story (921): Enter commits and keeps focus, Esc
 *   clears. New stories land at the bottom of the backlog. The header "Add story" button
 *   focuses this input; "Plan sprint" routes to the Sprints view.
 * - Clicking a DoR chip toggles ready/refine (the server enforces the readiness gate).
 * - Each row carries a sprint-commitment chip (Pulled / Proposed / Pending acceptance,
 *   web-rule 180) derived from the story's sprint membership, plus an assignee avatar.
 * - The "By epic / Ranked" toggle (v2, web-rule 180) switches between the epic-grouped
 *   draggable view and a flat read-only view in score order ("score drives the ranked
 *   view") — manual drag-reorder lives in the By-epic view only.
 *
 * Rendered against the navy/sage design-system tokens.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isAxiosError } from 'axios';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ListIcon } from '@/components/Icons';
import { useProjectId } from '@/hooks/useProjectId';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCanManageBacklog } from '@/hooks/useMyFacets';
import { useSprintsByState } from '@/hooks/useSprints';
import type { Task } from '@/types';
import type { ReorderEntry } from './api';
import { countStories, filterBacklog, matchesFilters } from './filter';
import { GroomingFilterBar } from './components/GroomingFilterBar';
import { useGroomingFilters } from './hooks/useGroomingFilters';
import { MobileGroomingPage } from './components/mobile/MobileGroomingPage';
import {
  UNGROUPED_KEY,
  buildGroupKeyIndex,
  epicDroppableId,
  epicIdFromDroppableId,
  moveStoryToGroup,
  resolveBacklogDrop,
} from './backlogDrag';
import { AcMeter, AssigneeAvatar, DorChip } from './components/atoms';
import { EpicDetailDrawer } from './components/EpicDetailDrawer';
import { EpicHeader } from './components/EpicHeader';
import { SprintCommitButton, type PlannedSprintRef } from './SprintCommitButton';
import { SprintPlanningRail } from './SprintPlanningRail';
import { StoryDetailDrawer } from './components/StoryDetailDrawer';
import { TypeBadge } from './components/TypeBadge';
import {
  useAutoRank,
  useCreateEpic,
  useProductBacklog,
  useQuickAddStory,
  useReorderBacklog,
  useReparentStory,
  useSetDor,
} from './hooks/useProductBacklog';
import type { GroomingHealth, ProductBacklog } from './types';

type BacklogView = 'epic' | 'ranked';

const VIEW_STORAGE_KEY = 'trueppm.backlog.view';

/**
 * Row grid. The leading cell is the drag handle (epic view) or the rank number (ranked
 * view); the score column is present only when the project has a prioritization model;
 * the two trailing cells are the sprint-commitment chip and the assignee avatar.
 */
function gridCols(hasScore: boolean): string {
  return hasScore
    ? 'grid grid-cols-[44px_56px_1fr_120px_84px_56px_44px_88px_40px] items-center gap-2.5'
    : 'grid grid-cols-[44px_56px_1fr_120px_84px_44px_88px_40px] items-center gap-2.5';
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

function HealthStrip({
  health,
  iterationLower,
}: {
  health: GroomingHealth;
  iterationLower: string;
}) {
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
  view,
  sortable = true,
  rank,
  epicName,
  selected,
  onToggleDor,
  onOpen,
  projectId,
  plannedSprint,
  canManage,
}: {
  story: Task;
  hasScore: boolean;
  /** 'epic' = draggable group view; 'ranked' = flat read-only score-ordered view. */
  view: BacklogView;
  /** Epic-view drag toggle. `false` while a filter is active — dragging a filtered
   *  subset would persist a partial order and corrupt server-side ranks (ADR-0110). */
  sortable?: boolean;
  /** 1-based position shown in the leading cell in ranked view (replaces the drag handle). */
  rank?: number;
  /** Parent-epic name, shown as a breadcrumb under the title in ranked view only (the ID
   *  column already carries the story's short id; the epic-view group header already names
   *  the epic, so a per-row repeat there is noise — the rule-959 redundant-tag lesson). */
  epicName?: string | null;
  selected: boolean;
  onToggleDor: (story: Task) => void;
  onOpen: (story: Task) => void;
  projectId: string;
  /** The sprint in PLANNED state (issue 1291) — turns the Sprint cell into a commit toggle. */
  plannedSprint: PlannedSprintRef | null;
  canManage: boolean;
}) {
  const draggable = view === 'epic' && sortable;
  // useSortable is called unconditionally (rules of hooks); its node ref + listeners are
  // only wired in the draggable epic view, where the row sits inside a SortableContext.
  // (The ranked view and the filtered read-only epic view already call it outside any
  // DndContext — dnd-kit falls back to a no-op context, so this is safe.)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.id,
  });
  const style = draggable
    ? { transform: CSS.Transform.toString(transform), transition }
    : undefined;
  const dragging = draggable && isDragging;
  const overSized = (story.storyPoints ?? 0) >= 8;
  return (
    <div
      ref={draggable ? setNodeRef : undefined}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`Open ${story.taskType ?? 'story'} ${story.name}${
        view === 'ranked' && rank != null ? `, rank ${rank}` : ''
      }`}
      onClick={() => {
        if (!dragging) onOpen(story);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(story);
        }
      }}
      className={`${gridCols(hasScore)} cursor-pointer border-b border-neutral-border bg-neutral-surface px-2 py-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset ${
        dragging
          ? 'rounded-control opacity-60 ring-2 ring-brand-primary'
          : selected
            ? 'ring-2 ring-inset ring-navy-700 dark:ring-reversed'
            : ''
      }`}
    >
      {draggable ? (
        <button
          type="button"
          aria-label={`Reorder ${story.name}`}
          className="flex min-h-[44px] min-w-[44px] cursor-grab touch-none items-center justify-center rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      ) : view === 'ranked' ? (
        <span
          className="flex min-h-[44px] items-center justify-center font-mono text-xs tabular-nums text-neutral-text-secondary"
          aria-hidden
        >
          {rank}
        </span>
      ) : (
        // Filtered epic view: static, inert grip so the columns stay aligned and the
        // row height doesn't jump when drag is suspended.
        <span
          className="flex min-h-[44px] items-center justify-center text-neutral-text-disabled"
          aria-hidden
        >
          ⠿
        </span>
      )}
      <span className="font-mono text-xs text-neutral-text-secondary">{story.shortId}</span>
      <span className="flex min-w-0 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <TypeBadge type={story.taskType} />
          <span className="truncate font-medium text-neutral-text-primary">{story.name}</span>
        </span>
        {view === 'ranked' && epicName && (
          <span className="truncate text-xs text-neutral-text-secondary">{epicName}</span>
        )}
      </span>
      <AcMeter met={story.acMet ?? 0} total={story.acTotal ?? 0} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleDor(story);
        }}
        className="justify-self-start rounded-control focus:outline-none focus:ring-2 focus:ring-brand-primary"
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
      <span className="justify-self-start">
        <SprintCommitButton
          story={story}
          projectId={projectId}
          plannedSprint={plannedSprint}
          canManage={canManage}
        />
      </span>
      <span className="justify-self-center">
        <AssigneeAvatar assignees={story.assignees} />
      </span>
    </div>
  );
}

/**
 * A reparent drop target: one epic group (or the ungrouped bucket) on the unified
 * By-epic drag surface (ADR-0183 D4). The whole region — header + rows — is the
 * droppable, so dropping anywhere on an epic joins it. `armed` (driven by the page's
 * single tracked over-epic id, never the source group) lights the region with the
 * rule-103 board drop affordance: a sage wash + hairline border, no shadow (rule 1).
 * The reserved transparent idle border keeps the box from shifting a pixel when armed.
 */
function DropZone({
  droppableId,
  armed,
  children,
}: {
  droppableId: string;
  armed: boolean;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: droppableId });
  return (
    <div
      ref={setNodeRef}
      data-droppable={droppableId}
      data-armed={armed || undefined}
      className={`mb-3.5 rounded-card border transition-colors ${
        armed
          ? 'border-brand-primary/60 bg-brand-primary/5 ring-1 ring-inset ring-brand-primary/30'
          : 'border-transparent'
      }`}
    >
      {children}
    </div>
  );
}

/** Compact ghost rendered in the DragOverlay so the cursor carries a clear payload as
 *  it crosses epic regions (rule 102 lifted treatment: ring, slight rotate, no shadow). */
function StoryDragGhost({ story }: { story: Task }) {
  return (
    <div className="flex items-center gap-2 rounded-control border border-neutral-border bg-neutral-surface px-2 py-1.5 text-sm ring-2 ring-brand-primary motion-safe:rotate-1">
      <span className="text-neutral-text-secondary" aria-hidden>
        ⠿
      </span>
      <span className="font-mono text-xs text-neutral-text-secondary">{story.shortId}</span>
      <span className="font-medium text-neutral-text-primary">{story.name}</span>
    </div>
  );
}

/** "By epic / Ranked" segmented control. Native radios give arrow-key roving for free
 *  (rule 175/167); the visible labels carry the swatch styling and the wrapper rings on
 *  focus (rule 4/157, the radios are sr-only). */
function ViewToggle({ view, onChange }: { view: BacklogView; onChange: (v: BacklogView) => void }) {
  const OPTIONS: { value: BacklogView; label: string; rounded: string }[] = [
    { value: 'epic', label: 'By epic', rounded: 'rounded-l' },
    { value: 'ranked', label: 'Ranked', rounded: 'rounded-r' },
  ];
  return (
    <fieldset
      role="radiogroup"
      aria-label="Backlog view"
      className="inline-flex items-center rounded-control border border-neutral-border"
    >
      {OPTIONS.map(({ value, label, rounded }) => {
        const active = view === value;
        return (
          <label
            key={value}
            className={`cursor-pointer px-3 py-1 text-xs font-medium focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary ${rounded} ${
              active
                ? 'bg-brand-primary/10 text-brand-primary'
                : 'text-neutral-text-secondary hover:text-neutral-text-primary'
            }`}
          >
            <input
              type="radio"
              name="backlog-view"
              className="sr-only"
              checked={active}
              onChange={() => onChange(value)}
            />
            {label}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Legend explaining the sprint-commitment chips + the reorder/score behavior (web-rule 180). */
function LegendStrip() {
  const itl = useIterationLabel();
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-neutral-border bg-neutral-surface px-6 py-2 text-xs text-neutral-text-secondary">
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-chip bg-brand-primary/10 px-1.5 py-0.5 font-semibold text-brand-primary">
          Pulled
        </span>
        = committed to a {itl.lower}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-chip border border-dashed border-neutral-border px-1.5 py-0.5 font-semibold text-neutral-text-secondary">
          Proposed
        </span>
        = candidate
      </span>
      <span className="flex-1" />
      <span>Drag to reorder priority · score drives the ranked view</span>
    </div>
  );
}

function ReadyLine() {
  const itl = useIterationLabel();
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="h-0 flex-1 border-t-2 border-dashed border-brand-primary" />
      <span className="text-xs font-bold uppercase tracking-wide text-brand-primary">
        Next-{itl.lower} ready line
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

/**
 * Grooming view entry point — picks the layout by viewport (issue 1044). The
 * distinct mobile shell (< md) renders a card stack; desktop keeps the dense
 * draggable table. Each layout owns its own thin hook calls against the shared
 * TanStack Query cache (keyed by projectId), so there is no double-fetch and no
 * controller to extract — the shared cache dedupes.
 */
export function ProductBacklogPage() {
  const breakpoint = useBreakpoint();
  return breakpoint === 'sm' ? <MobileGroomingPage /> : <DesktopGroomingView />;
}

function DesktopGroomingView() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const itl = useIterationLabel(projectId);
  const { data, isLoading, isError } = useProductBacklog(projectId);
  const autoRank = useAutoRank(projectId);
  const setDor = useSetDor(projectId);
  const reorder = useReorderBacklog(projectId);
  const reparent = useReparentStory(projectId);
  const quickAdd = useQuickAddStory(projectId);
  const createEpic = useCreateEpic(projectId);
  const canManageBacklog = useCanManageBacklog(projectId);
  // The sprint currently being planned (issue 1291) — drives the planning rail and
  // the per-row commit toggle. Deduped against the board's ['sprints'] query.
  const plannedSprint = useSprintsByState(projectId).planned[0] ?? null;

  // Grooming filter (issue 1044): search + DoR facet + unestimated toggle. While
  // any filter is active, drag-reorder is suspended (a filtered subset persisted
  // through the ADR-0110 reorder path would corrupt server-side ranks).
  const filterCtl = useGroomingFilters();

  // "By epic / Ranked" view, persisted across visits (web-rule 180). Default to the
  // epic-grouped draggable view; ranked is the flat, read-only score-ordered preview.
  const [view, setView] = useState<BacklogView>(() =>
    typeof window !== 'undefined' && window.localStorage.getItem(VIEW_STORAGE_KEY) === 'ranked'
      ? 'ranked'
      : 'epic',
  );
  function changeView(next: BacklogView) {
    setView(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  // Context-aware "+ New" (ADR-0131, 1179): a `story` create intent for this project
  // focuses the inline quick-add (the create flow native to the backlog), then clears.
  // The header "Add story" button reuses the same focus path.
  const quickAddRef = useRef<HTMLInputElement>(null);
  function focusQuickAdd() {
    quickAddRef.current?.focus();
    quickAddRef.current?.scrollIntoView({ block: 'nearest' });
  }
  const createIntent = useCreateIntentStore((s) => s.intent);
  const closeCreateIntent = useCreateIntentStore((s) => s.close);
  useEffect(() => {
    if (createIntent?.kind === 'story' && createIntent.projectId === projectId) {
      focusQuickAdd();
      closeCreateIntent();
    }
  }, [createIntent, projectId, closeCreateIntent]);
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Unified By-epic drag surface (ADR-0183): a single DndContext spans every
  // epic group + the ungrouped bucket. `activeId` is the dragged story; `overEpicId` is
  // the single armed reparent target — only ever a group *different* from the source,
  // and only for a backlog manager (D4/D6). `liveRef` carries the drop announcement,
  // written via DOM ref (rule 30 / ADR-0056) to avoid a re-render storm mid-drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overEpicId, setOverEpicId] = useState<string | null>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  function announce(message: string) {
    if (liveRef.current) liveRef.current.textContent = message;
  }

  // Inline epic create: the header "+ Add epic" reveals a dashed input row at the
  // top of the epic list. Enter commits and keeps focus for rapid multi-add; Esc closes.
  const epicAddRef = useRef<HTMLInputElement>(null);
  const [addingEpic, setAddingEpic] = useState(false);
  const [epicDraft, setEpicDraft] = useState('');
  function openAddEpic() {
    createEpic.reset();
    setAddingEpic(true);
  }
  useEffect(() => {
    if (addingEpic) epicAddRef.current?.focus();
  }, [addingEpic]);
  function submitEpic() {
    const name = epicDraft.trim();
    if (!name) return;
    setEpicDraft(''); // clear immediately so the PO can keep adding; restore on error
    createEpic.mutate({ name }, { onError: () => setEpicDraft(name) });
  }
  function closeAddEpic() {
    setAddingEpic(false);
    setEpicDraft('');
  }

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
    return (
      <div role="status" aria-label="Loading backlog…" className="flex flex-col gap-2 p-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="h-11 motion-safe:animate-pulse rounded-card bg-neutral-surface-sunken"
          />
        ))}
      </div>
    );
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
  const allStories = [...backlog.epics.flatMap((g) => g.stories), ...backlog.ungrouped];
  // `selectedId` addresses either a story row or an epic header — their ids are disjoint,
  // so resolve against both and render whichever drawer matches.
  const selectedStory =
    selectedId == null ? null : (allStories.find((s) => s.id === selectedId) ?? null);
  const selectedEpic =
    selectedId == null
      ? null
      : (backlog.epics.find((g) => g.epic.id === selectedId)?.epic ?? null);

  // Drag bookkeeping for the unified surface (ADR-0183). `groupKeyIndex` maps each
  // story to its current group's droppable key; `activeStory`/`dragActive` track the
  // in-flight drag so the ghost has a payload and empty epics expose a drop slot.
  const groupKeyIndex = buildGroupKeyIndex(backlog);
  const activeStory = activeId ? (allStories.find((s) => s.id === activeId) ?? null) : null;
  const dragActive = activeId !== null;

  // Stories committed to the planned sprint (issue 1291) — feeds the rail's live
  // capacity points + commitment summary.
  const plannedStories = plannedSprint
    ? allStories.filter((s) => s.sprintId === plannedSprint.id)
    : [];
  const plannedCommittedPoints = plannedStories.reduce((sum, s) => sum + (s.storyPoints ?? 0), 0);

  // Sprint-commitment composition drives the dynamic subtitle: a story with a sprint is
  // "pulled" (committed), a post-activation injection is "pending" (ADR-0102), the rest
  // are "proposed" candidates.
  const pendingCount = allStories.filter((s) => s.sprintPending).length;
  const pulledCount = allStories.filter((s) => s.sprintId && !s.sprintPending).length;
  const proposedCount = allStories.filter((s) => !s.sprintId).length;
  const subtitleParts = ['Epics → stories'];
  if (hasScore) subtitleParts.push('scored & ordered');
  subtitleParts.push(`${pulledCount} pulled into sprint`, `${proposedCount} proposed`);
  if (pendingCount > 0) subtitleParts.push(`${pendingCount} pending`);
  const subtitle = subtitleParts.join(' · ');

  // Ranked view: a flat read-only list. With a model, sort by score desc ("score drives
  // the ranked view"); without one, keep the persisted manual priority order (allStories
  // is already in priority_rank traversal order). The breadcrumb map lets a ranked row
  // still name its parent epic, which the epic-group header would otherwise carry.
  const epicNameOf = new Map<string, string>();
  backlog.epics.forEach((g) => g.stories.forEach((s) => epicNameOf.set(s.id, g.epic.name)));
  const rankedStories = hasScore
    ? [...allStories].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
    : allStories;

  // Grooming filter (issue 1044). When inactive, the display data is the raw
  // backlog and the drag path renders byte-identical to before. When active, the
  // epic groups + ranked list are narrowed (remove semantics, ADR-0199) and drag
  // is suspended.
  const filterActive = filterCtl.active;
  const totalCount = countStories(backlog);
  const filtered = filterBacklog(backlog, filterCtl.filters);
  const filteredMatchCount = filterActive ? filtered.matchCount : totalCount;
  const filteredRanked = filterActive
    ? rankedStories.filter((s) => matchesFilters(s, filterCtl.filters))
    : rankedStories;

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

  // ── Unified By-epic drag handlers (ADR-0183 D2/D3/D6) ──────────────────────
  // A drop resolves to exactly one of: reorder within the source group (the existing
  // rank-only path), reparent into a *different* group (a single parent_epic PATCH), or
  // a no-op (dropped on its own region with no row move).

  /**
   * Reparent the dragged story into an epic — or out of all epics (`parentEpicId: null`).
   * A single optimistic `parent_epic` PATCH (D3): the story relocates between cached groups
   * immediately, then the write persists. Manager-gated (D6) and offline-guarded — a reparent
   * has no offline queue, so refuse it up front rather than desync the move from a write that
   * never lands. On failure the hook rolls back + refetches; we reuse the reorder reload banner
   * and announce the outcome on the aria-live region (rule 30 / ADR-0056).
   */
  function doReparent(story: Task, parentEpicId: string | null) {
    if (!canManageBacklog) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      announce(`Couldn't move ${story.name} — you're offline.`);
      return;
    }
    setConflict(false);
    const optimistic = moveStoryToGroup(backlog, story.id, parentEpicId);
    const epicName =
      parentEpicId == null
        ? null
        : (backlog.epics.find((g) => g.epic.id === parentEpicId)?.epic.name ?? 'epic');
    reparent.mutate(
      { taskId: story.id, parentEpicId, optimistic },
      {
        onSuccess: () =>
          announce(
            parentEpicId == null
              ? `Moved ${story.name} out of all epics.`
              : `Moved ${story.name} to epic ${epicName}.`,
          ),
        onError: () => {
          setConflict(true);
          announce(`Couldn't move ${story.name}. The backlog was reloaded — try again.`);
        },
      },
    );
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  // Light the single armed reparent target as the cursor crosses regions: only a group
  // *different* from the source, and only for a manager (D4/D6). A story id resolves to its
  // current group's key; an `epic:` droppable id is already that key.
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) {
      setOverEpicId(null);
      return;
    }
    const src = groupKeyIndex.get(String(active.id));
    const overId = String(over.id);
    const targetKey = overId.startsWith('epic:') ? overId : groupKeyIndex.get(overId);
    if (!targetKey || targetKey === src || !canManageBacklog) {
      setOverEpicId(null);
      return;
    }
    setOverEpicId(targetKey);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setOverEpicId(null);
    const drop = resolveBacklogDrop(
      backlog,
      groupKeyIndex,
      String(event.active.id),
      event.over ? String(event.over.id) : null,
    );
    if (drop.kind === 'reorder') {
      if (drop.groupKey === UNGROUPED_KEY) reorderUngrouped(drop.orderedIds);
      else {
        const epicId = epicIdFromDroppableId(drop.groupKey);
        if (epicId) reorderEpic(epicId, drop.orderedIds);
      }
    } else if (drop.kind === 'reparent') {
      const story = allStories.find((s) => s.id === drop.storyId);
      if (story) doReparent(story, drop.parentEpicId);
    }
  }

  function handleDragCancel() {
    setActiveId(null);
    setOverEpicId(null);
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
          view="epic"
          selected={s.id === selectedId}
          onToggleDor={toggleDor}
          onOpen={(st) => setSelectedId(st.id)}
          projectId={projectId as string}
          plannedSprint={plannedSprint}
          canManage={canManageBacklog}
        />
        {s.id === readyLineAfterId && <ReadyLine />}
      </div>
    ));
  }

  // Filtered epic view (issue 1044): keep the grouping + headers, but render rows
  // read-only (no drag, no ready line — the ready line marks cumulative ready points
  // in true priority order, which a filtered subset misrepresents).
  function readOnlyRows(stories: Task[]): ReactNode {
    return stories.map((s) => (
      <StoryRow
        key={s.id}
        story={s}
        hasScore={hasScore}
        view="epic"
        sortable={false}
        selected={s.id === selectedId}
        onToggleDor={toggleDor}
        onOpen={(st) => setSelectedId(st.id)}
        projectId={projectId as string}
        plannedSprint={plannedSprint}
        canManage={canManageBacklog}
      />
    ));
  }

  return (
    <div className="relative flex h-full flex-row bg-app-canvas">
      {/* Drag/reparent announcer (ADR-0183 D5) — written via DOM ref, not React state
          (rule 30 / ADR-0056), so a mid-drag update never re-renders the dragging tree. */}
      <span
        ref={liveRef}
        data-testid="backlog-drop-announcer"
        aria-live="polite"
        className="sr-only"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <header className="flex flex-wrap items-center gap-3 border-b border-neutral-border px-6 py-4">
          <div className="flex min-w-0 flex-col">
            <h1 className="text-xl font-semibold text-neutral-text-primary">Product backlog</h1>
            <span className="text-xs text-neutral-text-secondary">{subtitle}</span>
          </div>
          <div className="flex-1" />
          <ViewToggle view={view} onChange={changeView} />
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (projectId) void navigate(`/projects/${projectId}/sprints`);
            }}
            title={`Go to the ${itl.lower} planning view`}
          >
            Plan {itl.lower}
          </Button>
          {canManageBacklog && view === 'epic' && (
            <Button variant="secondary" size="sm" onClick={openAddEpic}>
              + Add epic
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={focusQuickAdd}>
            + Add story
          </Button>
        </header>

        <HealthStrip health={health} iterationLower={itl.lower} />
        <LegendStrip />

        {/* Filter bar (issue 1044) — pinned left, outside the horizontal-scroll table. */}
        {!allEmpty && (
          <GroomingFilterBar
            controls={filterCtl}
            matchCount={filteredMatchCount}
            totalCount={totalCount}
          />
        )}

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
            <span>{itl.singular}</span>
            <span className="text-center">Owner</span>
          </div>

          <div className="px-4 pt-2">
            {allEmpty && (
              <EmptyState
                icon={ListIcon}
                title="No stories yet"
                description="Pull items from the program backlog, or add a story below to start grooming."
              />
            )}

            {/* No-results state when a filter is active but nothing matches (issue 1044).
                Distinct from the all-empty state above, which stays reachable. */}
            {!allEmpty && filterActive && filteredMatchCount === 0 && (
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                <p className="text-sm text-neutral-text-secondary">
                  No stories match your filters.
                </p>
                <Button variant="secondary" size="sm" onClick={filterCtl.reset}>
                  Clear filters
                </Button>
              </div>
            )}

            {/* Filtered epic view (issue 1044): read-only groups, drag suspended. A hint
                explains why the grip is inert. Empty groups are already dropped by
                filterBacklog, so every rendered header carries at least one match. */}
            {!allEmpty && filterActive && filteredMatchCount > 0 && view === 'epic' && (
              <div>
                <p className="px-2 pb-2 text-xs text-neutral-text-secondary">
                  Filtered — drag to reorder is disabled. Clear filters to reorder.
                </p>
                {filtered.epics.map((group) => (
                  <div
                    key={group.epic.id}
                    className="mb-3.5 rounded-card border border-transparent"
                  >
                    <EpicHeader
                      group={group}
                      projectId={projectId as string}
                      selected={group.epic.id === selectedId}
                      onOpen={(epic) => setSelectedId(epic.id)}
                      armed={false}
                    />
                    {readOnlyRows(group.stories)}
                  </div>
                ))}
                {filtered.ungrouped.length > 0 && (
                  <div className="mb-3.5 rounded-card border border-transparent">
                    <div className="flex items-center gap-2.5 rounded-card bg-neutral-surface-sunken px-2 py-2">
                      <span className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
                        No epic
                      </span>
                    </div>
                    {readOnlyRows(filtered.ungrouped)}
                  </div>
                )}
              </div>
            )}

            {!filterActive && view === 'epic' && (
              // One DndContext spans every epic group + the ungrouped bucket (ADR-0183 D1),
              // so a story can be dragged across regions. Within a group rows stay sortable
              // (rank-only reorder); a drop onto a different group reparents (D2). Renders
              // even when the backlog is empty so the inline "+ Add epic" input is reachable.
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                {addingEpic && (
                  <div className="mb-3.5">
                    <div className="flex items-center gap-2.5 rounded-card border border-dashed border-neutral-border bg-neutral-surface-sunken px-2 py-2 focus-within:ring-2 focus-within:ring-brand-primary">
                      <span
                        className="flex w-[44px] justify-center text-neutral-text-secondary"
                        aria-hidden
                      >
                        +
                      </span>
                      <input
                        ref={epicAddRef}
                        type="text"
                        value={epicDraft}
                        onChange={(e) => setEpicDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            submitEpic();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            closeAddEpic();
                          }
                        }}
                        onBlur={() => {
                          if (!epicDraft.trim()) closeAddEpic();
                        }}
                        placeholder="Epic name…"
                        aria-label="New epic name"
                        className="flex-1 bg-transparent text-sm font-semibold text-neutral-text-primary placeholder:font-normal placeholder:text-neutral-text-secondary focus:outline-none"
                      />
                      {epicDraft.trim() && (
                        <span className="text-xs text-neutral-text-secondary">↵ to add</span>
                      )}
                    </div>
                    {createEpic.isError && (
                      <p role="alert" className="px-2 pt-1 text-xs text-semantic-critical">
                        Couldn&apos;t add epic — try again.
                      </p>
                    )}
                  </div>
                )}

                {backlog.epics.map((group) => {
                  const droppableId = epicDroppableId(group.epic.id);
                  const armed = overEpicId === droppableId;
                  return (
                    <DropZone key={group.epic.id} droppableId={droppableId} armed={armed}>
                      <EpicHeader
                        group={group}
                        projectId={projectId as string}
                        selected={group.epic.id === selectedId}
                        onOpen={(epic) => setSelectedId(epic.id)}
                        armed={armed}
                      />
                      <SortableContext
                        items={group.stories.map((s) => s.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {rowsWithReadyLine(group.stories)}
                      </SortableContext>
                      {group.stories.length === 0 && (
                        <p className="px-2 py-2 text-xs text-neutral-text-secondary">
                          {!canManageBacklog
                            ? 'No stories yet — set this epic from a story’s detail drawer.'
                            : dragActive
                              ? 'Drop here to add this story to the epic.'
                              : 'No stories yet — drag a story here or set this epic from a story’s detail drawer.'}
                        </p>
                      )}
                    </DropZone>
                  );
                })}

                {/* The "No epic" bucket is also a drop target — dropping here clears parent_epic
                    (D2). It renders whenever it holds stories, or transiently during a manager's
                    drag so a story can always be pulled out of its epic. */}
                {(backlog.ungrouped.length > 0 || (dragActive && canManageBacklog)) && (
                  <DropZone droppableId={UNGROUPED_KEY} armed={overEpicId === UNGROUPED_KEY}>
                    <div className="flex items-center gap-2.5 rounded-card bg-neutral-surface-sunken px-2 py-2">
                      <span className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
                        No epic
                      </span>
                      {overEpicId === UNGROUPED_KEY && (
                        <span className="text-xs font-medium text-brand-primary" aria-hidden>
                          ↳ Drop to remove from its epic
                        </span>
                      )}
                    </div>
                    <SortableContext
                      items={backlog.ungrouped.map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {rowsWithReadyLine(backlog.ungrouped)}
                    </SortableContext>
                    {backlog.ungrouped.length === 0 && dragActive && canManageBacklog && (
                      <p className="px-2 py-2 text-xs text-neutral-text-secondary">
                        Drop here to remove this story from its epic.
                      </p>
                    )}
                  </DropZone>
                )}

                {/* The lifted row follows the cursor across regions (rule 102 treatment). */}
                <DragOverlay>
                  {activeStory ? <StoryDragGhost story={activeStory} /> : null}
                </DragOverlay>
              </DndContext>
            )}

            {/* Ranked: flat, read-only score order — no epic headers, no drag, no ready line
                (the ready line marks cumulative ready points in priority order, which the
                score sort reorders, so it would mislead here). Filtered when a filter is
                active (filteredRanked === rankedStories otherwise). Suppressed only when a
                filter is active and nothing matches (the no-results block shows instead). */}
            {view === 'ranked' && !(filterActive && filteredMatchCount === 0) && (
              <div className="mb-3.5">
                {filteredRanked.map((s, i) => (
                  <StoryRow
                    key={s.id}
                    story={s}
                    hasScore={hasScore}
                    view="ranked"
                    rank={i + 1}
                    epicName={epicNameOf.get(s.id) ?? null}
                    selected={s.id === selectedId}
                    onToggleDor={toggleDor}
                    onOpen={(st) => setSelectedId(st.id)}
                    projectId={projectId as string}
                    plannedSprint={plannedSprint}
                    canManage={canManageBacklog}
                  />
                ))}
              </div>
            )}

            {/* Quick-add (921): persistent title-only create pinned at the bottom. */}
            <div className="flex items-center gap-2.5 rounded-control border-t border-neutral-border px-2 py-2.5 focus-within:ring-2 focus-within:ring-brand-primary">
              <span
                className="flex w-[44px] justify-center text-neutral-text-secondary"
                aria-hidden
              >
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

      {/* Hide the rail while a detail drawer is open — the drawer is absolute right-0
          (w-480) and would otherwise occlude the in-flow rail (w-320), pushing
          planning context out of sight (web-rule 205). */}
      {plannedSprint && !selectedStory && !selectedEpic && (
        <SprintPlanningRail
          plannedSprint={plannedSprint}
          committedPoints={plannedCommittedPoints}
          storyCount={plannedStories.length}
          iterationLower={itl.lower}
        />
      )}

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

      {selectedEpic && (
        <EpicDetailDrawer
          key={selectedEpic.id}
          projectId={projectId as string}
          epic={selectedEpic}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
