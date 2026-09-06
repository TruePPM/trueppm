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
 *
 * A field may additionally report a **deviation** per row (#3295): whether that row's own
 * value differs from the one it would inherit. That is a separate axis from `overridden`,
 * which only means "a null-sentinel override is present" and is therefore always false for
 * methodology. The three levels the deviation renders at — per-cell marker, per-column
 * header count, and (on the mount's own toolbar) a filter — are one flag, because a
 * 5-row page and a 200-row page fail at different levels and naming *which* rows deviate
 * needs all three.
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
import { LockIcon } from '@/components/Icons';
import { toast } from '@/components/Toast/toast';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { BulkFieldValue } from '@/hooks/useBulkProjectFields';

/**
 * One row's difference from the value it would inherit (#3295).
 *
 * Present only when the row actually carries something to compare against. When it is
 * absent the column renders no marker, no header count and no filter count — never a
 * `0 differ`, because a visible zero is a claim that a check happened and with no
 * inherited value on the payload none did.
 */
export interface FieldDeviation {
  /** true → this row's own value differs from the one it would inherit. */
  differs: boolean;
  /** The scope actually compared against — "program", "workspace" under a workspace
   *  `inherit` lock, where inheritance re-parents. State the comparison you made.
   *  A caller-controlled literal: this renders as a factual claim and into the cell's
   *  accessible name, so never pass a server-derived string through it. */
  scope: string;
  /** The value this row would inherit, unformatted (the cell formats it). */
  inherited: string | number | null;
  /** This row's own stored value. Equals `effective` except under a lock, where the
   *  workspace value is in force but the unreconciled stored value is what differs. */
  own: string | number | null;
}

/** Effective (in-force) value of a field on one row + whether it's an explicit override. */
export interface FieldRead {
  effective: string | number | null;
  /** true → the value is set on this row; false → inherited from the parent scope. */
  overridden: boolean;
  /** Difference from the inherited value, when the row can be compared at all (#3295). */
  deviation?: FieldDeviation;
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
  /** Grid floor for this column, default `140px`. A column carrying a deviation marker
   *  needs more: "Waterfall ≠ program (Hybrid)" is ~194px at 12px mono and the locked
   *  variant ~208px, so the default clips it. Widening the floor is the fix — a
   *  "drop the parenthetical when tight" conditional would fire on every render at the
   *  default width and never at 220px, which is a rule nobody maintains. */
  minWidth?: string;
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
  /**
   * Muted clause describing the cohort the rows were narrowed to, rendered in the
   * action bar. Opaque on purpose: the matrix is entity-agnostic and must not learn
   * the word "filter" or which facets a mount offers. Pass `undefined` when the rows
   * are unnarrowed — a clause reading "47 of 47 shown · All" trains the eye to skip
   * the slot, which is the one thing it must not do when it *does* say something.
   */
  scopeNote?: ReactNode;
  /**
   * Rows the per-column tallies are computed over, when `rows` is a narrowed subset.
   * Defaults to `rows`. A mount that filters must pass the unnarrowed set: a header
   * reading "5 differ" beside a facet chip reading "12" uses one word for one fact
   * and disagrees with itself, and neither number states its denominator.
   */
  tallyRows?: Row[];
  /**
   * Below `md` (768px), collapse to a read-only stacked card list — the whole read
   * layer stays and only the write affordances go. Opt-in per mount: it is a product
   * ruling about *this* surface's errands (checking a deviation count from a phone is
   * one; bulk-editing on one is not), not a property of the matrix, so a mount that
   * has not made that call keeps its existing behavior at every width.
   */
  narrowReadOnly?: boolean;
  /**
   * Changing this clears the selection and announces it. A mount passes whatever
   * identifies the current cohort (its filter value); the matrix only knows that the
   * set of rows underneath the checkboxes is no longer the set the user checked.
   */
  selectionResetKey?: string | number;
}

const UNSET = Symbol('unset');
type Staged = BulkFieldValue | typeof UNSET;

const GRID_CHECKBOX = '36px';
const GRID_NAME = 'minmax(180px, 1fr)';
const DEFAULT_VALUE_MIN = '140px';

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
  scopeNote,
  selectionResetKey,
  tallyRows,
  narrowReadOnly = false,
}: Props<Row>) {
  const isNarrow = useBreakpoint() === 'sm' && narrowReadOnly;
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

  /**
   * Per-column deviation tally. `null` means "no row in this column could be
   * compared" — the column then says nothing at all, which is a different state
   * from "checked, and none differ" and must not collapse into it.
   */
  const deviationCounts = useMemo(() => {
    const out = new Map<string, number | null>();
    const counted = tallyRows ?? rows;
    for (const f of fields) {
      let comparable = 0;
      let differing = 0;
      for (const row of counted) {
        const d = f.read(row).deviation;
        if (!d) continue;
        comparable += 1;
        if (d.differs) differing += 1;
      }
      out.set(f.key, comparable === 0 ? null : differing);
    }
    return out;
  }, [fields, rows, tallyRows]);

  // A cohort change invalidates the selection: the rows the user checked are no
  // longer the rows under the checkboxes. Clearing silently would let an Apply
  // land on a set nobody chose, so it is announced on the existing live region.
  const prevResetKey = useRef(selectionResetKey);
  useEffect(() => {
    if (prevResetKey.current === selectionResetKey) return;
    prevResetKey.current = selectionResetKey;
    setSelected(new Set());
    announce(`Selection cleared. Showing ${rows.length} ${entityNoun}.`);
  }, [selectionResetKey, rows.length, entityNoun, announce]);

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

  const showWriteAffordances = canEdit && !isNarrow;
  const showActionBar = showWriteAffordances && editableFields.length > 0;
  const gridTemplate = [
    showWriteAffordances ? GRID_CHECKBOX : null,
    GRID_NAME,
    ...fields.map((f) => `minmax(${f.minWidth ?? DEFAULT_VALUE_MIN}, 1fr)`),
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      {showActionBar && (
        <div
          className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-card border border-neutral-border bg-neutral-surface-raised px-4 py-2.5"
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

              {scopeNote && (
                <span
                  className="text-[11px] text-neutral-text-secondary"
                  data-testid="bulk-fields-scope-note"
                >
                  {scopeNote}
                </span>
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

      {canEdit && isNarrow && (
        <p
          className="mb-2 text-[12px] text-neutral-text-secondary"
          data-testid="bulk-fields-narrow-wall"
        >
          Bulk edits need a wider screen.
        </p>
      )}

      {/* The cohort clause rides the action bar when there is one — it says what an
          Apply will reach. With no bar it still has to be said: it is read context,
          and stranding it behind a write gate would hide it from exactly the readers
          (Viewer, closed program, narrow viewport) whose only affordance is scanning. */}
      {scopeNote && !showActionBar && (
        <p
          className="mb-2 text-[11px] text-neutral-text-secondary"
          data-testid="bulk-fields-scope-note"
        >
          {scopeNote}
        </p>
      )}

      {overCap && !isNarrow && (
        <p className="mb-2 text-[11px] text-neutral-text-secondary" role="note" data-testid="bulk-fields-cap">
          You can apply to at most <span className="tppm-mono">{maxRows}</span> rows at once.
        </p>
      )}

      <div
        className={[
          isNarrow ? 'flex flex-wrap items-baseline gap-x-3 gap-y-1' : 'grid items-center',
          'rounded-t-card border border-neutral-border bg-neutral-surface-sunken px-4 py-2',
          'text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-text-secondary',
        ].join(' ')}
        style={isNarrow ? undefined : { gridTemplateColumns: gridTemplate }}
        data-testid="bulk-fields-header"
      >
        {showWriteAffordances && (
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
          <ColumnHeader
            key={f.key}
            label={f.label}
            locked={f.locked}
            differing={deviationCounts.get(f.key) ?? null}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-b-card border-x border-b border-neutral-border bg-neutral-surface-raised">
        {rows.map((row, i) => {
          const id = rowKey(row);
          const isSelected = selected.has(id);
          return (
            <div
              key={id}
              className={[
                isNarrow ? 'flex flex-col gap-1' : 'grid items-center',
                'px-4 py-3 text-[13px]',
                i < rows.length - 1 ? 'border-b border-neutral-border/55' : '',
                isSelected ? 'bg-neutral-surface-sunken ring-2 ring-inset ring-navy-700 dark:ring-reversed' : '',
              ].join(' ')}
              style={isNarrow ? undefined : { gridTemplateColumns: gridTemplate }}
            >
              {showWriteAffordances && (
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
              <span
                className={[
                  'font-medium text-neutral-text-primary',
                  isNarrow ? '' : 'truncate',
                ].join(' ')}
              >
                {rowLabel(row)}
              </span>
              {fields.map((f) =>
                isNarrow ? (
                  // In a card the field label has to travel with its value — the
                  // column header is no longer beside it.
                  <span key={f.key} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[11px] uppercase tracking-[.08em] text-neutral-text-secondary">
                      {f.label}
                    </span>
                    <ValueCell field={f} row={row} />
                  </span>
                ) : (
                  <ValueCell key={f.key} field={f} row={row} />
                ),
              )}
            </div>
          );
        })}
      </div>

      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}

/**
 * Column header: the label, plus the constraint and the deviation tally as **label
 * text**, never a control — the count is scent at 200 rows, not an affordance.
 *
 * Order is constraint before count (`Methodology · read-only · 21 differ`): the
 * read-only state changes what the count means, so it has to be read first. `null`
 * suppresses the tally entirely; `0` renders as "none differ" rather than "0 differ",
 * because the numeral is there for scanning quantity and there is no quantity.
 */
function ColumnHeader({
  label,
  locked,
  differing,
}: {
  label: string;
  locked?: boolean;
  differing: number | null;
}) {
  return (
    <span>
      {label}
      {locked && (
        <span className="normal-case">
          {' · '}
          <LockIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />{' '}
          read-only
        </span>
      )}
      {differing != null && (
        <span className="normal-case" data-testid="deviation-count">
          {' · '}
          {differing === 0 ? 'none' : differing} differ
        </span>
      )}
    </span>
  );
}

/** Read-only display of a field's effective value; inherited values are muted with an
 * em-dash prefix so the inherited/overridden distinction is not by color alone (WCAG
 * 1.4.1). Methodology is always solid (web-rule 196 — it has no inherited-null state).
 *
 * A row that differs from its inherited value carries a `≠ scope (value)` suffix in the
 * same grammar: text and a glyph, never a dot, a fill or a row tint, so it survives
 * monochrome, print and a color-vision deficit. The suffix says "differs from", never
 * "override" — under a NOT-NULL column with no sentinel there was nothing to override. */
function ValueCell<Row>({ field, row }: { field: FieldDescriptor<Row>; row: Row }) {
  const { effective, overridden, deviation } = field.read(row);
  const label = formatValue(field, effective);

  if (deviation?.differs) {
    // The compared value leads, not the effective one. They are the same value except
    // under a lock, where the workspace default is in force on every row and the
    // unreconciled stored value is the only thing this cell can usefully say — a cell
    // reading "Hybrid ≠ workspace (Hybrid)" would be false on its face.
    const ownLabel = formatValue(field, deviation.own);
    const inheritedLabel = formatValue(field, deviation.inherited);
    return (
      <span
        className="tppm-mono break-words text-[12px] text-neutral-text-primary"
        aria-label={`${field.label}: ${ownLabel}, differs from ${deviation.scope} default ${inheritedLabel}`}
        data-testid={`deviation-marker-${field.key}`}
      >
        {/* An `aria-label` on a non-widget container does not suppress its
            descendants in NVDA/JAWS — without this the reader hears the label and
            then the raw text again. */}
        <span aria-hidden="true">
          {ownLabel} ≠ {deviation.scope} ({inheritedLabel})
        </span>
      </span>
    );
  }

  // A resettable (null-sentinel) field that is inherited reads muted "— inherited".
  if (field.resettable && !overridden) {
    return (
      <span className="text-neutral-text-secondary" aria-label={`${field.label}: inherited, ${label}`}>
        <span aria-hidden="true">
          — inherited{effective != null && effective !== '' ? ` (${label})` : ''}
        </span>
      </span>
    );
  }
  return (
    <span
      className="tppm-mono text-[12px] text-neutral-text-primary"
      aria-label={`${field.label}: ${label}${field.resettable ? ', set on this row' : ''}`}
    >
      <span aria-hidden="true">{label}</span>
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
    let next: number;
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
