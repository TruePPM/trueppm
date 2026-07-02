/**
 * Right-pane detail/edit view for a selected item.
 *
 * Editable fields (description, type, status, tags) stage into a local draft;
 * an inline "Unsaved changes" banner (never a modal) offers Save / Discard
 * while the draft diverges from the server copy. The status dropdown omits
 * PULLED — that transition only happens through the Pull action (ADR-0069).
 * PULLED items show the linked-task card and a brief "Send back to proposed"
 * escape hatch. (The API models no assignee, so there is no owner field.)
 *
 * The parent keys this component by item id, so selecting a different row
 * remounts it with a fresh draft.
 */

import { useMemo, useState } from 'react';
import { CloseIcon, ExternalLinkIcon } from '@/components/Icons';
import {
  BACKLOG_ITEM_TYPES,
  SETTABLE_STATUSES,
  type BacklogItem,
  type BacklogItemType,
} from '../types';
import { ItemTypeBadge } from './ItemTypeBadge';
import { StatusChip } from './StatusChip';
import { TagInput } from './TagInput';
import {
  BTN_DANGER,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SECONDARY,
  FOCUS_RING,
  INPUT_BASE,
} from './styles';

const TYPE_LABELS: Record<BacklogItemType, string> = {
  story: 'Story',
  epic: 'Epic',
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
}

function toDraft(item: BacklogItem): DetailDraft {
  return {
    description: item.description ?? '',
    itemType: item.itemType,
    status: item.status,
    tags: item.tags,
  };
}

export interface DetailViewProps {
  item: BacklogItem;
  tagSuggestions: string[];
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onSave: (patch: Partial<BacklogItem>) => void;
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
  const [draft, setDraft] = useState<DetailDraft>(() => toDraft(item));

  const dirty = useMemo(() => {
    const base = toDraft(item);
    return (
      base.description !== draft.description ||
      base.itemType !== draft.itemType ||
      base.status !== draft.status ||
      base.tags.join(' ') !== draft.tags.join(' ')
    );
  }, [item, draft]);

  function save() {
    onSave({
      description: draft.description.trim() || undefined,
      itemType: draft.itemType,
      status: draft.status,
      tags: draft.tags,
    });
  }

  const recentlyPulled =
    item.status === 'PULLED' &&
    !!item.pulledTo &&
    Date.now() - new Date(item.pulledTo.at).getTime() < SEND_BACK_WINDOW_MS;

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
          onClick={onClose}
          aria-label="Close details"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
        >
          <CloseIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* Unsaved-changes banner (inline, not a modal) */}
      {dirty && (
        <div className="flex items-center justify-between gap-3 border-b border-brand-accent-dark/40 bg-brand-accent-light px-5 py-2">
          <span className="text-xs font-medium text-neutral-text-primary">Unsaved changes</span>
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_GHOST} onClick={() => setDraft(toDraft(item))}>
              Discard
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={save}>
              Save changes
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="text-xs font-semibold uppercase tracking-[0.06em] text-neutral-text-secondary">
          Description
        </div>
        {canEdit ? (
          <textarea
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
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
              onChange={(e) =>
                setDraft((d) => ({ ...d, itemType: e.target.value as BacklogItemType }))
              }
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
              onChange={(e) =>
                setDraft((d) => ({ ...d, status: e.target.value as BacklogItem['status'] }))
              }
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
            #{item.priorityRank}
          </span>

          <span className="self-start pt-1.5 text-neutral-text-secondary">Tags</span>
          {canEdit ? (
            <TagInput
              tags={draft.tags}
              onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
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

      {/* Footer — actions vary by status */}
      {canEdit && (
        <div className="flex items-center gap-2 border-t border-neutral-border bg-neutral-surface-raised px-5 py-3">
          {item.status === 'PROPOSED' && (
            <>
              <button type="button" className={BTN_GHOST} onClick={onArchive}>
                Archive
              </button>
              <span className="flex-1" />
              <button type="button" className={BTN_SECONDARY} onClick={save} disabled={!dirty}>
                Save changes
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={onPull}>
                Pull to project…
              </button>
            </>
          )}
          {item.status === 'PULLED' && (
            <>
              {recentlyPulled && (
                <button type="button" className={BTN_GHOST} onClick={onSendBack}>
                  Send back to proposed
                </button>
              )}
              <span className="flex-1" />
              <button type="button" className={BTN_SECONDARY} onClick={save} disabled={!dirty}>
                Save changes
              </button>
            </>
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
    </div>
  );
}
