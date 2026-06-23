/**
 * BulkFieldsMatrix — a reusable "select rows → pick an inherited field → set a value"
 * matrix (issue 1233, ADR-0161). The user checks rows, chooses ONE inherited field,
 * sets a value, and fires a single atomic POST that updates only the checked rows; a
 * per-field "Reset to inherited" clears the override on genuine null-sentinel fields.
 *
 * It is an **action**, not a deferred dirty-save form — it never touches
 * `useDirtyForm`/`useSettingsSaveStore` (web-rule 115/164); the action-bar controls hold
 * ephemeral local state only and the server applies all-or-nothing per call. The
 * component is entity-agnostic: each mount passes its rows, a `read()` per field, and an
 * `apply()` bound to the right endpoint.
 *
 * Methodology is the field that does NOT fit the null-sentinel model (web-rule 196): it
 * is NOT-NULL at every scope and its inheritance is policy-governed, so a methodology
 * `FieldDescriptor` is marked `resettable: false` and is dropped from the picker when the
 * mount passes it `locked` (a workspace `inherit` policy) — it then stays a read-only
 * display column.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/Button';
import { toast } from '@/components/Toast/toast';
import type { BulkFieldValue } from '@/hooks/useBulkProjectFields';

/** Effective (in-force) value of a field on one row + whether it's an explicit override. */
export interface FieldRead {
  effective: string | number | null;
  /** true → the value is set on this row; false → inherited from the parent scope. */
  overridden: boolean;
}

interface FieldBase<Row> {
  key: string;
  label: string;
  read: (row: Row) => FieldRead;
  /** Genuine null-sentinel fields (iteration_label, …) — null clears the override. NOT
   *  methodology (web-rule 196), which has no inherit-null and is never resettable. */
  resettable: boolean;
  /** Display-only column, excluded from the field picker — e.g. methodology under a
   *  workspace `inherit` lock (web-rule 196). */
  locked?: boolean;
}

export type FieldDescriptor<Row> = FieldBase<Row> &
  (
    | { kind: 'enum'; options: { value: string; label: string }[] }
    | { kind: 'string'; maxLength: number }
    | { kind: 'int'; min: number; max: number }
  );

interface Props<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  rowLabel: (row: Row) => string;
  /** Columns, in display order. A `locked` field renders as a read-only column. */
  fields: FieldDescriptor<Row>[];
  /** Render-gate only (IsProgramAdmin / IsWorkspaceAdmin) — the server is authoritative. */
  canEdit: boolean;
  apply: (ids: string[], field: string, value: BulkFieldValue) => Promise<unknown>;
  isApplying: boolean;
  /** Plural noun for success copy, e.g. "projects". */
  entityNoun: string;
  /** Plural noun for the leading column header, e.g. "Project". */
  rowNoun: string;
  maxRows?: number;
}

const UNSET = Symbol('unset');
type Staged = BulkFieldValue | typeof UNSET;

const GRID_CHECKBOX = '36px';
const GRID_NAME = 'minmax(180px, 1fr)';
const VALUE_COL = 'minmax(140px, 1fr)';

export function BulkFieldsMatrix<Row>({
  rows,
  rowKey,
  rowLabel,
  fields,
  canEdit,
  apply,
  isApplying,
  entityNoun,
  rowNoun,
  maxRows = 200,
}: Props<Row>) {
  const editableFields = useMemo(() => fields.filter((f) => !f.locked), [fields]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [fieldKey, setFieldKey] = useState<string>(() => editableFields[0]?.key ?? '');
  const [staged, setStaged] = useState<Staged>(UNSET);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  const field = editableFields.find((f) => f.key === fieldKey) ?? editableFields[0];

  // Changing the chosen field discards a stale staged value (an enum value must never
  // be applied to a string field) and cancels an in-flight reset confirm.
  useEffect(() => {
    setStaged(UNSET);
    setConfirmingReset(false);
  }, [fieldKey]);

  const allKeys = useMemo(() => rows.map(rowKey), [rows, rowKey]);
  const selectedCount = selected.size;
  const overCap = rows.length > maxRows;

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxRows) next.add(id);
      return next;
    });
  }, [maxRows]);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size > 0) return new Set();
      // Select-all clamps to the cap (selection, not the list, is capped).
      return new Set(allKeys.slice(0, maxRows));
    });
  }, [allKeys, maxRows]);

  const announce = useCallback((msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg;
  }, []);

  const runApply = useCallback(
    async (value: BulkFieldValue) => {
      if (!field || selectedCount === 0 || isApplying) return;
      const ids = [...selected];
      try {
        await apply(ids, field.key, value);
        toast.success(`Updated ${ids.length} ${entityNoun}.`);
        announce(`Updated ${ids.length} of ${ids.length} selected ${entityNoun}.`);
        setStaged(UNSET);
        setConfirmingReset(false);
        // Selection is retained so the admin can set another field on the same cohort.
      } catch {
        toast.error(`Couldn't apply — no changes were made.`);
      }
    },
    [field, selected, selectedCount, isApplying, apply, entityNoun, announce],
  );

  const canApply = canEdit && selectedCount > 0 && staged !== UNSET && !isApplying;

  if (rows.length === 0) return null; // page owns the empty/loading/error states

  const showActionBar = canEdit && editableFields.length > 0;
  const gridTemplate = [
    canEdit ? GRID_CHECKBOX : null,
    GRID_NAME,
    ...fields.map(() => VALUE_COL),
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      {showActionBar && (
        <div
          className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-border bg-neutral-surface-raised px-4 py-2.5"
          data-testid="bulk-fields-action-bar"
        >
          {confirmingReset && field ? (
            <ResetConfirm
              fieldLabel={field.label}
              count={selectedCount}
              entityNoun={entityNoun}
              onCancel={() => setConfirmingReset(false)}
              onConfirm={() => void runApply(null)}
              busy={isApplying}
            />
          ) : (
            <>
              <label className="flex items-center gap-2 text-[12px] text-neutral-text-secondary">
                Set
                <select
                  value={fieldKey}
                  onChange={(e) => setFieldKey(e.target.value)}
                  aria-label="Field to set"
                  className="h-7 rounded border border-neutral-border bg-neutral-surface pl-2.5 pr-7 text-[12px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  {editableFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              {field && (
                <ValueControl field={field} staged={staged} onStage={setStaged} disabled={isApplying} />
              )}

              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canApply}
                  onClick={() => {
                    if (staged !== UNSET) void runApply(staged);
                  }}
                  data-testid="bulk-fields-apply"
                >
                  {isApplying ? (
                    'Applying…'
                  ) : (
                    <>
                      Apply to <span className="tppm-mono">{selectedCount}</span> selected
                    </>
                  )}
                </Button>
                {field?.resettable && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={selectedCount === 0 || isApplying}
                    onClick={() => setConfirmingReset(true)}
                    data-testid="bulk-fields-reset"
                  >
                    Reset to inherited
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {overCap && (
        <p className="mb-2 text-[11px] text-neutral-text-secondary" role="note" data-testid="bulk-fields-cap">
          You can apply to at most <span className="tppm-mono">{maxRows}</span> rows at once.
        </p>
      )}

      <div
        className="grid items-center rounded-t-lg border border-neutral-border bg-neutral-surface-sunken px-4 py-2 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-text-secondary"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {canEdit && (
          <span className="flex items-center">
            <SelectAllCheckbox
              checkedCount={selectedCount}
              total={Math.min(rows.length, maxRows)}
              onToggle={toggleAll}
            />
          </span>
        )}
        <span>{rowNoun}</span>
        {fields.map((f) => (
          <span key={f.key}>{f.label}</span>
        ))}
      </div>

      <div className="overflow-hidden rounded-b-lg border-x border-b border-neutral-border bg-neutral-surface-raised">
        {rows.map((row, i) => {
          const id = rowKey(row);
          const isSelected = selected.has(id);
          return (
            <div
              key={id}
              className={[
                'grid items-center px-4 py-3 text-[13px]',
                i < rows.length - 1 ? 'border-b border-neutral-border/55' : '',
                isSelected ? 'bg-neutral-surface-sunken ring-2 ring-inset ring-navy-700 dark:ring-reversed' : '',
              ].join(' ')}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {canEdit && (
                <span className="flex items-center">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleRow(id)}
                    aria-label={`Select ${rowLabel(row)}`}
                    className="h-4 w-4 accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                </span>
              )}
              <span className="truncate font-medium text-neutral-text-primary">{rowLabel(row)}</span>
              {fields.map((f) => (
                <ValueCell key={f.key} field={f} row={row} />
              ))}
            </div>
          );
        })}
      </div>

      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}

/** Read-only display of a field's effective value; inherited values are muted with an
 * em-dash prefix so the inherited/overridden distinction is not by color alone (WCAG
 * 1.4.1). Methodology is always solid (web-rule 196 — it has no inherited-null state). */
function ValueCell<Row>({ field, row }: { field: FieldDescriptor<Row>; row: Row }) {
  const { effective, overridden } = field.read(row);
  const label = formatValue(field, effective);
  // A resettable (null-sentinel) field that is inherited reads muted "— inherited".
  if (field.resettable && !overridden) {
    return (
      <span className="text-neutral-text-secondary" aria-label={`${field.label}: inherited, ${label}`}>
        — inherited{effective != null && effective !== '' ? ` (${label})` : ''}
      </span>
    );
  }
  return (
    <span
      className="tppm-mono text-[12px] text-neutral-text-primary"
      aria-label={`${field.label}: ${label}${field.resettable ? ', set on this row' : ''}`}
    >
      {label}
    </span>
  );
}

function formatValue<Row>(field: FieldDescriptor<Row>, value: string | number | null): string {
  if (value == null || value === '') return field.kind === 'string' ? '—' : String(value ?? '—');
  if (field.kind === 'enum') {
    return field.options.find((o) => o.value === value)?.label ?? String(value);
  }
  if (field.kind === 'int') return `${value}d`;
  return String(value);
}

/** Value editor that changes shape per field kind; stages a value (or UNSET). */
function ValueControl<Row>({
  field,
  staged,
  onStage,
  disabled,
}: {
  field: FieldDescriptor<Row>;
  staged: Staged;
  onStage: (v: Staged) => void;
  disabled: boolean;
}) {
  if (field.kind === 'enum') {
    return (
      <EnumRadioGroup
        label={field.label}
        options={field.options}
        value={staged === UNSET ? null : (staged as string | null)}
        onChange={(v) => onStage(v)}
        disabled={disabled}
      />
    );
  }
  if (field.kind === 'int') {
    const num = staged === UNSET || staged === null ? '' : String(staged);
    return (
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={num}
          disabled={disabled}
          aria-label={field.label}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onStage(UNSET);
            const clamped = Math.min(field.max, Math.max(field.min, Number(raw)));
            onStage(clamped);
          }}
          className="h-7 w-[96px] rounded border border-neutral-border bg-neutral-surface px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <span className="text-[11px] text-neutral-text-secondary">
          ({field.min}–{field.max})
        </span>
      </span>
    );
  }
  // string
  const text = staged === UNSET || staged === null ? '' : String(staged);
  const willClear = staged === null;
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="text"
        maxLength={field.maxLength}
        value={text}
        disabled={disabled}
        aria-label={field.label}
        placeholder={willClear ? 'will inherit' : ''}
        onChange={(e) => onStage(e.target.value === '' ? UNSET : e.target.value)}
        className={[
          'h-7 w-[180px] rounded border border-neutral-border bg-neutral-surface px-2.5 text-[12px]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          willClear ? 'text-neutral-text-secondary italic' : '',
        ].join(' ')}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onStage(null)}
        className="text-[11px] text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:text-neutral-text-secondary"
        data-testid="bulk-fields-clear-inherit"
      >
        Clear → inherit
      </button>
      <span className="text-[11px] text-neutral-text-secondary">(max {field.maxLength})</span>
    </span>
  );
}

/** Roving-tabindex radiogroup (web-rule 167/179): arrows move focus only; activation
 * commits. Active segment is a fill (`bg-brand-primary`), never a text-shade (rule 179). */
function EnumRadioGroup({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Focus follows the active option, or the first when none is chosen yet.
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: ReactKeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    refs.current[next]?.focus(); // move focus only — do NOT commit (rule 167)
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex overflow-hidden rounded border border-neutral-border"
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            tabIndex={i === activeIdx ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => onChange(o.value)}
            className={[
              'h-7 px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
              selected
                ? 'bg-brand-primary text-neutral-text-inverse'
                : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Header select-all checkbox with a DOM-set `indeterminate` (it is a property, not an
 * attribute) for the partial-selection state. */
function SelectAllCheckbox({
  checkedCount,
  total,
  onToggle,
}: {
  checkedCount: number;
  total: number;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const checked = total > 0 && checkedCount === total;
  const indeterminate = checkedCount > 0 && checkedCount < total;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      aria-label="Select all rows"
      className="h-4 w-4 accent-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    />
  );
}

function ResetConfirm({
  fieldLabel,
  count,
  entityNoun,
  onCancel,
  onConfirm,
  busy,
}: {
  fieldLabel: string;
  count: number;
  entityNoun: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <div className="flex w-full flex-wrap items-center gap-3" data-testid="bulk-fields-reset-confirm">
      <span className="text-[12px] text-neutral-text-primary">
        Clear <span className="font-medium">{fieldLabel}</span> on{' '}
        <span className="tppm-mono">{count}</span> selected {entityNoun} — they&apos;ll inherit again.
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Clearing…' : 'Clear override'}
        </Button>
      </div>
    </div>
  );
}
