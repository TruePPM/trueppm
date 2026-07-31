/**
 * Right-pane detail/edit view for a selected item.
 *
 * Editable fields (description, type, status, tags) stage into a local draft
 * behind a single deferred Save/Cancel bar (web-rule 217) — the shared
 * `useDirtyDraft` + `DialogFooter` + `useUnsavedChangesGuard` +
 * `UnsavedChangesDialog` contract from `@/components/dialog`, the same one
 * `DetailCreate` already uses (#2668, consolidating the drawer's previous
 * two independent "Save changes" buttons into one). The status dropdown
 * omits PULLED — that transition only happens through the Pull action
 * (ADR-0069). PULLED items show the linked-task card and a brief "Send back
 * to proposed" escape hatch. (The API models no assignee, so there is no
 * owner field.)
 *
 * The parent keys this component by item id, so selecting a different row
 * remounts it with a fresh draft.
 */

import { useState } from 'react';
import { CloseIcon, ExternalLinkIcon } from '@/components/Icons';
import {
  DialogFooter,
  UnsavedChangesDialog,
  useDirtyDraft,
  useUnsavedChangesGuard,
} from '@/components/dialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  BACKLOG_ITEM_TYPES,
  SETTABLE_STATUSES,
  itemTypeShowsPoints,
  type BacklogItem,
  type BacklogItemType,
} from '../types';
import { ItemTypeBadge } from './ItemTypeBadge';
import { StatusChip } from './StatusChip';
import { TagInput } from './TagInput';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, FOCUS_RING, INPUT_BASE } from './styles';
import { StoryPointField } from '@/features/backlog/StoryPointField';
import { formatStoryPoints } from '@/lib/storyPoints';
import type { EstimationScale } from '@/api/types';

const TYPE_LABELS: Record<BacklogItemType, string> = {
  story: 'Story',
  epic: 'Epic',
  feature: 'Feature',
  task: 'Task',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

const STATUS_LABELS = { PROPOSED: 'Proposed', PULLED: 'Pulled', ARCHIVED: 'Archived' } as const;

const SEND_BACK_WINDOW_MS = 8000;

interface DetailDraft {
  description: string;
  itemType: BacklogItemType;
  status: BacklogItem['status'];
  tags: string[];
  storyPoints: number | null;
}

function toDraft(item: BacklogItem): DetailDraft {
  return {
    description: item.description ?? '',
    itemType: item.itemType,
    status: item.status,
    tags: item.tags,
    storyPoints: item.storyPoints ?? null,
  };
}

export interface DetailViewProps {
  item: BacklogItem;
  tagSuggestions: string[];
  /** Program's resolved estimation scale (ADR-0510, #2027). */
  estimationScale: EstimationScale;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  /**
   * Resolves once the PATCH round-trips (rejects on failure) so the drawer can
   * re-baseline the draft on success and keep it dirty — with a visible error —
   * on failure (#2668; previously fire-and-forget with no save feedback at all).
   */
  onSave: (patch: Partial<BacklogItem>) => Promise<void>;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onSendBack: () => void;
  onPull: () => void;
  onOpenLinkedTask: () => void;
}

export function DetailView({
  item,
  tagSuggestions,
  estimationScale,
  canEdit,
  canDelete,
  onClose,
  onSave,
  onArchive,
  onRestore,
  onDelete,
  onSendBack,
  onPull,
  onOpenLinkedTask,
}: DetailViewProps) {
  // Draft/baseline/dirty + revert + post-save re-snapshot — the shared
  // editable-surface contract (web-rule 217), replacing the hand-rolled copy
  // that compared against the live `item` prop every render (and so never
  // noticed a dirty draft belonged to a *different* item once #2668 wired up
  // the missing `key` on this component).
  const { draft, setField, dirty, reset, commit } = useDirtyDraft<DetailDraft>(toDraft(item));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The wrapping mobile BottomSheet already handles Escape/scrim dismissal, so
  // the desktop pane owns the Escape-to-close guard; on mobile it would double
  // up with the sheet's own listener (mirrors DetailCreate, web-rule 217).
  const isDesktop = useBreakpoint() !== 'sm';
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty,
    onClose,
    escapeToClose: isDesktop,
  });

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        description: draft.description.trim() || undefined,
        itemType: draft.itemType,
        status: draft.status,
        tags: draft.tags,
        storyPoints: draft.storyPoints,
      });
      commit();
    } catch {
      setSaveError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const recentlyPulled =
    item.status === 'PULLED' &&
    !!item.pulledTo &&
    Date.now() - new Date(item.pulledTo.at).getTime() < SEND_BACK_WINDOW_MS;

  // The status-action footer below is worth rendering only when it has
  // something in it — a PULLED item outside the send-back window has no
  // action left (Save now lives in the deferred bar above), so skip the
  // otherwise-empty bar rather than show a bare border (#2668).
  const showActionFooter = item.status !== 'PULLED' || recentlyPulled;

  return (
    <div className="flex h-full flex-col bg-neutral-surface">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-neutral-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="tppm-mono text-xs text-neutral-text-disabled" title={item.id}>
              {item.id.slice(0, 8)}
            </span>
            <ItemTypeBadge type={draft.itemType} />
            <StatusChip status={item.status} />
          </div>
          <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-neutral-text-primary">
            {item.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close details"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
        >
          <CloseIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* Deferred Save/Cancel bar (web-rule 217) — the drawer's ONE commit
          affordance. It sits above the scrollable body, not inside it, so the
          tag combobox's popover — which opens downward from the Tags field
          near the bottom of the body — can never land on top of it (#2668:
          previously the second, disabled "Save changes" button lived in the
          footer below the body, squarely under that popover). */}
      {dirty && (
        <DialogFooter
          onSave={() => void save()}
          onCancel={reset}
          saving={saving}
          error={saveError}
          saveLabel="Save changes"
          cancelLabel="Discard"
        />
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary">
          Description
        </div>
        {canEdit ? (
          <textarea
            value={draft.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="No description yet. Click to add one."
            rows={4}
            className={`mt-1 resize-y py-1.5 ${INPUT_BASE}`}
          />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-text-primary">
            {item.description || (
              <span className="italic text-neutral-text-disabled">No description.</span>
            )}
          </p>
        )}

        <div className="mt-4 grid grid-cols-[100px_1fr] items-center gap-x-3.5 gap-y-3 text-xs">
          <label className="text-neutral-text-secondary" htmlFor={`${item.id}-type`}>
            Type
          </label>
          {canEdit ? (
            <select
              id={`${item.id}-type`}
              value={draft.itemType}
              onChange={(e) => {
                // Switching to a container type (epic/feature) drops the now-hidden
                // points so a leaf estimate never persists silently on a container.
                const next = e.target.value as BacklogItemType;
                setField('itemType', next);
                if (!itemTypeShowsPoints(next)) setField('storyPoints', null);
              }}
              className={`h-8 ${INPUT_BASE}`}
            >
              {BACKLOG_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-neutral-text-primary">{TYPE_LABELS[item.itemType]}</span>
          )}

          <label className="text-neutral-text-secondary" htmlFor={`${item.id}-status`}>
            Status
          </label>
          {item.status === 'PULLED' ? (
            <span className="text-neutral-text-primary">{STATUS_LABELS.PULLED}</span>
          ) : canEdit ? (
            <select
              id={`${item.id}-status`}
              value={draft.status}
              onChange={(e) => setField('status', e.target.value as BacklogItem['status'])}
              className={`h-8 ${INPUT_BASE}`}
            >
              {SETTABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-neutral-text-primary">{STATUS_LABELS[item.status]}</span>
          )}

          <span className="text-neutral-text-secondary">Priority</span>
          <span className="tppm-mono tabular-nums text-neutral-text-primary">
            {/* Null is a real, common state — nothing assigns a rank until
                #2668 wired `nextPriorityRank` into create — so it renders as an
                explicit dash, never a bare, meaning-nothing "#". */}
            {item.priorityRank === null ? (
              <span className="text-neutral-text-disabled">—</span>
            ) : (
              `#${item.priorityRank}`
            )}
          </span>

          {/* Points are relevant only for leaf work items — Epics/Features hide
              them (#2026). Gate on the live draft type so the field appears and
              disappears as the user changes the type in this same pane. */}
          {itemTypeShowsPoints(draft.itemType) && (
            <>
              <label className="text-neutral-text-secondary" htmlFor={`${item.id}-points`}>
                Story points
              </label>
              {canEdit ? (
                <StoryPointField
                  id={`${item.id}-points`}
                  scale={estimationScale}
                  value={draft.storyPoints}
                  onChange={(next) => setField('storyPoints', next)}
                  ariaLabel="Story points"
                  size="md"
                  className="w-24"
                />
              ) : (
                <span className="tabular-nums text-neutral-text-primary">
                  {item.storyPoints === null || item.storyPoints === undefined ? (
                    <span className="text-neutral-text-disabled">—</span>
                  ) : (
                    formatStoryPoints(item.storyPoints, estimationScale)
                  )}
                </span>
              )}
            </>
          )}

          <span className="self-start pt-1.5 text-neutral-text-secondary">Tags</span>
          {canEdit ? (
            <TagInput
              tags={draft.tags}
              onChange={(tags) => setField('tags', tags)}
              suggestions={tagSuggestions}
              id={`${item.id}-tags`}
            />
          ) : (
            <span className="flex flex-wrap gap-1">
              {item.tags.length === 0 && <span className="text-neutral-text-disabled">None</span>}
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-xs text-neutral-text-secondary"
                >
                  {tag}
                </span>
              ))}
            </span>
          )}
        </div>

        {/* Linked task (PULLED only) */}
        {item.status === 'PULLED' && item.pulledTo && (
          <div className="mt-5">
            <div className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary">
              Linked task
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 rounded-card border border-neutral-border bg-neutral-surface-sunken px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand-primary"
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-neutral-text-primary">
                    {item.title}
                  </div>
                  <div className="text-xs text-neutral-text-secondary">
                    Backlog{item.pulledTo.projectName ? ` · ${item.pulledTo.projectName}` : ''}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenLinkedTask}
                className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-primary ${FOCUS_RING}`}
              >
                Open
                <ExternalLinkIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer — status-specific actions only. Save/Cancel lives in the
          deferred bar above (#2668 removed the duplicate, disabled
          "Save changes" button that used to live here). */}
      {canEdit && showActionFooter && (
        <div className="flex items-center gap-2 border-t border-neutral-border bg-neutral-surface-raised px-5 py-3">
          {item.status === 'PROPOSED' && (
            <>
              <button type="button" className={BTN_GHOST} onClick={onArchive}>
                Archive
              </button>
              <span className="flex-1" />
              <button type="button" className={BTN_PRIMARY} onClick={onPull}>
                Pull to project…
              </button>
            </>
          )}
          {item.status === 'PULLED' && recentlyPulled && (
            <button type="button" className={BTN_GHOST} onClick={onSendBack}>
              Send back to proposed
            </button>
          )}
          {item.status === 'ARCHIVED' && (
            <>
              <button type="button" className={BTN_GHOST} onClick={onRestore}>
                Restore
              </button>
              <span className="flex-1" />
              {canDelete && (
                <button type="button" className={BTN_DANGER} onClick={onDelete}>
                  Delete permanently
                </button>
              )}
            </>
          )}
        </div>
      )}

      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
    </div>
  );
}
