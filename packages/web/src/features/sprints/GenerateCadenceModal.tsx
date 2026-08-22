import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MAX_GENERATED_SPRINTS,
  useGenerateSprints,
  type GenerateSprintsResponse,
  type SprintCadenceRow,
} from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { localTodayIso } from '@/lib/localDate';

interface Props {
  projectId: string;
  /** Suggested start — defaults to today. */
  defaultStart?: string;
  onClose: () => void;
  /** Called with the number of iterations written, after a successful commit. */
  onGenerated?: (createdCount: number) => void;
}

type Step = 'setup' | 'preview';

const MIN_LENGTH_DAYS = 2;
const MAX_LENGTH_DAYS = 30;

/**
 * Cadence generator — stand up a whole series of iterations in one pass (#2968).
 *
 * Two steps, and the split is the point. **Setup** collects count × length ×
 * start plus a name pattern and asks the server for a `dry_run` cadence.
 * **Preview** renders what the server computed, lets the operator edit any row's
 * name or dates, and only then commits. Nothing is written until Generate is
 * pressed on the second step, so the dates the operator approved are the dates
 * that land.
 *
 * The suggested capacity is rendered as a suggestion and never applied on its
 * own: the operator has to tick it on, and even then it lands on the first
 * iteration only. A generated ceiling stamped across a year of iterations is a
 * tool deciding what a team commits to, which is precisely what the
 * sprint-sovereignty rule (ADR-0073) exists to prevent. The bounding sentence is
 * server-owned copy (`capacity_hint.note`) and is always rendered with the
 * number.
 */
export function GenerateCadenceModal({
  projectId,
  defaultStart,
  onClose,
  onGenerated,
}: Props) {
  const itl = useIterationLabel(projectId);
  const [step, setStep] = useState<Step>('setup');

  const [count, setCount] = useState(6);
  const [startDate, setStartDate] = useState(defaultStart ?? localTodayIso());
  const [lengthDays, setLengthDays] = useState(10);
  const [namePattern, setNamePattern] = useState(`${itl.singular} {n}`);
  const [firstIndex, setFirstIndex] = useState(1);

  const [preview, setPreview] = useState<GenerateSprintsResponse | null>(null);
  const [rows, setRows] = useState<SprintCadenceRow[]>([]);
  const [applyCapacity, setApplyCapacity] = useState(false);

  const generate = useGenerateSprints(projectId);
  // Re-seats focus on the step swap so Tab cannot escape the dialog mid-wizard.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, step);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  const patternValid = namePattern.includes('{n}');
  const setupValid =
    patternValid &&
    count >= 1 &&
    count <= MAX_GENERATED_SPRINTS &&
    lengthDays >= MIN_LENGTH_DAYS &&
    lengthDays <= MAX_LENGTH_DAYS &&
    startDate.length > 0;

  const editedRowsValid = useMemo(
    () =>
      rows.every(
        (row) => row.name.trim().length > 0 && row.finish_date > row.start_date,
      ) && new Set(rows.map((r) => r.name.trim())).size === rows.length,
    [rows],
  );

  const toCreate = rows.filter((row) => row.status !== 'exists').length;
  const alreadyThere = rows.length - toCreate;

  function requestPreview(e: FormEvent) {
    e.preventDefault();
    if (!setupValid) return;
    generate.mutate(
      {
        count,
        start_date: startDate,
        length_days: lengthDays,
        name_pattern: namePattern,
        first_index: firstIndex,
        dry_run: true,
      },
      {
        onSuccess: (data) => {
          setPreview(data);
          setRows(data.sprints);
          setStep('preview');
        },
      },
    );
  }

  function commit() {
    if (!editedRowsValid || toCreate === 0) return;
    generate.mutate(
      {
        // Post the rows back rather than the original parameters: the operator
        // may have edited them, and re-deriving from count/start would silently
        // discard the edit they just made.
        sprints: rows.map((row) => ({
          name: row.name.trim(),
          start_date: row.start_date,
          finish_date: row.finish_date,
        })),
        first_sprint_capacity_points:
          applyCapacity && preview?.capacity_hint.points != null
            ? preview.capacity_hint.points
            : undefined,
      },
      {
        onSuccess: (data) => {
          onGenerated?.(data.created_count);
          onClose();
        },
      },
    );
  }

  function editRow(index: number, patch: Partial<SprintCadenceRow>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  const inputClass =
    'h-9 px-3 rounded border border-neutral-border bg-neutral-surface text-sm ' +
    'text-neutral-text-primary placeholder:text-neutral-text-secondary ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-neutral-overlay cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Generate ${itl.lowerPlural}`}
          className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-card border
            border-neutral-border bg-neutral-surface p-6 pointer-events-auto"
        >
          <h2 className="text-base font-semibold text-neutral-text-primary">
            {`Generate ${itl.lowerPlural}`}
          </h2>
          <p className="mt-1 text-xs text-neutral-text-secondary">
            {step === 'setup'
              ? `Lay out a run of ${itl.lowerPlural} at once. Lengths are counted in working days against this project's calendar, so holidays and weekends are skipped rather than eaten.`
              : `Nothing is saved yet — edit any row below, then generate. A ${itl.lower} whose name already exists is left untouched.`}
          </p>

          {step === 'setup' && (
            <form onSubmit={requestPreview} className="mt-5 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    {`How many ${itl.lowerPlural}`} <span aria-hidden="true">*</span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_GENERATED_SPRINTS}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    Length in working days <span aria-hidden="true">*</span>
                  </span>
                  <input
                    type="number"
                    min={MIN_LENGTH_DAYS}
                    max={MAX_LENGTH_DAYS}
                    value={lengthDays}
                    onChange={(e) => setLengthDays(Number(e.target.value))}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    First start date <span aria-hidden="true">*</span>
                  </span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                    className={`${inputClass} tppm-mono`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-neutral-text-secondary">
                    Start numbering at <span aria-hidden="true">*</span>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={firstIndex}
                    onChange={(e) => setFirstIndex(Number(e.target.value))}
                    required
                    className={`${inputClass} tabular-nums`}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-text-secondary">
                  Name pattern <span aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  value={namePattern}
                  onChange={(e) => setNamePattern(e.target.value)}
                  maxLength={200}
                  required
                  className={inputClass}
                />
                <span className="text-xs text-neutral-text-secondary">
                  {'Use {n} where the number goes.'}
                </span>
              </label>
              {!patternValid && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {'The name pattern must contain {n} so each one gets a distinct name.'}
                </p>
              )}

              {generate.isError && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {`Could not work out the ${itl.lower} dates. Check the project calendar and try again.`}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!setupValid || generate.isPending}
                  className="h-9 px-4 rounded text-sm font-medium bg-brand-primary text-neutral-text-inverse
                    disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                    focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  {generate.isPending ? 'Working…' : 'Preview'}
                </button>
              </div>
            </form>
          )}

          {step === 'preview' && preview && (
            <div className="mt-5 flex flex-col gap-4">
              <div className="overflow-x-auto rounded-card border border-neutral-border">
                <table className="w-full min-w-[34rem] text-xs">
                  <caption className="sr-only">
                    {`Proposed ${itl.lowerPlural}, editable before saving`}
                  </caption>
                  <thead>
                    <tr className="bg-neutral-surface-sunken text-neutral-text-secondary">
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Name
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Start
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Finish
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Working days
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Days skipped
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      // Index key on purpose: the preview list is fixed for the
                      // life of the step — rows are edited in place, never
                      // inserted, removed or reordered — and a key derived from
                      // the editable name would remount the input on every
                      // keystroke and steal focus mid-word.
                      <tr key={index} className="border-t border-neutral-border">
                        <td className="px-3 py-1.5">
                          <input
                            type="text"
                            value={row.name}
                            aria-label={`Name for row ${index + 1}`}
                            onChange={(e) => editRow(index, { name: e.target.value })}
                            disabled={row.status === 'exists'}
                            maxLength={255}
                            className={`${inputClass} w-full disabled:opacity-60`}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="date"
                            value={row.start_date}
                            aria-label={`Start date for row ${index + 1}`}
                            onChange={(e) =>
                              editRow(index, { start_date: e.target.value })
                            }
                            disabled={row.status === 'exists'}
                            className={`${inputClass} tppm-mono w-full disabled:opacity-60`}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="date"
                            value={row.finish_date}
                            aria-label={`Finish date for row ${index + 1}`}
                            onChange={(e) =>
                              editRow(index, { finish_date: e.target.value })
                            }
                            disabled={row.status === 'exists'}
                            className={`${inputClass} tppm-mono w-full disabled:opacity-60`}
                          />
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-neutral-text-secondary">
                          {row.status === 'exists' ? '—' : row.working_days}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-neutral-text-secondary">
                          {row.status === 'exists' ? '—' : row.non_working_days_skipped}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {alreadyThere > 0 && (
                <p className="text-xs text-neutral-text-secondary">
                  {`${alreadyThere} of these names already exist and will be left alone — generating twice never creates a duplicate.`}
                </p>
              )}

              {/* Sprint-1 capacity: a planning aid, never a cap. Off by default,
                  and the server-owned note that bounds it is always rendered. */}
              <div className="rounded-card border border-neutral-border bg-neutral-surface-sunken p-3">
                <p className="text-xs font-medium text-neutral-text-primary">
                  Suggested starting capacity
                </p>
                {preview.capacity_hint.points == null ? (
                  <p className="mt-1 text-xs text-neutral-text-secondary">
                    {preview.capacity_hint.note}
                  </p>
                ) : (
                  <>
                    <label className="mt-2 flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={applyCapacity}
                        onChange={(e) => setApplyCapacity(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span className="text-xs text-neutral-text-primary">
                        {`Record ${preview.capacity_hint.points} pts as a planning target on the first one only (from ${preview.capacity_hint.sprints_sampled} closed ${preview.capacity_hint.sprints_sampled === 1 ? itl.lower : itl.lowerPlural}).`}
                      </span>
                    </label>
                    <p className="mt-1 text-xs text-neutral-text-secondary">
                      {preview.capacity_hint.note}
                    </p>
                  </>
                )}
              </div>

              {!editedRowsValid && (
                <p role="alert" className="text-xs text-semantic-critical">
                  Every row needs a unique name and a finish date after its start date.
                </p>
              )}
              {generate.isError && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {`Could not save the ${itl.lowerPlural}. Please try again.`}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setStep('setup')}
                  disabled={generate.isPending}
                  className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Back
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={generate.isPending}
                    className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                      text-neutral-text-secondary hover:text-neutral-text-primary
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={commit}
                    disabled={!editedRowsValid || toCreate === 0 || generate.isPending}
                    className="h-9 px-4 rounded text-sm font-medium bg-brand-primary text-neutral-text-inverse
                      disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                      focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                  >
                    {generate.isPending
                      ? 'Generating…'
                      : `Generate ${toCreate} ${toCreate === 1 ? itl.lower : itl.lowerPlural}`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
