/**
 * Story-detail grooming drawer (#1043 / #731).
 *
 * Opens from a backlog row as a right-side slide-in (480px) on desktop and a
 * bottom sheet on mobile (web-rule 89). Inline-edits a story's title, description,
 * acceptance criteria, scoring inputs (live preview), epic, points, and DoR.
 *
 * Save model (web-rule 164): the scalar fields (title/description/type/epic/points/
 * scoring) batch into ONE PATCH behind a deferred Save bar shown only while dirty.
 * Acceptance criteria and the DoR state mutate immediately (a different endpoint /
 * a server-gated semantic toggle), so the readiness gate re-evaluates live as the
 * team ticks criteria. Structural fields (type/epic/scoring) render read-only for
 * callers without backlog-manage rights — the server is the real gate.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmDiscardDialog } from '@/features/settings/components/ConfirmDiscardDialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { DorState, Task, TaskType } from '@/types';
import { useSetDor } from '../hooks/useProductBacklog';
import { usePatchStory } from '../hooks/useStoryDetail';
import type { ProductBacklog } from '../types';
import { AcceptanceCriteriaList } from './AcceptanceCriteriaList';
import { DorControl } from './DorControl';
import { ScoringInputs } from './ScoringInputs';
import { TypeBadge } from './TypeBadge';
import type { ScoringInputValues } from '../scorePreview';

const FIBONACCI = [1, 2, 3, 5, 8, 13, 21];

interface ScalarDraft extends ScoringInputValues {
  name: string;
  notes: string;
  type: TaskType;
  parentEpic: string | null;
  storyPoints: number | null;
}

function toDraft(s: Task): ScalarDraft {
  return {
    name: s.name,
    notes: s.notes ?? '',
    type: s.taskType ?? 'story',
    parentEpic: s.parentEpic ?? null,
    storyPoints: s.storyPoints ?? null,
    businessValue: s.businessValue ?? null,
    timeCriticality: s.timeCriticality ?? null,
    riskReduction: s.riskReduction ?? null,
    jobSize: s.jobSize ?? null,
    reach: s.reach ?? null,
    impact: s.impact ?? null,
    confidence: s.confidence ?? null,
    effort: s.effort ?? null,
    value: s.value ?? null,
    effortEstimate: s.effortEstimate ?? null,
  };
}

/** Only the fields that changed vs. the last-saved snapshot — keeps a Member's
 *  title-only edit from posting Admin-gated structural fields it never touched. */
function changedFields(draft: ScalarDraft, initial: ScalarDraft): Partial<ScalarDraft> {
  const out: Partial<ScalarDraft> = {};
  (Object.keys(draft) as (keyof ScalarDraft)[]).forEach((k) => {
    if (draft[k] !== initial[k]) (out[k] as unknown) = draft[k];
  });
  return out;
}

interface StoryDetailDrawerProps {
  projectId: string;
  story: Task;
  backlog: ProductBacklog;
  canManageBacklog: boolean;
  onClose: () => void;
}

export function StoryDetailDrawer({
  projectId,
  story,
  backlog,
  canManageBacklog,
  onClose,
}: StoryDetailDrawerProps) {
  const patchStory = usePatchStory(projectId);
  const setDor = useSetDor(projectId);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Non-modal beside the list on desktop, true modal bottom-sheet on mobile —
  // aria-modal and the Tab focus-trap track the viewport (issue 1357).
  const isMobile = useBreakpoint() === 'sm';

  const [draft, setDraft] = useState<ScalarDraft>(() => toDraft(story));
  const [initial, setInitial] = useState<ScalarDraft>(() => toDraft(story));
  // Styled, focus-trapped discard prompt in place of the native window.confirm
  // (issue 1357).
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Suspend the drawer's own trap while the discard prompt is up so its trap
  // (active on mobile) doesn't fight the dialog's trap for the same Tab cycle.
  const trapRef = useFocusTrap<HTMLDivElement>(isMobile && !confirmDiscard);

  // Focus the close button when the drawer mounts/swaps stories.
  useEffect(() => {
    const t = setTimeout(() => closeRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );

  function set<K extends keyof ScalarDraft>(key: K, val: ScalarDraft[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function requestClose() {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function handleSave() {
    const patch = changedFields(draft, initial);
    if (Object.keys(patch).length === 0) return;
    patchStory.mutate(
      { taskId: story.id, patch },
      { onSuccess: () => setInitial(draft) },
    );
  }

  function handleCancel() {
    setDraft(initial);
  }

  // Readiness gate (server-authoritative, mirrored client-side from the live
  // AC counts + the SAVED estimate). Points edits are deferred, so Ready reflects
  // a new estimate only after Save; AC ticks are immediate, so they re-enable live.
  const acTotal = story.acTotal ?? story.acceptanceCriteria?.length ?? 0;
  const acMet =
    story.acMet ?? story.acceptanceCriteria?.filter((c) => c.met).length ?? 0;
  const readyReasons: string[] = [];
  if (story.storyPoints == null) readyReasons.push('needs an estimate');
  if (acTotal === 0) readyReasons.push('add at least one acceptance criterion');
  else if (acMet < acTotal) readyReasons.push('all acceptance criteria must be met');
  const canBeReady = readyReasons.length === 0;

  const epics = backlog.epics.map((g) => g.epic);
  const model = backlog.scoring.model;

  function changeDor(dor: DorState) {
    setDor.mutate({ taskId: story.id, dor });
  }

  return (
    <>
      {/* Mobile backdrop only — desktop drawer is non-modal, the list stays usable. */}
      <div
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
        aria-hidden
        onClick={requestClose}
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal={isMobile}
        aria-label={story.name || 'Story detail'}
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-50 flex h-[85vh] flex-col rounded-t-card border-t border-neutral-border bg-neutral-surface md:absolute md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[480px] md:rounded-none md:border-l md:border-t-0 focus:outline-none"
      >
        {/* Mobile drag-handle affordance. */}
        <div
          className="mx-auto mt-2 h-1 w-8 shrink-0 rounded-full bg-neutral-border md:hidden"
          aria-hidden
        />

        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-border px-4">
          <TypeBadge type={story.taskType} />
          {story.shortId && (
            <span className="tppm-mono text-xs text-neutral-text-secondary">
              {story.shortId}
            </span>
          )}
          <div className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            onClick={requestClose}
            aria-label="Close story detail"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Title</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              aria-label="Story title"
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Description</span>
            <textarea
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={4}
              aria-label="Story description"
              className="resize-y rounded-control border border-neutral-border bg-neutral-surface px-2 py-1.5 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </label>

          <AcceptanceCriteriaList
            projectId={projectId}
            taskId={story.id}
            criteria={story.acceptanceCriteria ?? []}
          />

          <DorControl
            dor={story.dor ?? 'idea'}
            onChange={changeDor}
            canBeReady={canBeReady}
            blockerReasons={readyReasons}
            disabled={setDor.isPending}
          />

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Story points</span>
            <select
              value={draft.storyPoints ?? ''}
              onChange={(e) => set('storyPoints', e.target.value === '' ? null : Number(e.target.value))}
              aria-label="Story points"
              className="h-9 w-28 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <option value="">—</option>
              {FIBONACCI.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Epic</span>
            {canManageBacklog ? (
              <select
                value={draft.parentEpic ?? ''}
                onChange={(e) => set('parentEpic', e.target.value === '' ? null : e.target.value)}
                aria-label="Parent epic"
                className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                <option value="">No epic (ungrouped)</option>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.shortId ? ` (${e.shortId})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span className="px-2 py-1.5 text-sm text-neutral-text-primary">
                {epics.find((e) => e.id === draft.parentEpic)?.name ?? 'No epic'}
              </span>
            )}
          </label>

          <ScoringInputs
            model={model}
            values={draft}
            onChange={(key, val) => set(key, val)}
            readOnly={!canManageBacklog}
          />
        </div>

        {/* Deferred save bar — only while the scalar form is dirty. */}
        {dirty && (
          <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-neutral-border px-4">
            <span className="mr-auto text-xs text-neutral-text-secondary">Unsaved changes</span>
            {patchStory.isError && (
              <span role="alert" className="text-xs text-semantic-critical">
                Save failed
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={patchStory.isPending}>
              {patchStory.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      {confirmDiscard && (
        <ConfirmDiscardDialog
          onKeepEditing={() => setConfirmDiscard(false)}
          onDiscard={onClose}
        />
      )}
    </>
  );
}
