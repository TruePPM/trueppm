import { useState } from 'react';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { PasteField, PasteColumnMapping } from './inferColumns';

const FIELD_OPTIONS: { value: PasteField | ''; label: string }[] = [
  { value: '', label: "Don't import" },
  { value: 'name', label: 'Name' },
  { value: 'duration', label: 'Duration' },
  { value: 'owner', label: 'Owner' },
  { value: 'units', label: 'Allocation' },
];

interface PasteColumnMappingDialogProps {
  columns: PasteColumnMapping[];
  onCancel: () => void;
  onConfirm: (columns: PasteColumnMapping[]) => void;
}

/**
 * "Map columns…" escape hatch (#2724) for when the automatic guess is wrong.
 * Confirming re-submits the same pasted rows under the corrected mapping — the
 * caller (`usePasteMany.applyColumnMapping`) undoes the prior batch first, so a
 * remap is one visible step, not a stray duplicate paste sitting next to the
 * corrected one.
 */
export function PasteColumnMappingDialog({
  columns,
  onCancel,
  onConfirm,
}: PasteColumnMappingDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  const [draft, setDraft] = useState<PasteColumnMapping[]>(columns);

  const setField = (index: number, field: PasteField | '') => {
    setDraft((prev) =>
      prev.map((c) =>
        c.index === index ? { ...c, field: field || null, confidence: 'override' as const } : c,
      ),
    );
  };

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-map-columns-title"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2
          id="paste-map-columns-title"
          className="mb-3 text-base font-semibold text-neutral-text-primary"
        >
          Map columns
        </h2>
        <div className="flex flex-col gap-2">
          {draft.map((column) => (
            <label key={column.index} className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate text-neutral-text-secondary">
                {column.header ?? `Column ${column.index + 1}`}
              </span>
              <select
                value={column.field ?? ''}
                onChange={(e) => setField(column.index, e.target.value as PasteField | '')}
                className="h-7 rounded border border-neutral-border bg-neutral-surface px-1.5 text-xs
                  text-neutral-text-primary
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              >
                {FIELD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => onConfirm(draft)}>
            Apply mapping
          </Button>
        </div>
      </div>
    </div>
  );
}
