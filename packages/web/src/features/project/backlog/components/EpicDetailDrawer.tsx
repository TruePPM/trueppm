/**
 * Epic-detail grooming drawer (issue 1346).
 *
 * Opens from an epic header on the Product Backlog as a right-side slide-in (480px) on
 * desktop and a bottom sheet on mobile (web-rule 89) — the same chrome as
 * {@link StoryDetailDrawer}, so an epic is edited the same way as a story rather than
 * through a hidden rename menu. An epic is a grouping Task excluded from scheduling, so
 * the drawer exposes only its identity fields: **name** and **description** (the API's
 * `notes`). Both batch into ONE PATCH behind a deferred Save bar shown only while dirty
 * (web-rule 164). The drawer is opened only for a backlog manager (`epic.canEdit`); the
 * server is the real gate (a 403 surfaces as a save error).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import type { Task } from '@/types';
import { usePatchEpic } from '../hooks/useProductBacklog';
import type { EpicScalarPatch } from '../api';
import { TypeBadge } from './TypeBadge';

interface Draft {
  name: string;
  notes: string;
}

function toDraft(epic: Task): Draft {
  return { name: epic.name, notes: epic.notes ?? '' };
}

/** Only the fields that changed vs. the last-saved snapshot — a description-only edit
 *  never re-sends the (unchanged) name and vice-versa. */
function changedFields(draft: Draft, initial: Draft): EpicScalarPatch {
  const out: EpicScalarPatch = {};
  if (draft.name !== initial.name) out.name = draft.name;
  if (draft.notes !== initial.notes) out.notes = draft.notes;
  return out;
}

interface EpicDetailDrawerProps {
  projectId: string;
  epic: Task;
  onClose: () => void;
}

export function EpicDetailDrawer({ projectId, epic, onClose }: EpicDetailDrawerProps) {
  const patchEpic = usePatchEpic(projectId);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [draft, setDraft] = useState<Draft>(() => toDraft(epic));
  const [initial, setInitial] = useState<Draft>(() => toDraft(epic));

  // Focus the close button when the drawer mounts.
  useEffect(() => {
    const t = setTimeout(() => closeRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  // The server rejects an empty epic name; block the save (with a hint) rather than letting a
  // blank name silently swallow an otherwise-valid description edit.
  const nameBlank = draft.name.trim() === '';

  function set<K extends keyof Draft>(key: K, val: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function requestClose() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
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
    if (nameBlank) return;
    const patch = changedFields(draft, initial);
    if (Object.keys(patch).length === 0) return;
    patchEpic.mutate({ epicId: epic.id, patch }, { onSuccess: () => setInitial(draft) });
  }

  function handleCancel() {
    setDraft(initial);
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
        role="dialog"
        aria-modal="false"
        aria-label={epic.name || 'Epic detail'}
        className="fixed inset-x-0 bottom-0 z-50 flex h-[85vh] flex-col rounded-t-card border-t border-neutral-border bg-neutral-surface md:absolute md:inset-y-0 md:left-auto md:right-0 md:h-full md:w-[480px] md:rounded-none md:border-l md:border-t-0"
      >
        {/* Mobile drag-handle affordance. */}
        <div
          className="mx-auto mt-2 h-1 w-8 shrink-0 rounded-full bg-neutral-border md:hidden"
          aria-hidden
        />

        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-neutral-border px-4">
          <TypeBadge type="epic" />
          {epic.shortId && (
            <span className="tppm-mono text-[11px] text-neutral-text-secondary">
              {epic.shortId}
            </span>
          )}
          <div className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            onClick={requestClose}
            aria-label="Close epic detail"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              onKeyDown={(e) => {
                // Enter commits the batched edit from the (single-line) name field, restoring
                // the quick-rename keystroke the inline rename used to offer.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
              aria-label="Epic name"
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-text-secondary">Description</span>
            <textarea
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={6}
              aria-label="Epic description"
              placeholder="What outcome groups these stories?"
              className="resize-y rounded-control border border-neutral-border bg-neutral-surface px-2 py-1.5 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </label>
        </div>

        {/* Deferred save bar — only while the form is dirty. */}
        {dirty && (
          <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-neutral-border px-4">
            {nameBlank ? (
              <span role="alert" className="mr-auto text-xs text-semantic-critical">
                Name is required
              </span>
            ) : (
              <span className="mr-auto text-xs text-neutral-text-secondary">Unsaved changes</span>
            )}
            {patchEpic.isError && (
              <span role="alert" className="text-xs text-semantic-critical">
                Save failed
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={patchEpic.isPending || nameBlank}
            >
              {patchEpic.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
