import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';
import type { TaskStatus } from '@/types';

interface Props {
  columns: BoardColumnDef[];
  onSave: (columns: BoardColumnDef[]) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}

const SWATCHES: { hex: string; label: string }[] = [
  { hex: '#94A3B8', label: 'Slate' },
  { hex: '#64748B', label: 'Steel' },
  { hex: '#3B82F6', label: 'Blue' },
  { hex: '#A855F7', label: 'Purple' },
  { hex: '#22C55E', label: 'Green' },
  { hex: '#F59E0B', label: 'Amber' },
  { hex: '#EF4444', label: 'Red' },
  { hex: '#0EA5E9', label: 'Sky' },
];

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const LABEL_MAX = 32;

interface RowError {
  label?: string;
  color?: string;
  wip?: string;
}

/**
 * Right-side drawer (480px) that edits per-column board metadata
 * (label, color, WIP limit, visibility) for issue #170 / ADR-0039.
 *
 * Status order is fixed by the canonical TaskStatus enum — drag-to-reorder
 * is intentionally out of scope (hybrid model preserves the canonical five).
 */
export function BoardSettingsPanel({ columns, onSave, onClose, readOnly = false }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<BoardColumnDef[]>(() => columns.map((c) => ({ ...c })));
  const [errors, setErrors] = useState<Record<TaskStatus, RowError>>(
    () => ({} as Record<TaskStatus, RowError>),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isDirty = useMemo(() => {
    return columns.some((orig, i) => {
      const next = draft[i];
      if (!next) return true;
      return (
        orig.label !== next.label ||
        (orig.color ?? null) !== (next.color ?? null) ||
        (orig.wipLimit ?? null) !== (next.wipLimit ?? null) ||
        orig.visible !== next.visible
      );
    });
  }, [columns, draft]);

  const hasErrors = Object.values(errors).some((e) => e && (e.label || e.color || e.wip));

  function update(index: number, patch: Partial<BoardColumnDef>) {
    setDraft((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) return prev;
      next[index] = { ...current, ...patch };
      return next;
    });
  }

  function validateRow(col: BoardColumnDef): RowError {
    const e: RowError = {};
    if (!col.label.trim()) e.label = 'Label is required';
    else if (col.label.length > LABEL_MAX) e.label = `Max ${LABEL_MAX} characters`;
    if (col.color && !HEX_RE.test(col.color)) e.color = 'Use #RRGGBB hex';
    if (col.wipLimit != null && (!Number.isInteger(col.wipLimit) || col.wipLimit < 1)) {
      e.wip = 'Must be a positive integer';
    }
    return e;
  }

  function setRowError(status: TaskStatus, e: RowError) {
    setErrors((prev) => ({ ...prev, [status]: e }));
  }

  async function handleSave() {
    if (readOnly) return;
    const nextErrors: Record<TaskStatus, RowError> = {} as Record<TaskStatus, RowError>;
    let hasAny = false;
    for (const col of draft) {
      const e = validateRow(col);
      nextErrors[col.status] = e;
      if (e.label || e.color || e.wip) hasAny = true;
    }
    setErrors(nextErrors);
    if (hasAny) return;
    setIsSaving(true);
    setSubmitError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setSubmitError(msg);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Column settings"
      className="fixed inset-0 z-50 flex"
    >
      <div className="flex-1 bg-black/30" aria-hidden="true" onClick={onClose} />

      <div className="w-full max-w-[480px] bg-neutral-surface border-l border-neutral-border flex flex-col overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-neutral-border">
          <div>
            <h2 className="text-sm font-semibold text-neutral-text-primary">Board columns</h2>
            <p className="mt-0.5 text-xs text-neutral-text-secondary">
              {readOnly
                ? 'View-only — schedulers can edit columns'
                : 'Rename, color, and set WIP limits per column'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close board settings"
            className="inline-flex items-center justify-center w-11 h-11 rounded-control
              border border-neutral-border text-sm text-neutral-text-secondary
              hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 px-5 py-4 space-y-5">
          {draft.map((col, index) => {
            const err = errors[col.status] ?? {};
            return (
              <ColumnRow
                key={col.status}
                col={col}
                err={err}
                readOnly={readOnly}
                onChange={(patch) => {
                  update(index, patch);
                  setRowError(col.status, validateRow({ ...col, ...patch }));
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-neutral-border bg-neutral-surface-sunken">
          <div className="text-xs text-semantic-critical" role="alert" aria-live="polite">
            {submitError}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-control
                border border-neutral-border text-xs text-neutral-text-secondary
                hover:bg-neutral-surface-raised
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              Cancel
            </button>
            {!readOnly && (
              <button
                type="button"
                onClick={() => { void handleSave(); }}
                disabled={!isDirty || hasErrors || isSaving}
                className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-control
                  bg-brand-primary text-white text-xs font-medium
                  disabled:opacity-50 disabled:cursor-not-allowed
                  hover:bg-brand-primary/90
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  col: BoardColumnDef;
  err: RowError;
  readOnly: boolean;
  onChange: (patch: Partial<BoardColumnDef>) => void;
}

function ColumnRow({ col, err, readOnly, onChange }: RowProps) {
  const labelId = `col-${col.status}-label`;
  const colorId = `col-${col.status}-color`;
  const wipId = `col-${col.status}-wip`;
  const visId = `col-${col.status}-vis`;

  return (
    <div className="space-y-2 pb-4 border-b border-neutral-border last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block w-3 h-3 rounded-chip border border-neutral-border"
          style={{ backgroundColor: col.color ?? 'transparent' }}
        />
        <span className="text-xs uppercase tracking-widest text-neutral-text-disabled tppm-mono">
          {col.status}
        </span>
      </div>

      <div>
        <label htmlFor={labelId} className="block text-xs text-neutral-text-secondary mb-1">
          Label
        </label>
        <input
          id={labelId}
          type="text"
          value={col.label}
          maxLength={LABEL_MAX}
          disabled={readOnly}
          onChange={(e) => onChange({ label: e.target.value })}
          aria-invalid={Boolean(err.label)}
          aria-describedby={err.label ? `${labelId}-err` : undefined}
          className="w-full min-h-[44px] px-2 rounded-control border border-neutral-border bg-neutral-surface
            text-sm text-neutral-text-primary
            disabled:bg-neutral-surface-sunken disabled:text-neutral-text-disabled
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
        />
        {err.label && (
          <p id={`${labelId}-err`} className="mt-1 text-xs text-semantic-critical">
            {err.label}
          </p>
        )}
      </div>

      <div>
        <span className="block text-xs text-neutral-text-secondary mb-1">Color</span>
        <div className="flex items-center flex-wrap gap-2" role="group" aria-label={`${col.label} color`}>
          {SWATCHES.map((s) => {
            const selected = col.color?.toUpperCase() === s.hex.toUpperCase();
            return (
              <button
                key={s.hex}
                type="button"
                disabled={readOnly}
                onClick={() => onChange({ color: s.hex })}
                aria-pressed={selected}
                aria-label={s.label}
                title={s.label}
                className={[
                  'w-11 h-11 rounded-control border-2',
                  selected ? 'border-brand-primary' : 'border-neutral-border',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none',
                ].join(' ')}
                style={{ backgroundColor: s.hex }}
              />
            );
          })}
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onChange({ color: null })}
            aria-pressed={col.color == null}
            aria-label="No color"
            title="No color"
            className={[
              'w-11 h-11 rounded-control border-2 bg-neutral-surface',
              col.color == null ? 'border-brand-primary' : 'border-neutral-border',
              'text-neutral-text-disabled text-xs',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none',
            ].join(' ')}
          >
            ∅
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={colorId} className="text-xs text-neutral-text-secondary">
            Custom hex
          </label>
          <input
            id={colorId}
            type="text"
            value={col.color ?? ''}
            placeholder="#RRGGBB"
            maxLength={7}
            disabled={readOnly}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange({ color: v === '' ? null : v });
            }}
            aria-invalid={Boolean(err.color)}
            aria-describedby={err.color ? `${colorId}-err` : undefined}
            className="w-28 min-h-[44px] px-2 rounded-control border border-neutral-border bg-neutral-surface
              text-sm tppm-mono text-neutral-text-primary
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-disabled
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        </div>
        {err.color && (
          <p id={`${colorId}-err`} className="mt-1 text-xs text-semantic-critical">
            {err.color}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={wipId} className="block text-xs text-neutral-text-secondary mb-1">
          WIP limit <span className="text-neutral-text-disabled">(advisory)</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            id={wipId}
            type="number"
            min={1}
            step={1}
            value={col.wipLimit ?? ''}
            placeholder="No limit"
            disabled={readOnly}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                onChange({ wipLimit: null });
              } else {
                const n = Number(raw);
                onChange({ wipLimit: Number.isFinite(n) ? n : col.wipLimit ?? null });
              }
            }}
            aria-invalid={Boolean(err.wip)}
            aria-describedby={err.wip ? `${wipId}-err` : undefined}
            className="w-24 min-h-[44px] px-2 rounded-control border border-neutral-border bg-neutral-surface
              text-sm tppm-mono text-neutral-text-primary
              disabled:bg-neutral-surface-sunken disabled:text-neutral-text-disabled
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
          <button
            type="button"
            disabled={readOnly || col.wipLimit == null}
            onClick={() => onChange({ wipLimit: null })}
            className="text-xs text-neutral-text-secondary underline disabled:text-neutral-text-disabled disabled:no-underline
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            Clear
          </button>
        </div>
        {err.wip && (
          <p id={`${wipId}-err`} className="mt-1 text-xs text-semantic-critical">
            {err.wip}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <label htmlFor={visId} className="text-xs text-neutral-text-secondary">
          Show on board
        </label>
        <input
          id={visId}
          type="checkbox"
          role="switch"
          checked={col.visible}
          disabled={readOnly}
          onChange={(e) => onChange({ visible: e.target.checked })}
          aria-checked={col.visible}
          className="w-11 h-11 accent-brand-primary
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none
            disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}
