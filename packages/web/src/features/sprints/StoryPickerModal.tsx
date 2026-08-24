import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useProductBacklog } from '@/features/project/backlog/hooks/useProductBacklog';
import { useBulkUpdateTasks } from '@/hooks/useTaskMutations';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { toast } from '@/components/Toast/toast';
import { SearchIcon, WarningIcon } from '@/components/Icons';
import { capacityPointsChip } from './sprintMath';
import {
  buildStoryCommitOperations,
  reconcileStoryCommit,
  type CommittedStoryRef,
  type StoryCommitOutcome,
} from './storyCommitReconcile';
import type { Task } from '@/types';

/** Minimal PLANNED sprint reference the picker needs (issue #2670). */
export interface StoryPickerSprint {
  id: string;
  short_id_display: string;
  capacity_points: number | null;
}

interface Props {
  projectId: string;
  sprint: StoryPickerSprint;
  /**
   * Points already committed to this sprint (draft load over assigned tasks,
   * matching {@link CapacityPreflight}'s `points.committed`) — the picker's live
   * preview adds the current selection's points on top of this so the number
   * matches what the Capacity Preflight card will show immediately after commit.
   */
  committedPoints: number;
  /**
   * Server-resolved "Ready only" default for this project (ADR-0758, #2670):
   * project ?? program ?? workspace. Seeds the picker's starting filter — always
   * overridable per-session via the in-picker toggle, never enforced.
   */
  readyOnlyDefault: boolean;
  onClose: () => void;
}

/** Machine-stable reason codes (product_backlog_services.dor_blockers) → the same
 *  plain-English phrasing StoryDetailDrawer's DorControl already uses, so a story
 *  reads identically whether a PO sees it on the backlog or a Scheduler sees it
 *  in the sprint picker. */
const BLOCKER_COPY: Record<string, string> = {
  unestimated: 'needs an estimate',
  no_acceptance_criteria: 'add at least one acceptance criterion',
  acceptance_criteria_unmet: 'all acceptance criteria must be met',
};

function blockerSummary(blockers: string[] | undefined): string {
  if (!blockers || blockers.length === 0) return '';
  return blockers.map((b) => BLOCKER_COPY[b] ?? b).join('; ');
}

interface PickerRow {
  story: Task;
  epicName: string | null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Referenced by the result phase's buttons so the breakdown is announced with them. */
const RESULT_PANEL_ID = 'story-picker-result-summary';

/**
 * Multi-select story picker for committing existing backlog stories into a
 * PLANNED sprint (issue #2670) — replaces the "Pull from backlog →" page
 * navigation with an in-place surface that keeps the sprint's capacity
 * preflight and committed-points context live while stories are selected.
 *
 * Definition-of-Ready (ADR-0105) is surfaced but never hard-gates a commit in
 * OSS: "Ready only" (default from {@link readyOnlyDefault}, per-session
 * overridable via the in-picker toggle) hides not-ready stories; switching it
 * off reveals them dimmed with their blocker reasons, still selectable. A
 * commit that includes a not-ready story shows an inline advisory warning, not
 * a blocked button — hard enforcement is an Enterprise extension point this
 * issue explicitly scopes out (see sprint_picker_settings.py).
 *
 * The commit is ONE request (#2914): `POST /projects/{pk}/tasks/bulk/`, applied
 * per row inside a single `transaction.atomic()` and answered with a 207 whose
 * `applied` / `rejected` / `skipped` buckets are the per-row outcome. That makes
 * this a two-phase dialog — pick, then reconcile — because the interesting answer
 * is no longer "did it work" but "which of the forty landed, and why not the other
 * three". A toast cannot carry that: it is transient, it cannot list rows, and it
 * has nowhere to hang the retry.
 */
export function StoryPickerModal({
  projectId,
  sprint,
  committedPoints,
  readyOnlyDefault,
  onClose,
}: Props) {
  const itl = useIterationLabel(projectId);
  const backlog = useProductBacklog(projectId);
  const commitStories = useBulkUpdateTasks(projectId);
  const queryClient = useQueryClient();

  const [readyOnly, setReadyOnly] = useState(readyOnlyDefault);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  /** Per-row 207 reconciliation. Non-null puts the dialog in its result phase. */
  const [outcome, setOutcome] = useState<StoryCommitOutcome | null>(null);
  /** Whole-request failure (4xx/5xx/offline) — the batch rolled back, nothing wrote. */
  const [commitError, setCommitError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const resultActionRef = useRef<HTMLButtonElement>(null);

  const phase: 'pick' | 'result' = outcome ? 'result' : 'pick';

  // Rule 245: the dialog stays open while its content swaps phase, so the trap
  // takes `phase` as its focusKey — without it, focus falls to <body> when the
  // picker table unmounts under the result panel and Tab escapes the modal.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, phase);

  // Declared after the trap so it runs after the hook's seat effect (call order =
  // effect order) and wins: the trap's default seat is "first focusable", which is
  // the header ✕ in both phases — correct for neither. Pick wants the search box;
  // the result wants its primary action, which rule 288 prefers over a tabIndex={-1}
  // status node anyway (there is a focusable ✕ ahead of it, but one keystroke to
  // the next step beats making a keyboard user Tab out of a read-only region).
  useEffect(() => {
    if (phase === 'result') resultActionRef.current?.focus();
    else searchRef.current?.focus();
  }, [phase]);

  // Every backlog story is already sprint-less by construction (the grooming
  // endpoint scopes to status=BACKLOG, sprint__isnull=True) — flatten epics'
  // children + ungrouped into one list, carrying the epic name for context.
  const allRows: PickerRow[] = useMemo(() => {
    if (!backlog.data) return [];
    const fromEpics = backlog.data.epics.flatMap((g) =>
      g.stories.map((story) => ({ story, epicName: g.epic.name })),
    );
    const fromUngrouped = backlog.data.ungrouped.map((story) => ({ story, epicName: null }));
    return [...fromEpics, ...fromUngrouped];
  }, [backlog.data]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (r) =>
        r.story.name.toLowerCase().includes(q) || (r.epicName?.toLowerCase().includes(q) ?? false),
    );
  }, [allRows, query]);

  // Ready-first ordering (Q2's third option: show everything, sort ready-first,
  // and let "Ready only" collapse the rest — never silently absent).
  const sorted = useMemo(
    () =>
      [...searched].sort((a, b) => {
        const aReady = a.story.dor === 'ready' ? 0 : 1;
        const bReady = b.story.dor === 'ready' ? 0 : 1;
        return aReady - bReady;
      }),
    [searched],
  );

  const hiddenNotReadyCount = useMemo(
    () => (readyOnly ? sorted.filter((r) => r.story.dor !== 'ready').length : 0),
    [sorted, readyOnly],
  );
  const visible = useMemo(
    () => (readyOnly ? sorted.filter((r) => r.story.dor === 'ready') : sorted),
    [sorted, readyOnly],
  );

  const selectedRows = useMemo(
    () => allRows.filter((r) => selected.has(r.story.id)),
    [allRows, selected],
  );
  const selectedPoints = useMemo(
    () => selectedRows.reduce((sum, r) => sum + (r.story.storyPoints ?? 0), 0),
    [selectedRows],
  );
  const selectedNotReady = useMemo(
    () => selectedRows.filter((r) => r.story.dor !== 'ready'),
    [selectedRows],
  );

  const pointsChip = capacityPointsChip(committedPoints + selectedPoints, sprint.capacity_points);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.story.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of visible) next.delete(r.story.id);
      } else {
        for (const r of visible) next.add(r.story.id);
      }
      return next;
    });
  }

  /**
   * Commit `ids` as one `tasks/bulk` batch and reconcile the 207 it answers with.
   *
   * Three outcomes, deliberately shaped differently:
   *
   * - **Every row landed** — a toast and the modal closes. Nothing to reconcile,
   *   so keeping the dialog open to say "all 12 worked" would be a step to dismiss.
   * - **Some rows refused** — the dialog switches to its result phase and names
   *   them. The retry there re-sends only the rejected ids.
   * - **The request itself failed** — a 4xx/5xx rolls the whole `atomic()` block
   *   back, so *nothing* was written. Say that explicitly and keep the selection
   *   intact: the previous per-row implementation could not make that claim, and
   *   the ambiguity is the reason this issue exists.
   */
  async function handleCommit(ids: string[]) {
    if (ids.length === 0 || committing) return;
    // Names are captured at send time. The applied rows leave the backlog on the
    // refetch below, so a panel that looked them up afterwards would render the
    // committed rows fine and the interesting ones as blanks.
    const sent: CommittedStoryRef[] = ids.map((id) => ({
      id,
      name: allRows.find((r) => r.story.id === id)?.story.name ?? 'This story',
    }));
    setCommitting(true);
    setCommitError(null);
    try {
      const response = await commitStories.mutateAsync(buildStoryCommitOperations(ids, sprint.id));
      void queryClient.invalidateQueries({ queryKey: ['product-backlog', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['sprint-backlog', projectId, sprint.id] });
      const result = reconcileStoryCommit(sent, response);
      if (result.isClean) {
        toast.success(
          `Pulled ${result.committedCount} ${plural(result.committedCount, 'story', 'stories')} into ${sprint.short_id_display}.`,
        );
        onClose();
        return;
      }
      // Keep the selection aligned with what a retry would act on, so the two can
      // never disagree about which rows are still outstanding.
      setSelected(new Set(result.retryIds));
      setOutcome(result);
    } catch {
      // Deliberately does NOT say "couldn't reach the server": this arm also
      // catches a 4xx the server very much answered. What IS true in every case
      // is the atomicity claim — the batch is one transaction, so a request that
      // did not return 207 wrote nothing.
      setCommitError(
        `Nothing was committed — no stories were pulled into ${sprint.short_id_display}. Your selection is unchanged, so you can try again.`,
      );
    } finally {
      setCommitting(false);
    }
  }

  const isLoading = backlog.isLoading;
  const isError = backlog.isError;

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-neutral-overlay cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Pull stories into ${sprint.short_id_display}`}
          className="w-full max-w-2xl max-h-[85vh] rounded-card border border-neutral-border
            bg-neutral-surface shadow-pop pointer-events-auto flex flex-col"
        >
          <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-neutral-border">
            <div className="flex flex-col gap-0.5 min-w-0">
              <h2 className="text-base font-semibold text-neutral-text-primary">
                Pull stories into {sprint.short_id_display}
              </h2>
              <p className="text-xs text-neutral-text-secondary">
                {phase === 'result'
                  ? 'One transaction — here is what the server did with each story.'
                  : 'Select existing backlog stories to commit. Capacity below updates as you pick.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-neutral-text-secondary hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
            >
              ✕
            </button>
          </header>

          {outcome ? (
            <CommitResultPanel outcome={outcome} sprintLabel={sprint.short_id_display} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-neutral-border">
                <div className="relative flex-1 min-w-[160px]">
                  <SearchIcon
                    aria-hidden="true"
                    className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-text-disabled"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search backlog stories…"
                    aria-label="Search backlog stories"
                    className="w-full h-8 pl-7 pr-2 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                </div>
                <div
                  role="radiogroup"
                  aria-label="Readiness filter"
                  className="flex gap-1 shrink-0"
                >
                  {(
                    [
                      { val: true, label: 'Ready only' },
                      { val: false, label: 'Show all' },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={String(opt.val)}
                      className={[
                        'px-2.5 py-1 rounded border text-xs font-medium cursor-pointer transition-colors',
                        'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-primary has-[:focus-visible]:ring-offset-1',
                        readyOnly === opt.val
                          ? 'border-2 border-brand-primary bg-brand-primary-light text-brand-primary'
                          : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="picker-ready-filter"
                        className="sr-only"
                        checked={readyOnly === opt.val}
                        onChange={() => setReadyOnly(opt.val)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>

              {readyOnly && hiddenNotReadyCount > 0 && (
                <p className="px-5 pt-2 text-xs text-neutral-text-secondary">
                  {hiddenNotReadyCount} not-ready{' '}
                  {hiddenNotReadyCount === 1 ? 'story is' : 'stories are'} hidden.{' '}
                  <button
                    type="button"
                    onClick={() => setReadyOnly(false)}
                    className="font-medium text-brand-primary hover:text-brand-primary-dark underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
                  >
                    Show all
                  </button>
                </p>
              )}

              <div className="flex-1 overflow-y-auto px-5 py-2">
                {isLoading ? (
                  <div
                    role="status"
                    aria-label="Loading backlog stories…"
                    className="flex flex-col gap-2"
                  >
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        aria-hidden="true"
                        className="h-10 motion-safe:animate-pulse rounded bg-neutral-surface-sunken"
                      />
                    ))}
                  </div>
                ) : isError ? (
                  <p role="alert" className="text-sm text-semantic-critical py-4">
                    Couldn&apos;t load the backlog — try closing and reopening this picker.
                  </p>
                ) : visible.length === 0 ? (
                  <div
                    role="status"
                    className="rounded-card border border-dashed border-neutral-border bg-neutral-surface-raised p-6 text-center flex flex-col items-center gap-2"
                  >
                    <p className="text-sm font-medium text-neutral-text-primary">
                      {allRows.length === 0
                        ? 'The backlog is empty.'
                        : readyOnly
                          ? 'No Ready stories to pull.'
                          : 'No backlog stories match your search.'}
                    </p>
                    <p className="text-xs text-neutral-text-secondary max-w-sm">
                      {allRows.length === 0
                        ? 'Add stories from the Product Backlog, or create a new task from this sprint.'
                        : readyOnly
                          ? 'Refine a story to Ready, or switch to "Show all" to pull one anyway.'
                          : 'Try a different search term, or clear it.'}
                    </p>
                    <Link
                      to={`/projects/${projectId}/product-backlog`}
                      className="text-xs font-medium text-brand-primary hover:text-brand-primary-dark
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
                    >
                      Manage full backlog →
                    </Link>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left">
                        <th className="w-8 pb-1.5">
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            onChange={toggleAllVisible}
                            aria-label={
                              allVisibleSelected
                                ? 'Deselect all visible stories'
                                : 'Select all visible stories'
                            }
                            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                          />
                        </th>
                        <th className="pb-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
                          Story
                        </th>
                        <th className="pb-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary text-right w-14">
                          Pts
                        </th>
                        <th className="pb-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary w-24">
                          Ready
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(({ story, epicName }) => {
                        const isReady = story.dor === 'ready';
                        const checked = selected.has(story.id);
                        return (
                          <tr
                            key={story.id}
                            className={`border-t border-neutral-border/60 ${!isReady ? 'opacity-70' : ''}`}
                          >
                            <td className="py-2 align-top">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleOne(story.id)}
                                aria-label={`Select ${story.name}`}
                                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                              />
                            </td>
                            <td className="py-2 align-top pr-2">
                              <button
                                type="button"
                                onClick={() => toggleOne(story.id)}
                                className="block w-full text-left cursor-pointer rounded
                              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                              >
                                <span
                                  className="block text-sm text-neutral-text-primary truncate"
                                  title={story.name}
                                >
                                  {story.name}
                                </span>
                                {epicName && (
                                  <span className="block text-xs text-neutral-text-disabled truncate">
                                    {epicName}
                                  </span>
                                )}
                                {!isReady && (
                                  <span className="block text-xs text-semantic-at-risk">
                                    <WarningIcon
                                      className="inline-block h-3 w-3 align-[-0.125em] mr-1"
                                      aria-hidden="true"
                                    />
                                    Not ready —{' '}
                                    {blockerSummary(story.dorBlockers) || 'needs refinement'}
                                  </span>
                                )}
                              </button>
                            </td>
                            <td className="py-2 align-top text-right tppm-mono text-xs text-neutral-text-primary">
                              {story.storyPoints ?? '—'}
                            </td>
                            <td className="py-2 align-top text-xs">
                              {isReady ? (
                                <span className="text-semantic-on-track font-medium">Ready</span>
                              ) : (
                                <span className="text-neutral-text-secondary capitalize">
                                  {story.dor ?? 'idea'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {selectedNotReady.length > 0 && (
                <p
                  role="alert"
                  className="mx-5 mb-2 rounded px-3 py-2 text-xs bg-semantic-at-risk-bg text-semantic-at-risk"
                >
                  <WarningIcon
                    className="inline-block h-3 w-3 align-[-0.125em] mr-1"
                    aria-hidden="true"
                  />
                  {selectedNotReady.length} selected{' '}
                  {selectedNotReady.length === 1 ? 'story is' : 'stories are'} not marked Ready —
                  you can still pull {selectedNotReady.length === 1 ? 'it' : 'them'} into{' '}
                  {itl.lower}.
                </p>
              )}

              {commitError && (
                <p
                  role="alert"
                  className="mx-5 mb-2 rounded px-3 py-2 text-xs bg-semantic-critical-bg text-semantic-critical"
                >
                  <WarningIcon
                    className="inline-block h-3 w-3 align-[-0.125em] mr-1"
                    aria-hidden="true"
                  />
                  {commitError}
                </p>
              )}
            </>
          )}

          <footer className="flex items-center justify-between gap-3 px-5 py-3 border-t border-neutral-border">
            {outcome ? (
              <>
                <span className="text-xs text-neutral-text-secondary tppm-mono min-w-0">
                  {outcome.committedCount}/{outcome.sentCount} committed
                </span>
                {/* Both result-phase buttons use `focus:`, not `focus-visible:`
                    (rule 288(c) / 204(b)): one of them is the target of a SCRIPTED
                    .focus() on the phase swap, and browsers may withhold
                    :focus-visible on programmatic focus — which would land a
                    keyboard user on a button with no visible ring. They also carry
                    `aria-describedby` so the breakdown itself is announced: moving
                    focus to a button otherwise announces only the button, and a
                    live region inserted together with its content is not reliably
                    read. */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    // Seat target when nothing is retryable — see the focus effect.
                    ref={outcome.retryIds.length === 0 ? resultActionRef : undefined}
                    onClick={onClose}
                    aria-describedby={RESULT_PANEL_ID}
                    className="h-8 px-3 rounded border border-neutral-border text-xs font-medium text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  >
                    Done
                  </button>
                  {outcome.retryIds.length > 0 && (
                    <button
                      type="button"
                      ref={resultActionRef}
                      onClick={() => void handleCommit(outcome.retryIds)}
                      disabled={committing}
                      aria-describedby={RESULT_PANEL_ID}
                      className="h-8 px-3 rounded bg-sage-500 text-navy-900 border border-sage-600 text-xs font-medium
                        hover:bg-sage-400 disabled:opacity-50 disabled:cursor-not-allowed
                        dark:bg-sage-400 dark:text-navy-900 dark:border-sage-500 dark:hover:bg-sage-300
                        focus:outline-none focus:ring-2 focus:ring-navy-700 focus:ring-offset-1 focus:ring-offset-sage-500"
                    >
                      {committing
                        ? 'Retrying…'
                        : `Retry ${outcome.retryIds.length} ${plural(outcome.retryIds.length, 'story', 'stories')}`}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-neutral-text-secondary tppm-mono">
                    {selected.size} selected · {selectedPoints} pts
                  </span>
                  {pointsChip && (
                    <span
                      className={`tppm-mono text-xs px-2 py-0.5 rounded-full border shrink-0 ${
                        pointsChip.variant === 'critical'
                          ? 'bg-semantic-critical-bg border-semantic-critical/40 text-semantic-critical'
                          : 'bg-brand-primary-light border-brand-primary/30 text-brand-primary-dark'
                      }`}
                      aria-label={`If committed: ${pointsChip.total} of ${pointsChip.capacity} ${itl.lower} points, ${pointsChip.pct} percent of capacity`}
                    >
                      If committed: {pointsChip.total}/{pointsChip.capacity} pts · {pointsChip.pct}%
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-8 px-3 rounded border border-neutral-border text-xs font-medium text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCommit(Array.from(selected))}
                    disabled={selected.size === 0 || committing}
                    className="h-8 px-3 rounded bg-sage-500 text-navy-900 border border-sage-600 text-xs font-medium
                      hover:bg-sage-400 disabled:opacity-50 disabled:cursor-not-allowed
                      dark:bg-sage-400 dark:text-navy-900 dark:border-sage-500 dark:hover:bg-sage-300
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-1 focus-visible:ring-offset-sage-500"
                  >
                    {committing
                      ? 'Committing…'
                      : selected.size === 0
                        ? 'Commit stories'
                        : `Commit ${selected.size} ${plural(selected.size, 'story', 'stories')}`}
                  </button>
                </div>
              </>
            )}
          </footer>
        </div>
      </div>
    </>
  );
}

/**
 * The reconciliation phase: what the 207 actually said, per row (#2914).
 *
 * The WHOLE breakdown is the live region, not just the committed count — a screen
 * reader that announces "37 of 40 committed" and stops has withheld the only part
 * anybody can act on, which is which three and why. Same reasoning as the bulk-edit
 * sheet's result phase (`buildMode/bulkEdit/BulkEditSheet.tsx`).
 */
function CommitResultPanel({
  outcome,
  sprintLabel,
}: {
  outcome: StoryCommitOutcome;
  sprintLabel: string;
}) {
  return (
    <div
      id={RESULT_PANEL_ID}
      role="status"
      aria-live="polite"
      data-testid="story-picker-result"
      className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
    >
      <p className="text-sm font-medium text-neutral-text-primary">
        Committed {outcome.committedCount} of {outcome.sentCount}{' '}
        {plural(outcome.sentCount, 'story', 'stories')} to {sprintLabel}.
      </p>

      {outcome.rejected.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            {outcome.rejected.length} not committed
          </p>
          <ul className="space-y-1">
            {outcome.rejected.map((row) => (
              <li
                key={row.index}
                className="text-xs text-neutral-text-primary leading-snug flex gap-1.5"
              >
                <WarningIcon
                  className="h-3 w-3 mt-0.5 shrink-0 text-semantic-critical"
                  aria-hidden="true"
                />
                <span>
                  <span className="font-medium">{row.name}</span>{' '}
                  <span className="text-neutral-text-secondary">— {row.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.skipped.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            {outcome.skipped.length} left unchanged
          </p>
          <ul className="space-y-1">
            {outcome.skipped.map((row) => (
              <li key={row.index} className="text-xs text-neutral-text-secondary leading-snug">
                <span className="font-medium text-neutral-text-primary">{row.name}</span> —{' '}
                {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.retryIds.length === 0 && outcome.rejected.length > 0 && (
        // Every rejection came back without an id (refused before it parsed), so
        // there is nothing a retry could target — say so rather than leaving the
        // missing button to be read as "nothing more to do".
        <p className="text-xs text-neutral-text-secondary">
          These rows can&apos;t be retried from here — reopen the picker and select them again.
        </p>
      )}
    </div>
  );
}
