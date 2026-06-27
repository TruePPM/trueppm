import { useEffect, useRef, useState } from 'react';
import {
  BuildModeRowMenu,
  type RowMenuItem,
} from '@/features/schedule/buildMode/BuildModeRowMenu';
import type { Task } from '@/types';
import { useDeleteEpic } from '../hooks/useProductBacklog';
import type { EpicGroup } from '../types';
import { EpicDeleteConfirmDialog } from './EpicDeleteConfirmDialog';

/**
 * Epic group header on the Product Backlog grooming view.
 *
 * Renders the epic's id/name + a points-progress rollup. For a backlog manager
 * (`epic.canEdit`) the name is a button that opens the {@link EpicDetailDrawer} to
 * edit the epic's name and description — mirroring how clicking a story row opens its
 * detail drawer, so the obvious target (the name) is the edit affordance rather than a
 * hidden menu. Delete stays on the "⋯" kebab and shows only when `epic.canDelete`: a
 * Product Owner has `canEdit:true, canDelete:false` (the PO facet is excluded for DELETE
 * server-side), so they can edit but never see a delete button that would 403. A
 * viewer/member (neither verdict) sees exactly the read-only header — plain name, no kebab.
 *
 * `armed` (ADR-0183) is set while a story is dragged over this epic as a
 * reparent target: the right-side points rollup is swapped for a "drop here" verb so
 * the manager reads *what the drop will do*, not just *that the region is highlighted*.
 */
export function EpicHeader({
  group,
  projectId,
  selected = false,
  onOpen,
  armed = false,
}: {
  group: EpicGroup;
  projectId: string;
  /** True while this epic's detail drawer is open — mirrors the story-row selection ring. */
  selected?: boolean;
  onOpen: (epic: Task) => void;
  armed?: boolean;
}) {
  const { epic, rollup } = group;
  const canEdit = epic.canEdit === true;
  const canDelete = epic.canDelete === true;
  const pct =
    rollup.pointsTotal > 0 ? Math.round((rollup.pointsDone / rollup.pointsTotal) * 100) : 0;

  const del = useDeleteEpic(projectId);

  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // Set when the delete dialog opens so focus returns to the kebab when it closes — the
  // dialog pulls focus away, so this can't be a direct `.focus()` in the close handler.
  const restoreFocusRef = useRef(false);

  // Return focus to the kebab once the delete dialog closes.
  useEffect(() => {
    if (!confirming && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [confirming]);

  function confirmDelete() {
    del.mutate({ epicId: epic.id }, { onSuccess: () => setConfirming(false) });
  }

  // Only Delete lives on the kebab now; the name button owns edit (rename + description).
  const items: RowMenuItem[] = [];
  if (canDelete) {
    items.push({
      key: 'delete',
      label: 'Delete epic',
      icon: '🗑',
      destructive: true,
      onSelect: () => {
        restoreFocusRef.current = true;
        setConfirming(true);
      },
    });
  }

  return (
    <div
      className={`flex items-center gap-2.5 rounded-card bg-neutral-surface-sunken px-2 py-2 ${
        selected ? 'ring-2 ring-inset ring-navy-700 dark:ring-reversed' : ''
      }`}
    >
      <span className="h-5 w-2 rounded-[2px] bg-brand-primary" aria-hidden />
      <span className="text-xs font-bold uppercase tracking-wide text-neutral-text-secondary">
        Epic
      </span>
      <span className="font-mono text-[11px] text-neutral-text-secondary">{epic.shortId}</span>
      {canEdit ? (
        <button
          type="button"
          onClick={() => onOpen(epic)}
          aria-label={`Edit epic ${epic.name}`}
          // Sole open/edit affordance for the row → meets the 44px touch target (rule 207);
          // negative margin keeps the visual header height compact while widening the hit area.
          className="-my-1.5 inline-flex min-h-[44px] items-center rounded-control px-1 text-left text-sm font-semibold text-neutral-text-primary hover:text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {epic.name}
        </button>
      ) : (
        <span className="text-sm font-semibold text-neutral-text-primary">{epic.name}</span>
      )}
      <div className="flex-1" />
      {armed ? (
        <span className="text-xs font-medium text-brand-primary" aria-hidden>
          ↳ Drop to add to this epic
        </span>
      ) : (
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
          {items.length > 0 && (
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
      )}

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
