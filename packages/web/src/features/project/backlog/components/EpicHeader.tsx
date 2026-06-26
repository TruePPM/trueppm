import { useEffect, useRef, useState } from 'react';
import {
  BuildModeRowMenu,
  type RowMenuItem,
} from '@/features/schedule/buildMode/BuildModeRowMenu';
import { useDeleteEpic, useRenameEpic } from '../hooks/useProductBacklog';
import type { EpicGroup } from '../types';
import { EpicDeleteConfirmDialog } from './EpicDeleteConfirmDialog';

/**
 * Epic group header on the Product Backlog grooming view.
 *
 * Renders the epic's id/name + a points-progress rollup, and — for a backlog
 * manager — a kebab menu to **rename** (in-place) and **delete** the epic. The
 * two affordances are gated independently off the server's per-epic verdict
 * fields: Rename shows when `epic.canEdit`, Delete only when `epic.canDelete`.
 * A Product Owner has `canEdit:true, canDelete:false` (the PO facet is excluded
 * for DELETE server-side), so they see a Rename-only menu — never a delete
 * button that would 403. The kebab is omitted entirely when neither applies, so
 * a viewer/member sees exactly the read-only header as before.
 */
export function EpicHeader({ group, projectId }: { group: EpicGroup; projectId: string }) {
  const { epic, rollup } = group;
  const canRename = epic.canEdit === true;
  const canDelete = epic.canDelete === true;
  const pct =
    rollup.pointsTotal > 0 ? Math.round((rollup.pointsDone / rollup.pointsTotal) * 100) : 0;

  const rename = useRenameEpic(projectId);
  const del = useDeleteEpic(projectId);

  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(epic.name);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // Set when an action opens (rename input / delete dialog) so focus returns to the kebab
  // when it closes — the rename input and the dialog both pull focus away, and the kebab
  // unmounts while renaming, so this can't be a direct `.focus()` in the close handler.
  const restoreFocusRef = useRef(false);

  // Focus + select the name on entering rename so the manager can overtype it.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Return focus to the kebab once the rename input or the delete dialog closes.
  useEffect(() => {
    if (!editing && !confirming && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [editing, confirming]);

  function startRename() {
    setDraft(epic.name);
    rename.reset();
    restoreFocusRef.current = true;
    setEditing(true);
  }

  function commitRename() {
    if (rename.isPending) return;
    const next = draft.trim();
    if (!next || next === epic.name) {
      setEditing(false);
      return;
    }
    // Keep the input mounted (pending → shows the draft, no old-name flash); close
    // only on success. On error the inline `role="alert"` stays and the input keeps focus.
    rename.mutate({ epicId: epic.id, name: next }, { onSuccess: () => setEditing(false) });
  }

  function cancelRename() {
    setDraft(epic.name);
    setEditing(false);
  }

  function confirmDelete() {
    del.mutate({ epicId: epic.id }, { onSuccess: () => setConfirming(false) });
  }

  const items: RowMenuItem[] = [];
  if (canRename) {
    items.push({ key: 'rename', label: 'Rename', icon: '✎', onSelect: startRename });
  }
  if (canDelete) {
    items.push({
      key: 'delete',
      label: 'Delete epic',
      icon: '🗑',
      destructive: true,
      startsGroup: true,
      onSelect: () => {
        restoreFocusRef.current = true;
        setConfirming(true);
      },
    });
  }

  return (
    <div className="flex items-center gap-2.5 rounded-card bg-neutral-surface-sunken px-2 py-2">
      <span className="h-5 w-2 rounded-[2px] bg-brand-primary" aria-hidden />
      <span className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
        Epic
      </span>
      <span className="font-mono text-[11px] text-neutral-text-secondary">{epic.shortId}</span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          disabled={rename.isPending}
          aria-label={`Rename epic ${epic.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelRename();
            }
          }}
          className="h-7 min-w-0 max-w-xs flex-1 rounded-control border border-brand-primary bg-neutral-surface px-2 text-sm font-semibold text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-60"
        />
      ) : (
        <span className="text-sm font-semibold text-neutral-text-primary">{epic.name}</span>
      )}
      {editing && rename.isError && (
        <span role="alert" className="text-[11px] text-semantic-critical">
          Couldn&apos;t rename — try again.
        </span>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-neutral-text-secondary">
          {rollup.pointsDone}/{rollup.pointsTotal} pts · {pct}%
        </span>
        <span
          role="progressbar"
          aria-valuenow={rollup.pointsDone}
          aria-valuemin={0}
          aria-valuemax={rollup.pointsTotal}
          aria-label={`Epic ${epic.name}: ${rollup.pointsDone} of ${rollup.pointsTotal} points complete`}
          className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-surface"
        >
          <span
            className="block h-full rounded-full bg-brand-primary"
            style={{ width: `${pct}%` }}
          />
        </span>
        {items.length > 0 && !editing && (
          <button
            ref={menuButtonRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuAnchor != null}
            aria-label={`Epic actions: ${epic.name}`}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuAnchor({ x: rect.left, y: rect.bottom });
            }}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ⋯
          </button>
        )}
      </div>

      <BuildModeRowMenu anchor={menuAnchor} items={items} onClose={() => setMenuAnchor(null)} />

      {confirming && (
        <EpicDeleteConfirmDialog
          epicName={epic.name}
          storyCount={rollup.storyCount}
          isPending={del.isPending}
          isError={del.isError}
          onCancel={() => {
            del.reset();
            setConfirming(false);
          }}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
