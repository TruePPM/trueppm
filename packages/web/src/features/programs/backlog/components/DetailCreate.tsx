/**
 * Create-item form, rendered in the right pane (no modal — decision D5). Title
 * is required and auto-focused; everything else has a sensible default. Status
 * is implicit PROPOSED and priority lands at the bottom, so neither is a field.
 * Validation is reveal-on-submit (don't pre-disable Create) per the spec.
 */

import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '@/components/Icons';
import { BACKLOG_ITEM_TYPES, type BacklogItemType } from '../types';
import type { CreateBacklogItemInput } from '../hooks/useBacklogMutations';
import { TagInput } from './TagInput';
import { BTN_GHOST, BTN_PRIMARY, FOCUS_RING, INPUT_BASE } from './styles';

const TYPE_LABELS: Record<BacklogItemType, string> = {
  story: 'Story',
  epic: 'Epic',
  spike: 'Spike',
  chore: 'Chore',
  bug: 'Bug',
};

interface DetailCreateProps {
  tagSuggestions: string[];
  onCancel: () => void;
  onCreate: (input: CreateBacklogItemInput) => Promise<void>;
}

export function DetailCreate({ tagSuggestions, onCancel, onCreate }: DetailCreateProps) {
  const [title, setTitle] = useState('');
  const [itemType, setItemType] = useState<BacklogItemType>('story');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Focus the title on open (programmatic — jsx-a11y forbids the autoFocus prop).
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function submit() {
    if (!title.trim()) {
      setError('Give the item a title before creating it.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        title,
        itemType,
        description: description || undefined,
        tags,
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
          onClick={onCancel}
          aria-label="Cancel"
          className={`flex h-8 w-8 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
            value={itemType}
            onChange={(e) => setItemType(e.target.value as BacklogItemType)}
            className={`mt-1 h-8 ${INPUT_BASE}`}
          >
            {BACKLOG_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="backlog-create-desc"
            className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary"
          >
            Description
          </label>
          <textarea
            id="backlog-create-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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
              tags={tags}
              onChange={setTags}
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
          <button type="button" className={BTN_GHOST} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => void submit()}
            disabled={submitting}
          >
            Create item
          </button>
        </div>
      </div>
    </div>
  );
}
