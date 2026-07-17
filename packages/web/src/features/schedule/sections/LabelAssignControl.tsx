/**
 * Label assign control (ADR-0400, #1089) for the task drawer.
 *
 * Renders the task's current label pills plus a "＋ Label" trigger that opens a
 * popover to toggle catalog labels on/off (idempotent attach/detach, optimistic)
 * and — for Member+ — inline-create a new label (name + swatch) when under the
 * soft cap. Viewers see read-only pills and no trigger. Assignment is gated on
 * `canAssign` (this user may edit this task); creation on `canCreate` (Member+).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskLabel } from '@/types';
import {
  useAttachLabel,
  useCreateLabel,
  useDetachLabel,
  useLabels,
  type Label,
} from '@/hooks/useLabels';
import { LabelPill } from '@/components/LabelPill';
import { LABEL_COLOR_KEYS, LABEL_COLOR_LABEL, labelDotStyle } from '@/lib/labelColors';

/** Client mirror of the server soft cap (TRUEPPM_LABEL_SOFT_CAP default). The
 *  server is authoritative; this only gates the create affordance early. */
const LABEL_SOFT_CAP = 50;

interface Props {
  projectId: string;
  taskId: string;
  labels: TaskLabel[];
  /** This user may edit this task → may attach/detach labels. */
  canAssign: boolean;
  /** This user is Member+ → may create new label definitions. */
  canCreate: boolean;
}

export function LabelAssignControl({ projectId, taskId, labels, canAssign, canCreate }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const assignedIds = useMemo(() => new Set(labels.map((l) => l.id)), [labels]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const sorted = [...labels].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap items-center gap-1">
        {sorted.map((l) => (
          <LabelPill key={l.id} label={l} />
        ))}
        {sorted.length === 0 && (
          <span className="text-sm text-neutral-text-secondary">No labels</span>
        )}
        {canAssign && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="label-assign-trigger"
            className="inline-flex items-center gap-0.5 rounded-chip border border-dashed border-neutral-border
              px-1.5 py-px text-xs text-neutral-text-secondary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            <span aria-hidden="true">＋</span> Label
          </button>
        )}
      </div>

      {open && canAssign && (
        <LabelPopover
          projectId={projectId}
          taskId={taskId}
          assignedIds={assignedIds}
          canCreate={canCreate}
        />
      )}
    </div>
  );
}

function LabelPopover({
  projectId,
  taskId,
  assignedIds,
  canCreate,
}: {
  projectId: string;
  taskId: string;
  assignedIds: Set<string>;
  canCreate: boolean;
}) {
  const { data: catalog = [], isLoading } = useLabels(projectId);
  const attach = useAttachLabel(projectId);
  const detach = useDetachLabel(projectId);
  const create = useCreateLabel(projectId);

  const [query, setQuery] = useState('');
  const [newColor, setNewColor] = useState<string>(LABEL_COLOR_KEYS[0]);
  const [error, setError] = useState<string | null>(null);

  const filtered = catalog.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));
  const atCap = catalog.length >= LABEL_SOFT_CAP;
  const exactMatch = catalog.some((l) => l.name.toLowerCase() === query.trim().toLowerCase());

  const toggle = (label: Label) => {
    const pill: TaskLabel = { id: label.id, name: label.name, color: label.color, position: label.position };
    if (assignedIds.has(label.id)) {
      detach.mutate({ taskId, labelId: label.id });
    } else {
      attach.mutate({ taskId, label: pill });
    }
  };

  const submitCreate = () => {
    const name = query.trim();
    if (!name) return;
    setError(null);
    create.mutate(
      { name, color: newColor },
      {
        onSuccess: (label) => {
          // Attach the freshly-created label to this task straight away.
          attach.mutate({
            taskId,
            label: { id: label.id, name: label.name, color: label.color, position: label.position },
          });
          setQuery('');
        },
        onError: () => setError('Could not create label. It may already exist or the limit is reached.'),
      },
    );
  };

  return (
    <div
      role="dialog"
      aria-label="Assign labels"
      data-testid="label-popover"
      className="absolute z-30 mt-1 w-64 rounded-card border border-neutral-border bg-neutral-surface
        p-2 shadow-pop"
    >
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter or name a new label…"
        aria-label="Filter or create label"
        data-testid="label-popover-search"
        className="mb-2 h-8 w-full rounded-control border border-neutral-border bg-neutral-surface px-2
          text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />

      <div className="max-h-56 overflow-y-auto">
        {isLoading && <p className="px-1 py-2 text-xs text-neutral-text-disabled">Loading…</p>}
        {!isLoading && catalog.length === 0 && !canCreate && (
          <p className="px-1 py-2 text-xs text-neutral-text-disabled">
            No labels yet. An admin or team member can create one.
          </p>
        )}
        {filtered.map((label) => {
          const checked = assignedIds.has(label.id);
          return (
            <button
              key={label.id}
              type="button"
              onClick={() => toggle(label)}
              data-testid={`label-option-${label.id}`}
              aria-pressed={checked}
              className="flex w-full items-center gap-2 rounded-control px-1.5 py-1.5 text-left text-sm
                hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-brand-primary"
            >
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full"
                style={labelDotStyle(label.color)}
                aria-hidden="true"
              />
              <span className="flex-1 truncate">{label.name}</span>
              {checked && (
                <span className="text-brand-primary" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Inline create — Member+, when a non-empty query has no exact match. */}
      {canCreate && query.trim() && !exactMatch && (
        <div className="mt-2 border-t border-neutral-border pt-2">
          {atCap ? (
            <p className="px-1 text-xs text-semantic-at-risk">
              Label limit reached ({LABEL_SOFT_CAP}). Delete an unused label first.
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Label color">
                {LABEL_COLOR_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setNewColor(key)}
                    role="radio"
                    aria-checked={newColor === key}
                    aria-label={LABEL_COLOR_LABEL[key]}
                    data-testid={`label-color-${key}`}
                    className={`h-5 w-5 rounded-full ${
                      newColor === key ? 'ring-2 ring-brand-primary ring-offset-1' : ''
                    }`}
                    style={labelDotStyle(key)}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={submitCreate}
                disabled={create.isPending}
                data-testid="label-create-submit"
                className="w-full rounded-control bg-brand-primary px-2 py-1.5 text-sm font-medium text-neutral-text-inverse
                  hover:bg-brand-primary-dark disabled:opacity-60
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Create “{query.trim()}”
              </button>
            </>
          )}
          {error && <p className="mt-1 px-1 text-xs text-semantic-critical">{error}</p>}
        </div>
      )}
    </div>
  );
}
