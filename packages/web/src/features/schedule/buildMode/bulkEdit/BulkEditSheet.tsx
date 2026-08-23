import { useMemo, useState, type ReactNode } from 'react';
import { formatChord } from '@/lib/platform';
import { createPortal } from 'react-dom';
import { Button } from '@/components/Button';
import { CloseIcon } from '@/components/Icons';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { TaskBulkResponse } from '@/hooks/useTaskMutations';
import type { DeliveryMode, GovernanceClass, ProjectResource, Task } from '@/types';
import {
  EMPTY_BULK_EDIT_SPEC,
  hasAnyChange,
  preflightSelection,
  sharedValue,
  summarizeBulkEditSpec,
  type BulkEditSpec,
  type DateChoice,
  type TriState,
} from './bulkEditSpec';

/**
 * The ⌘⇧K bulk-edit sheet (#2756 pt.2, ADR-0810).
 *
 * Acts on exactly the rows issue 2727's selection already holds — **never** their
 * descendants. ⌘⇧M is the subtree lens on the same two classification fields;
 * this is the explicit-selection lens. A selection is already a deliberate act,
 * so silently extending it to descendants would make ⌘A + ⌘⇧K unbounded.
 *
 * Two phases in one dialog. The result phase lives here rather than in a toast
 * because a toast cannot hold a list, and the per-row breakdown *is* the reason
 * ADR-0810 routed the sheet through the 207 batch endpoint instead of N PATCHes.
 */

const SHEET_WIDTH = 400;

const GOVERNANCE_OPTIONS: Array<{ value: GovernanceClass | null; label: string }> = [
  { value: null, label: 'Leave' },
  { value: 'gated', label: 'gated' },
  { value: 'flow', label: 'flow' },
  { value: 'hybrid', label: 'hybrid' },
];

const DELIVERY_OPTIONS: Array<{ value: DeliveryMode | null; label: string; disabled?: boolean }> = [
  { value: null, label: 'Leave' },
  { value: 'waterfall', label: 'waterfall' },
  { value: 'scrum', label: 'scrum' },
  { value: 'kanban', label: 'kanban' },
  // Same coupling ClassificationPopover documents: `is_milestone`, `duration = 0`
  // and this value are one fact, so a bulk write cannot manufacture milestones.
  { value: 'milestone', label: 'milestone', disabled: true },
];

export interface BulkEditSheetProps {
  /** The selected rows, in visible top-to-bottom order. */
  tasks: Task[];
  resourcePool: ProjectResource[];
  isPending: boolean;
  /** Non-207 failure (network, 403 on the batch itself) — switches Apply to Retry. */
  error: string | null;
  /** The 207 body once a batch has landed; null while the form is showing. */
  result: TaskBulkResponse | null;
  /** Rows the sheet dropped before sending (see `buildBulkEditOperations`). */
  skippedLocallyCount: number;
  onApply: (spec: BulkEditSpec) => void;
  /** Re-select exactly the rows that did not apply, and focus the first. */
  onReviewFailed: (taskIds: string[]) => void;
  onClose: () => void;
}

export function BulkEditSheet({
  tasks,
  resourcePool,
  isPending,
  error,
  result,
  skippedLocallyCount,
  onApply,
  onReviewFailed,
  onClose,
}: BulkEditSheetProps) {
  const [spec, setSpec] = useState<BulkEditSpec>(EMPTY_BULK_EDIT_SPEC);
  const phase = result ? 'result' : 'form';

  // `focusKey` is load-bearing, not decoration (#1776): every control in the
  // form unmounts when the result replaces it, which drops focus to <body> and
  // lets the next Tab escape the dialog — the WCAG 2.1.2 trap inverted. Passing
  // the phase re-seats focus on the result's own buttons.
  const containerRef = useFocusTrap<HTMLDivElement>(true, onClose, phase);

  const preflight = useMemo(() => preflightSelection(tasks), [tasks]);
  const canApply = hasAnyChange(spec) && !isPending;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${tasks.length} row${tasks.length === 1 ? '' : 's'}`}
      data-testid="bulk-edit-sheet"
      tabIndex={-1}
      style={{ width: SHEET_WIDTH }}
      className="fixed right-0 top-0 bottom-0 z-50 flex flex-col max-w-full
                 border-l border-neutral-border bg-neutral-surface shadow-pop
                 text-xs text-neutral-text-primary"
    >
      <header className="flex items-start gap-2 px-4 pt-3 pb-2 border-b border-neutral-border">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">
            Edit {tasks.length} row{tasks.length === 1 ? '' : 's'}
          </h2>
          {/* The pointer to ⌘⇧M lives on the Classification group, beside the
              two fields it actually concerns, rather than being said twice. */}
          <p className="mt-1 text-neutral-text-secondary leading-snug">
            These {tasks.length} row{tasks.length === 1 ? '' : 's'} only — no cascade.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close bulk edit"
          className="shrink-0 p-1 rounded text-neutral-text-secondary hover:text-neutral-text-primary
                     focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <CloseIcon />
        </button>
      </header>

      {result ? (
        <ResultPhase
          result={result}
          selectionSize={tasks.length}
          skippedLocallyCount={skippedLocallyCount}
          onReviewFailed={onReviewFailed}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            <OwnerField
              spec={spec}
              setSpec={setSpec}
              resourcePool={resourcePool}
              summaryCount={preflight.summaryCount}
            />

            <Group title="Classification" note={`${formatChord('mod+shift+m')} for a whole subtree`}>
              <RadioRow
                name="bulk_governance_class"
                label="Governed by"
                options={GOVERNANCE_OPTIONS}
                value={spec.governanceClass}
                mixedLabel={mixedSuffix(sharedValue(tasks, (t) => t.governanceClass ?? null))}
                onChange={(v) => setSpec((s) => ({ ...s, governanceClass: v }))}
              />
              <RadioRow
                name="bulk_delivery_mode"
                label="Progress from"
                options={DELIVERY_OPTIONS}
                value={spec.deliveryMode}
                mixedLabel={mixedSuffix(sharedValue(tasks, (t) => t.deliveryMode ?? null))}
                onChange={(v) => setSpec((s) => ({ ...s, deliveryMode: v }))}
                disabledTitle="A bulk edit cannot convert tasks into milestones — set is_milestone on the task itself."
              />
            </Group>

            <Group title="Dates">
              <DateField
                idPrefix="bulk-planned-start"
                label="Planned start"
                choice={spec.plannedStart}
                onChange={(plannedStart) => setSpec((s) => ({ ...s, plannedStart }))}
              />
              <DateField
                idPrefix="bulk-planned-finish"
                label="Planned finish"
                choice={spec.plannedFinish}
                onChange={(plannedFinish) => setSpec((s) => ({ ...s, plannedFinish }))}
              />
              {spec.plannedStart.mode === 'set' && spec.plannedStart.value && (
                // planned_start is the PM-committed SNET constraint, not the
                // CPM-computed early start — say what it does rather than
                // letting a planner assume the bars all jump to this date.
                <p className="text-neutral-text-secondary leading-snug">
                  Every selected row will start no earlier than {spec.plannedStart.value}.
                </p>
              )}
            </Group>

            {preflight.notEditableCount > 0 && (
              <Warning testId="bulk-edit-warning-not-editable">
                {preflight.notEditableCount} row
                {preflight.notEditableCount === 1 ? '' : 's'} you can’t edit — they’ll be reported as
                rejected.
              </Warning>
            )}
          </div>

          <footer className="px-4 py-3 border-t border-neutral-border flex items-start gap-3">
            <div className="flex-1 leading-snug text-neutral-text-secondary min-w-0">
              {canApply || isPending ? (
                <span data-testid="bulk-edit-review">{summarizeBulkEditSpec(spec)}</span>
              ) : (
                <span>Choose a value on any field.</span>
              )}
              {error && <div className="mt-1 text-semantic-critical">{error}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canApply}
                onClick={() => onApply(spec)}
                data-testid="bulk-edit-apply"
              >
                {error ? 'Retry' : isPending ? 'Applying…' : `Apply to ${tasks.length}`}
              </Button>
            </div>
          </footer>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * "Leave" alone, or "Leave — Mixed" / "Leave — flow" once the rows have a say.
 * `sharedValue` returns the literal `'mixed'` for a disagreeing selection, which
 * widens to `string` here — the comparison is still the only one that can match,
 * since no `GovernanceClass` or `DeliveryMode` member is spelled "mixed".
 */
function mixedSuffix(shared: string | null): string | null {
  if (shared === 'mixed') return 'Mixed';
  return shared;
}

function ResultPhase({
  result,
  selectionSize,
  skippedLocallyCount,
  onReviewFailed,
  onClose,
}: {
  result: TaskBulkResponse;
  selectionSize: number;
  skippedLocallyCount: number;
  onReviewFailed: (taskIds: string[]) => void;
  onClose: () => void;
}) {
  const appliedCount = result.applied.length;
  const skippedCount = result.skipped.length + skippedLocallyCount;
  // A rejection can carry a null id (rejected before an id parsed), which is not
  // a row anyone can navigate to — so the count and the navigable set differ.
  const failedIds = result.rejected.map((r) => r.id).filter((id): id is string => id !== null);

  return (
    <>
      {/* The WHOLE breakdown is the live region, not just the count. A screen
          reader that announces "1 of 2 rows updated" and stops has withheld the
          only part a person can act on — which row failed, and why. */}
      <div
        role="status"
        aria-live="polite"
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
        data-testid="bulk-edit-result"
      >
        <p className="text-sm font-medium">
          {appliedCount} of {selectionSize} row{selectionSize === 1 ? '' : 's'} updated
        </p>
        {skippedCount > 0 && (
          <p className="text-neutral-text-secondary leading-snug">
            {skippedCount} skipped — summary rows can’t take an owner.
          </p>
        )}
        {result.rejected.length > 0 && (
          <div className="text-neutral-text-secondary leading-snug">
            <p>
              {result.rejected.length} rejected —{' '}
              {/* One reason line, not N: a bulk edit sends one identical change,
                  so the rejections are near-always the same code repeated. */}
              {result.rejected[0].message}
            </p>
          </div>
        )}
      </div>
      <footer className="px-4 py-3 border-t border-neutral-border flex items-center justify-end gap-2">
        {failedIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onReviewFailed(failedIds)}
            data-testid="bulk-edit-review-failed"
          >
            Review the {failedIds.length}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={onClose} data-testid="bulk-edit-done">
          Done
        </Button>
      </footer>
    </>
  );
}

function OwnerField({
  spec,
  setSpec,
  resourcePool,
  summaryCount,
}: {
  spec: BulkEditSpec;
  setSpec: (fn: (s: BulkEditSpec) => BulkEditSpec) => void;
  resourcePool: ProjectResource[];
  summaryCount: number;
}) {
  return (
    <Group title="Owner">
      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="bulk-edit-owner" className="w-24 shrink-0 text-neutral-text-secondary">
          Add owner
        </label>
        <select
          id="bulk-edit-owner"
          data-testid="bulk-edit-owner"
          value={spec.owner.resourceId ?? ''}
          onChange={(e) => {
            const resourceId = e.target.value || null;
            const match = resourcePool.find((r) => r.resourceId === resourceId) ?? null;
            setSpec((s) => ({
              ...s,
              owner: {
                ...s.owner,
                mode: resourceId ? 'add' : 'leave',
                resourceId,
                resourceName: match?.resource.name ?? null,
              },
            }));
          }}
          className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                     focus:outline-none focus:ring-2 focus:ring-brand-primary"
        >
          <option value="">Leave unchanged</option>
          {resourcePool.map((r) => (
            <option key={r.resourceId} value={r.resourceId}>
              {r.resource.name}
            </option>
          ))}
        </select>
        <label htmlFor="bulk-edit-owner-units" className="sr-only">
          Allocation percent
        </label>
        <input
          id="bulk-edit-owner-units"
          data-testid="bulk-edit-owner-units"
          type="number"
          min={1}
          max={1000}
          value={spec.owner.percent}
          disabled={spec.owner.mode === 'leave'}
          onChange={(e) =>
            setSpec((s) => ({
              ...s,
              owner: { ...s.owner, percent: Number(e.target.value) || 100 },
            }))
          }
          className="w-16 shrink-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                     disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-primary"
        />
      </div>
      {/* The upsert asymmetry, stated rather than hidden: `owners` adds, never
          replaces, and removal is not on this endpoint at all (ADR-0774). */}
      <p className="text-neutral-text-secondary leading-snug">
        Adds a co-owner — it never replaces one. Removing an owner stays on the row.
      </p>
      {spec.owner.mode === 'add' && summaryCount > 0 && (
        <Warning testId="bulk-edit-warning-summary">
          {summaryCount} of the selected rows {summaryCount === 1 ? 'is a' : 'are'} summary row
          {summaryCount === 1 ? '' : 's'} — Owner won’t apply to {summaryCount === 1 ? 'it' : 'them'}
          . Their other changes still land.
        </Warning>
      )}
    </Group>
  );
}

function DateField({
  idPrefix,
  label,
  choice,
  onChange,
}: {
  idPrefix: string;
  label: string;
  choice: DateChoice;
  onChange: (choice: DateChoice) => void;
}) {
  const options: Array<{ value: TriState; label: string }> = [
    { value: 'leave', label: 'Leave' },
    { value: 'set', label: 'Set' },
    { value: 'clear', label: 'Clear' },
  ];
  return (
    <div className="space-y-1.5">
      <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
        <legend className="sr-only">{label}</legend>
        <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
          {label}
        </span>
        {options.map((opt) => (
          <Chip
            key={opt.value}
            name={`${idPrefix}-mode`}
            checked={choice.mode === opt.value}
            label={opt.label}
            testId={`${idPrefix}-${opt.value}`}
            onSelect={() => onChange({ ...choice, mode: opt.value })}
          />
        ))}
      </fieldset>
      {choice.mode === 'set' && (
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0" aria-hidden="true" />
          <label htmlFor={idPrefix} className="sr-only">
            {label} date
          </label>
          <input
            id={idPrefix}
            data-testid={`${idPrefix}-value`}
            type="date"
            value={choice.value ?? ''}
            onChange={(e) => onChange({ mode: 'set', value: e.target.value || null })}
            className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
                       focus:outline-none focus:ring-2 focus:ring-brand-primary"
          />
        </div>
      )}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        {/* text-xs, not text-[11px]: the compact-density exception (rule 118) is
            scoped to features/settings/ only, and this is a schedule surface. */}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
          {title}
        </h3>
        {note && <span className="ml-auto text-neutral-text-secondary">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Warning({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    // Text, never color alone — the amber is reinforcement (WCAG 1.4.1). The glyph
    // is aria-hidden: U+26A0 announces inconsistently across screen readers
    // ("warning", "warning sign", or nothing at all depending on symbol level),
    // and the sentence already says what is wrong, so it is decoration.
    <p data-testid={testId} className="text-semantic-warning leading-snug">
      <span aria-hidden="true">⚠</span> {children}
    </p>
  );
}

/**
 * One field as a native radio group. Native `<input type="radio">` rather than
 * `role="radio"` buttons, for the same reason ClassificationPopover gives:
 * arrow-key traversal, group semantics and the selected-item announcement all
 * come from the platform, and a chip is only a visual treatment of a radio.
 */
function RadioRow<V extends string | null>({
  name,
  label,
  options,
  value,
  mixedLabel,
  onChange,
  disabledTitle,
}: {
  name: string;
  label: string;
  options: Array<{ value: V; label: string; disabled?: boolean }>;
  value: V;
  mixedLabel: string | null;
  onChange: (v: V) => void;
  disabledTitle?: string;
}) {
  return (
    <fieldset className="flex items-center gap-2 flex-wrap border-0 p-0 m-0">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="w-24 shrink-0 text-neutral-text-secondary">
        {label}
      </span>
      {options.map((opt) => (
        <Chip
          key={opt.label}
          name={name}
          checked={opt.value === value}
          disabled={opt.disabled}
          title={opt.disabled ? disabledTitle : undefined}
          // "Leave — Mixed" tells the planner the rows disagree without the
          // sheet inventing a single current value it does not have.
          label={opt.value === null && mixedLabel ? `${opt.label} — ${mixedLabel}` : opt.label}
          testId={`${name}-${opt.value ?? 'leave'}`}
          onSelect={() => onChange(opt.value)}
        />
      ))}
    </fieldset>
  );
}

function Chip({
  name,
  checked,
  label,
  testId,
  onSelect,
  disabled,
  title,
}: {
  name: string;
  checked: boolean;
  label: string;
  testId: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    // The testid is on the LABEL, not the `sr-only` input: the label is what a
    // person clicks, and it covers the input completely — so a test driving the
    // input directly is blocked by its own label ("intercepts pointer events").
    // The input keeps a `-input` testid for state assertions like `toBeDisabled`.
    <label
      title={title}
      data-testid={testId}
      className={[
        'inline-flex items-center rounded-chip border px-2 py-0.5 cursor-pointer',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
        checked
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary font-medium'
          : 'border-neutral-border text-neutral-text-secondary',
      ].join(' ')}
    >
      <input
        type="radio"
        className="sr-only"
        name={name}
        checked={checked}
        disabled={disabled}
        data-testid={`${testId}-input`}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
