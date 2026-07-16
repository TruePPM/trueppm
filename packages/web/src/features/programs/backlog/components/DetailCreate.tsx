/**
 * Create-item form, rendered in the right pane (no modal — decision D5). Title
 * is required and auto-focused; everything else has a sensible default. Status
 * is implicit PROPOSED and priority lands at the bottom, so neither is a field.
 * Validation is reveal-on-submit (don't pre-disable Create) per the spec.
 *
 * The form collects new information, so it carries the shared unsaved-changes
 * contract (web-rule 217): a typed-but-unsubmitted draft is guarded on Cancel /
 * ✕ / desktop-Escape via `useDirtyDraft` + `useUnsavedChangesGuard` +
 * `UnsavedChangesDialog`, never discarded silently. On mobile the wrapping
 * `BottomSheet` owns Escape/scrim dismissal, so the desktop-only Escape guard
 * keys off the viewport tier.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { CloseIcon } from '@/components/Icons';
import {
  UnsavedChangesDialog,
  useDirtyDraft,
  useUnsavedChangesGuard,
} from '@/components/dialog';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BACKLOG_ITEM_TYPES, itemTypeShowsPoints, type BacklogItemType } from '../types';
import type { CreateBacklogItemInput } from '../hooks/useBacklogMutations';
import { TagInput } from './TagInput';
import { FOCUS_RING, INPUT_BASE } from './styles';

const TYPE_LABELS: Record<BacklogItemType, string> = {
  story: 'Story',
  epic: 'Epic',
  feature: 'Feature',
  task: 'Task',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

interface CreateDraft {
  title: string;
  itemType: BacklogItemType;
  /** Raw input string; '' = unestimated. Parsed to a number on submit. */
  storyPoints: string;
  description: string;
  tags: string[];
}

const EMPTY_DRAFT: CreateDraft = {
  title: '',
  itemType: 'story',
  storyPoints: '',
  description: '',
  tags: [],
};

interface DetailCreateProps {
  tagSuggestions: string[];
  onCancel: () => void;
  onCreate: (input: CreateBacklogItemInput) => Promise<void>;
}

export function DetailCreate({ tagSuggestions, onCancel, onCreate }: DetailCreateProps) {
  const { draft, setField, setDraft, dirty } = useDirtyDraft<CreateDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // The wrapping mobile <BottomSheet> already handles Escape/scrim dismissal, so
  // the desktop pane owns the Escape-to-cancel guard; on mobile it would double
  // up with the sheet's own listener (web-rule 217 / #1996 item 8).
  const isDesktop = useBreakpoint() !== 'sm';
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty,
    onClose: onCancel,
    escapeToClose: isDesktop,
  });

  // Focus the title on open (programmatic — jsx-a11y forbids the autoFocus prop).
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function submit() {
    if (!draft.title.trim()) {
      setError('Give the item a title before creating it.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        title: draft.title,
        itemType: draft.itemType,
        description: draft.description || undefined,
        tags: draft.tags,
        // Empty field → null (unestimated); otherwise the parsed points. The input
        // is number-typed with a 0 floor, so a non-empty value is a valid integer.
        storyPoints: draft.storyPoints.trim() === '' ? null : Number(draft.storyPoints),
      });
    } catch {
      setError('Could not create the item. Try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-neutral-surface">
      <div className="flex items-center justify-between border-b border-neutral-border px-5 py-4">
        <h2 className="text-sm font-semibold text-neutral-text-primary">New backlog item</h2>
        <button
          type="button"
          onClick={requestClose}
          aria-label="Cancel"
          className={`flex h-11 w-11 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken md:h-8 md:w-8 ${FOCUS_RING}`}
        >
          <CloseIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <label
            htmlFor="backlog-create-title"
            className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary"
          >
            Title <span className="text-semantic-critical">*</span>
          </label>
          <input
            id="backlog-create-title"
            ref={titleRef}
            value={draft.title}
            onChange={(e) => setField('title', e.target.value)}
            placeholder="Short, action-oriented title…"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'backlog-create-error' : undefined}
            className={`mt-1 h-8 ${INPUT_BASE} ${error ? 'border-semantic-critical' : ''}`}
          />
          {error && (
            <p id="backlog-create-error" className="mt-1 text-xs text-semantic-critical">
              {error}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="backlog-create-type"
            className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary"
          >
            Type
          </label>
          <select
            id="backlog-create-type"
            value={draft.itemType}
            onChange={(e) => {
              // Switching to a container type (epic/feature) drops the now-hidden
              // points so a leaf estimate never ships on a container (#2026).
              const next = e.target.value as BacklogItemType;
              setDraft((d) => ({
                ...d,
                itemType: next,
                storyPoints: itemTypeShowsPoints(next) ? d.storyPoints : '',
              }));
            }}
            className={`mt-1 h-8 ${INPUT_BASE}`}
          >
            {BACKLOG_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {/* Points show only for estimable leaf types — Epics/Features hide them
            (#2026). Gated on the live draft type so it toggles with the picker. */}
        {itemTypeShowsPoints(draft.itemType) && (
          <div>
            <label
              htmlFor="backlog-create-points"
              className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary"
            >
              Story points
            </label>
            <input
              id="backlog-create-points"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={draft.storyPoints}
              onChange={(e) => setField('storyPoints', e.target.value)}
              placeholder="Optional estimate"
              className={`mt-1 h-8 w-32 ${INPUT_BASE}`}
            />
          </div>
        )}

        <div>
          <label
            htmlFor="backlog-create-desc"
            className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary"
          >
            Description
          </label>
          <textarea
            id="backlog-create-desc"
            value={draft.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="What does this item entail?…"
            rows={5}
            className={`mt-1 resize-y py-1.5 ${INPUT_BASE}`}
          />
        </div>

        <div>
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary">
            Tags
          </span>
          <div className="mt-1">
            <TagInput
              tags={draft.tags}
              onChange={(next) => setField('tags', next)}
              suggestions={tagSuggestions}
              id="backlog-create-tags"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-neutral-border bg-neutral-surface-raised px-5 py-3">
        <span className="text-xs text-neutral-text-secondary">
          Lands as Proposed, ranked at the bottom.
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px] md:min-h-0"
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            className="min-h-[44px] md:min-h-0"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? 'Creating…' : 'Create item'}
          </Button>
        </div>
      </div>

      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
    </div>
  );
}
