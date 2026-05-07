import { useEffect, useRef, useState } from 'react';
import type { EditableColumn } from './useScheduleFocus';

export type EditableCellInputType = 'text' | 'number' | 'duration';

export interface EditableCellProps {
  /** Current committed value (string form for display + input). */
  value: string;
  /** True when this cell is the active CellEdit target per the focus reducer. */
  isEditing: boolean;
  /** Which input parser to apply on commit. */
  inputType: EditableCellInputType;
  /** Visible static label when not editing (e.g. "5d", "70%"). Falls back to value. */
  display?: string;
  /** ARIA label for the static (non-editing) cell. */
  ariaLabel: string;
  /** Tailwind classes for the static cell wrapper. */
  className?: string;
  /** Inline style for the static cell (used for column width). */
  style?: React.CSSProperties;
  /** Cell role — defaults to "gridcell". */
  role?: string;
  /** Which column this cell represents. Forwarded to focus actions. */
  column: EditableColumn;
  /** Called when the user enters edit mode (click, F2, letter key). */
  onStartEdit: () => void;
  /** Called with the parsed new value on Enter / blur. Server PATCH happens in the parent. */
  onCommit: (parsed: string | number) => void;
  /** Called when the user presses Esc — value reverts. */
  onRollback: () => void;
  /** Called when Tab is pressed inside the input. Parent advances column. */
  onTabForward: () => void;
  /** Called when Shift-Tab is pressed inside the input. Parent retreats column. */
  onTabBackward: () => void;
}

/**
 * Parse a duration cell value. Accepts plain integers ("5"), explicit days
 * ("5d"), and weeks ("2w" → 10). Rejects negatives. Returns null on parse
 * failure — caller treats null as "discard edit".
 */
export function parseDurationInput(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+)\s*(d|w)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === 'w' ? n * 5 : n;
}

/**
 * Parse a percent cell value (0–100, integer). Rejects negatives and >100.
 * Trailing "%" is tolerated. Returns null on parse failure.
 */
export function parsePercentInput(raw: string): number | null {
  const trimmed = raw.trim().replace(/%$/, '');
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 100) return null;
  return n;
}

function commitParse(
  inputType: EditableCellInputType,
  raw: string,
): string | number | null {
  if (inputType === 'duration') return parseDurationInput(raw);
  if (inputType === 'number') return parsePercentInput(raw);
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

type FlashKind = 'commit' | 'rollback' | 'error' | null;

export function EditableCell({
  value,
  isEditing,
  inputType,
  display,
  ariaLabel,
  className,
  style,
  role = 'gridcell',
  column,
  onStartEdit,
  onCommit,
  onRollback,
  onTabForward,
  onTabBackward,
}: EditableCellProps) {
  const [draft, setDraft] = useState(value);
  const [flash, setFlash] = useState<FlashKind>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevEditingRef = useRef(false);

  // Reset draft when the committed value changes from the outside (e.g. WS broadcast).
  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [value, isEditing]);

  // Focus input + select all on entering edit mode.
  useEffect(() => {
    if (isEditing && !prevEditingRef.current && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
    prevEditingRef.current = isEditing;
  }, [isEditing]);

  // Auto-clear flash after the brief animation window.
  useEffect(() => {
    if (!flash) return;
    const ms = flash === 'commit' ? 80 : flash === 'rollback' ? 120 : 200;
    const t = setTimeout(() => setFlash(null), ms);
    return () => clearTimeout(t);
  }, [flash]);

  const tryCommit = (raw: string): boolean => {
    const parsed = commitParse(inputType, raw);
    if (parsed === null) {
      setFlash('error');
      return false;
    }
    if (parsed === value) {
      // No-op edit — silent return (no flash).
      return true;
    }
    onCommit(parsed);
    setFlash('commit');
    return true;
  };

  const handleRollback = () => {
    setDraft(value);
    setFlash('rollback');
    onRollback();
  };

  // Static cell — clicking enters edit mode (when caller has set RowFocused first).
  if (!isEditing) {
    const flashClass =
      flash === 'commit'
        ? 'bg-semantic-on-track/10'
        : flash === 'rollback'
          ? 'bg-semantic-critical/10'
          : flash === 'error'
            ? 'bg-semantic-critical/10'
            : '';
    return (
      <div
        role={role}
        aria-label={ariaLabel}
        data-column={column}
        className={[
          'flex items-center cursor-text transition-colors duration-150',
          flashClass,
          className ?? '',
        ].join(' ')}
        style={style}
        onClick={(e) => {
          // Stop propagation so the parent row's onClick (which would set
          // RowFocused) does not run after the cell's onStartEdit transitions
          // us to CellEdit. The row and the cell share an event tick; React
          // does not re-read `anyCellInEdit` between the two handlers.
          e.stopPropagation();
          onStartEdit();
        }}
      >
        {display ?? value}
      </div>
    );
  }

  return (
    <div
      role={role}
      data-column={column}
      data-editing="true"
      className={['flex items-center', className ?? ''].join(' ')}
      style={style}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // Blur outside Enter/Tab/Esc paths — commit silently if value changed.
          if (draft !== value) tryCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (tryCommit(draft)) {
              // Caller transitions focus back to RowFocused.
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            handleRollback();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            // Commit before advancing — even if invalid, the caller still wants
            // to move focus; we discard the bad draft and keep the prior value.
            tryCommit(draft);
            if (e.shiftKey) onTabBackward();
            else onTabForward();
          }
        }}
        className="w-full h-full bg-neutral-surface text-neutral-text-primary text-xs px-1
          outline-none border border-brand-primary
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          focus-visible:ring-offset-neutral-surface"
        aria-label={ariaLabel}
      />
    </div>
  );
}
