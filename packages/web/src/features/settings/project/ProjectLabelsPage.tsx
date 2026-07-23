import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canManageLabels, canCreateLabel } from '@/lib/roles';
import {
  useLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
  type Label,
} from '@/hooks/useLabels';
import { LABEL_COLOR_KEYS, LABEL_COLOR_LABEL, labelDotStyle } from '@/lib/labelColors';

function labelDeleteHint(taskCount: number): string {
  if (taskCount === 0) return 'It is not used on any tasks.';
  const noun = taskCount === 1 ? 'task' : 'tasks';
  const target = taskCount === 1 ? 'that task' : 'them all';
  return `Used on ${taskCount} ${noun} — it is removed from ${target}.`;
}

const LABEL_SOFT_CAP = 50;

/**
 * Project > Labels settings section (ADR-0400, #1089).
 *
 * The catalog manager: Admins rename, recolor, reorder (move up/down), and delete
 * the project's task labels; the changes fan out to every card carrying the label
 * (the mutations invalidate the board tasks cache). Members may *create* labels
 * (adoption-first) but not curate existing ones; Viewers see the read-only
 * vocabulary. The server is authoritative — the role gate only spares a doomed
 * write. Each row operation commits immediately (this is a CRUD list, not a
 * single dirty-form), so there is no shared save-bar.
 */
export function ProjectLabelsPage() {
  const projectId = useProjectId();
  const { role } = useCurrentUserRole(projectId);
  const canManage = canManageLabels(role);
  const canCreate = canCreateLabel(role);

  const { data: labels = [], isLoading } = useLabels(projectId);
  const createLabel = useCreateLabel(projectId);
  const updateLabel = useUpdateLabel(projectId);
  const deleteLabel = useDeleteLabel(projectId);

  const sorted = [...labels].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name),
  );
  const atCap = labels.length >= LABEL_SOFT_CAP;

  const move = (label: Label, dir: -1 | 1) => {
    const idx = sorted.findIndex((l) => l.id === label.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    // Swap the two positions (two immediate PATCHes). A transient collision only
    // affects tie-break ordering (falls back to name), never correctness.
    updateLabel.mutate({
      labelId: label.id,
      name: label.name,
      color: label.color,
      position: swap.position,
    });
    updateLabel.mutate({
      labelId: swap.id,
      name: swap.name,
      color: swap.color,
      position: label.position,
    });
  };

  return (
    <div>
      <SettingsPageTitle
        title="Labels"
        subtitle="Colored labels categorize tasks across the board and schedule, independent of status, sprint, or WBS."
        action={
          <FieldHelp
            label="Labels"
            body="Labels are colored tags you attach to tasks to categorize them across the board and schedule — independent of status, sprint, or WBS. Admins curate the catalog (rename, recolor, reorder, delete) and members can add new labels; a change applies everywhere the label is already used."
            docHref="features/labels"
          />
        }
      />

      {/* Padded body wrapper (px-6) matching every other settings section — without
          it the list and the "New label" create row render flush to the scroll
          container edges: misaligned left with the title strip and clipped right
          behind the scrollbar gutter (issue 1988). */}
      <div className="px-6 pb-8 max-w-[720px]">
        {isLoading && <p className="text-sm text-neutral-text-disabled">Loading labels…</p>}

        {!isLoading && sorted.length === 0 && (
          <p className="text-sm text-neutral-text-secondary">
            No labels yet.{' '}
            {canCreate
              ? 'Create one below or from any task’s Labels section.'
              : 'An admin or team member can create one.'}
          </p>
        )}

        {sorted.length > 0 && (
          <ul className="flex flex-col gap-1.5" data-testid="labels-manager-list">
            {sorted.map((label, idx) => (
              <LabelRow
                key={label.id}
                label={label}
                canManage={canManage}
                isFirst={idx === 0}
                isLast={idx === sorted.length - 1}
                onMoveUp={() => move(label, -1)}
                onMoveDown={() => move(label, 1)}
                onRename={(name) =>
                  updateLabel.mutate({
                    labelId: label.id,
                    name,
                    color: label.color,
                    position: label.position,
                  })
                }
                onRecolor={(color) =>
                  updateLabel.mutate({
                    labelId: label.id,
                    name: label.name,
                    color,
                    position: label.position,
                  })
                }
                onDelete={() => deleteLabel.mutate(label.id)}
              />
            ))}
          </ul>
        )}

        {canCreate && (
          <CreateLabelRow
            disabled={atCap}
            atCapMessage={atCap ? `Label limit reached (${LABEL_SOFT_CAP}).` : null}
            pending={createLabel.isPending}
            onCreate={(name, color) => createLabel.mutate({ name, color })}
          />
        )}
      </div>
    </div>
  );
}

function ColorSwatchRow({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Label color">
      {LABEL_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          aria-label={LABEL_COLOR_LABEL[key]}
          data-testid={`label-color-${key}`}
          onClick={() => onChange(key)}
          className={`h-5 w-5 rounded-full ${value === key ? 'ring-2 ring-brand-primary ring-offset-1' : ''}`}
          style={labelDotStyle(key)}
        />
      ))}
    </div>
  );
}

function LabelRow({
  label,
  canManage,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRename,
  onRecolor,
  onDelete,
}: {
  label: Label;
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(label.name);
  const [confirming, setConfirming] = useState(false);
  const [editingColor, setEditingColor] = useState(false);

  if (!canManage) {
    return (
      <li className="flex items-center gap-2 py-1">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={labelDotStyle(label.color)}
          aria-hidden="true"
        />
        <span className="text-sm text-neutral-text-primary">{label.name}</span>
      </li>
    );
  }

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-control border border-neutral-border px-2 py-1.5"
      data-testid={`label-row-${label.id}`}
    >
      <button
        type="button"
        onClick={() => setEditingColor((v) => !v)}
        aria-label={`Change color for ${label.name}`}
        className="inline-block h-4 w-4 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        style={labelDotStyle(label.color)}
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== label.name && onRename(name.trim())}
        aria-label={`Label name (${label.name})`}
        data-testid={`label-name-${label.id}`}
        className="h-8 min-w-0 flex-1 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label={`Move ${label.name} up`}
          className="h-7 w-7 rounded-control text-neutral-text-secondary hover:bg-neutral-surface-raised disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label={`Move ${label.name} down`}
          className="h-7 w-7 rounded-control text-neutral-text-secondary hover:bg-neutral-surface-raised disabled:opacity-40"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${label.name}`}
          data-testid={`label-delete-${label.id}`}
          className="h-7 rounded-control px-2 text-sm text-semantic-critical hover:bg-semantic-critical-bg"
        >
          Delete
        </button>
      </div>

      {editingColor && (
        <div className="w-full pt-1">
          <ColorSwatchRow
            value={label.color}
            onChange={(color) => {
              onRecolor(color);
              setEditingColor(false);
            }}
          />
        </div>
      )}

      {confirming && (
        // In-flow confirmation strip, not a modal dialog: it appears inline below
        // the row, does NOT move focus into itself, and has no Escape handling, so
        // `role="alertdialog"` (which promises a focus-trapping modal) would lie to
        // AT. Downgrade to `role="group"` with an accessible name so it announces as
        // a labeled cluster of the Delete/Cancel controls that actually live here.
        <div
          className="flex w-full items-center gap-2 pt-1 text-sm"
          role="group"
          aria-label={`Delete ${label.name}?`}
        >
          <span className="text-neutral-text-secondary">
            Delete “{label.name}”? {labelDeleteHint(label.taskCount)}
          </span>
          <button
            type="button"
            onClick={() => {
              onDelete();
              setConfirming(false);
            }}
            data-testid={`label-delete-confirm-${label.id}`}
            className="ml-auto rounded-control bg-semantic-critical px-2 py-1 text-white focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-control border border-neutral-border px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function CreateLabelRow({
  disabled,
  atCapMessage,
  pending,
  onCreate,
}: {
  disabled: boolean;
  atCapMessage: string | null;
  pending: boolean;
  onCreate: (name: string, color: string) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_COLOR_KEYS[0]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || disabled) return;
    onCreate(trimmed, color);
    setName('');
    setColor(LABEL_COLOR_KEYS[0]);
  };

  return (
    <div className="mt-4 border-t border-neutral-border pt-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
        New label
      </p>
      {atCapMessage ? (
        <p className="text-sm text-semantic-at-risk">{atCapMessage}</p>
      ) : (
        // Stack the color picker above the name+Add row so the control never
        // overflows the narrow settings column. The name input carries `min-w-0`
        // (it must be able to shrink — a min-width floor here was the #1988 clip:
        // the input pushed itself and the Add button past the card's
        // `overflow-hidden` edge at mobile widths) and a `max-w` cap so it stays
        // a reasonably sized field on wide screens instead of stretching edge to
        // edge. Same overflow fix the settings `FieldRow` adopted in #539.
        <div className="flex flex-col gap-2">
          <ColorSwatchRow value={color} onChange={setColor} />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Label name"
              aria-label="New label name"
              data-testid="label-create-name"
              className="h-8 min-w-0 flex-1 sm:max-w-xs rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || pending}
              // Explicit accessible name: the settings page stacks every section on
              // one route, so a bare "Add" collides with the Members invite form's
              // Add button (strict-mode) and reads ambiguously to a screen reader.
              aria-label="Add label"
              data-testid="label-create-add"
              className="h-8 shrink-0 rounded-control bg-brand-primary px-3 text-sm font-medium text-neutral-text-inverse
                hover:bg-brand-primary-dark disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
