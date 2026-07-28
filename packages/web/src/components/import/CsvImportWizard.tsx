import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { useNavigate } from 'react-router';
import {
  CSV_IMPORT_ACCEPT,
  CSV_IMPORT_MAX_UPLOAD_MB,
  flaggedColumns,
  missingRequiredFields,
  normalizeColumns,
  toColumnMap,
  unmappedHeaders,
  useCsvImportCommit,
  useCsvImportPreview,
  useCsvImportStatus,
  useCsvImportTemplate,
  type CsvColumnMapping,
  type CsvMappingConfidence,
  type CsvPreview,
} from '@/hooks/useCsvImport';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { ImportDropzone } from './ImportDropzone';
import { CheckIcon, WarningIcon } from '@/components/Icons';

interface Props {
  /** Active project; the wizard is gated on a non-null id by the caller. */
  projectId: string | null;
  onClose: () => void;
}

/** The three wizard steps, plus the terminal result view. */
type Step = 'upload' | 'map' | 'confirm' | 'result';

const STEP_TITLES: Record<Step, string> = {
  upload: 'Upload a spreadsheet',
  map: 'Map columns',
  confirm: 'Confirm and import',
  result: 'Import result',
};

const STEP_ORDER: Step[] = ['upload', 'map', 'confirm'];

/** Pull the server's `detail` message out of a failed request, if present. */
function importErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string') return detail;
  }
  return "Couldn't read this file. Check it's a CSV or Excel file and try again.";
}

/** Progress rail — which of the three steps we're on. */
function StepRail({ step }: { step: Step }) {
  if (step === 'result') return null;
  const current = STEP_ORDER.indexOf(step);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Import steps">
      {STEP_ORDER.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              // The step number/check is the shape signal; color never carries
              // the state alone (rule 12).
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-medium
                ${
                  state === 'done'
                    ? 'border-semantic-on-track bg-semantic-on-track text-neutral-text-inverse'
                    : state === 'current'
                      ? 'border-brand-primary text-brand-primary'
                      : 'border-neutral-border text-neutral-text-secondary'
                }`}
              aria-hidden="true"
            >
              {state === 'done' ? <CheckIcon className="h-3 w-3" /> : i + 1}
            </span>
            <span
              className={
                state === 'current'
                  ? 'font-medium text-neutral-text-primary'
                  : 'text-neutral-text-secondary'
              }
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {STEP_TITLES[s]}
            </span>
            {i < STEP_ORDER.length - 1 && (
              <span aria-hidden="true" className="text-neutral-text-disabled">
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Scrollable list of per-row problems, addressed by spreadsheet line number. */
function RowIssueList({
  issues,
  tone,
  title,
}: {
  issues: { row: number; message: string }[];
  tone: 'error' | 'warning';
  title: string;
}) {
  if (issues.length === 0) return null;
  const toneClass = tone === 'error' ? 'text-semantic-critical' : 'text-semantic-at-risk';
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h4 className={`text-xs font-semibold ${toneClass}`}>{title}</h4>
      <ul className="max-h-32 overflow-y-auto rounded-control border border-neutral-border text-xs">
        {issues.map((issue, i) => (
          <li
            key={`${issue.row}-${i}`}
            className="border-b border-neutral-border px-2 py-1 last:border-b-0"
          >
            {/* Line number first: the operator's next action is to open the
                spreadsheet at that row. */}
            <span className="font-mono text-neutral-text-secondary">Row {issue.row}</span>{' '}
            <span className="text-neutral-text-primary">{issue.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Whole-file parser decisions — which sheet was read, how ambiguous dates were
 * resolved, whether the row cap bit.
 *
 * Deliberately *not* headed "Warnings": `warning_count` already owns that word
 * for a distinct legal meaning under the interchange spec (§5.8) — a row that
 * imported with a field defaulted. These are statements about the file as a
 * whole and never skip or alter a row, so blurring the two would mislead on the
 * one screen where the operator is deciding whether to commit.
 */
function FileNoticeList({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <section
      role="status"
      aria-label="How we read this file"
      className="flex flex-col gap-1 rounded-card border border-neutral-border bg-neutral-surface-raised p-3"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-semantic-at-risk">
        <WarningIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        How we read this file
      </h4>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-neutral-text-primary">
        {notices.map((notice, i) => (
          <li key={i}>{notice}</li>
        ))}
      </ul>
    </section>
  );
}

/** Copy for each confidence state, or null when the state needs no note. */
const MAPPING_NOTES: Record<
  CsvMappingConfidence,
  { label: string; tone: string; icon: boolean } | null
> = {
  // Silence IS the confident state. On a file built from our own template nine
  // of eleven columns are exact — badging them all would bury the two that
  // actually want an operator's eye.
  exact: null,
  fuzzy: { label: 'Guessed — check this', tone: 'text-semantic-at-risk', icon: true },
  duplicate: {
    label: 'Not imported — another column already uses this field',
    tone: 'text-semantic-at-risk',
    icon: true,
  },
  none: { label: 'No match found', tone: 'text-neutral-text-secondary', icon: false },
  override: { label: 'Your choice', tone: 'text-neutral-text-secondary', icon: false },
};

/**
 * Why a column is mapped the way it is, under the source header name.
 *
 * Reached by assistive tech through the row `<select>`'s `aria-describedby`
 * rather than as its own stop, so a keyboard user hears the guidance at the
 * control they would act on. Every state is a text sentence — color and icon
 * only reinforce it (web-rule 12).
 */
function MappingNote({ id, confidence }: { id: string; confidence: CsvMappingConfidence }) {
  const note = MAPPING_NOTES[confidence];
  if (!note) return null;
  return (
    <span id={id} className={`mt-0.5 flex items-start gap-1 text-[11px] font-normal ${note.tone}`}>
      {note.icon && <WarningIcon aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />}
      <span>{note.label}</span>
    </span>
  );
}

/**
 * 3-step CSV / Excel import wizard (#746, ADR-0632): upload → map → confirm.
 *
 * Extends the {@link ImportModal} shell with a multi-step body, as that modal's
 * docstring anticipated. Three things are load-bearing:
 *
 * - **Preview is mandatory, not optional.** A spreadsheet with no recognizable
 *   name column imports zero tasks; preview is the only thing standing between
 *   that file and a committed no-op (ADR-0632 §Risks).
 * - **A remap re-previews on the server** rather than being re-derived client
 *   side, so what the operator confirms on step 3 is what the parser actually
 *   produced under that mapping.
 * - **Partial success is a result, not a failure.** Rows that failed are listed
 *   by line number while the valid rows still land — the issue calls this the
 *   common case, and the terminal view treats it as one.
 */
export function CsvImportWizard({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columns, setColumns] = useState<CsvColumnMapping[]>([]);
  const [importId, setImportId] = useState<string | null>(null);

  const previewMut = useCsvImportPreview(projectId);
  const commitMut = useCsvImportCommit(projectId);
  const statusQuery = useCsvImportStatus(projectId, importId);
  const templateMut = useCsvImportTemplate();

  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const viewScheduleRef = useRef<HTMLButtonElement>(null);

  // Re-seat focus inside the dialog on every step swap: the control that held
  // focus unmounts with the step body, and without this Tab escapes to the page
  // behind (#1776, web-rule 211).
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, step);

  const missing = preview ? missingRequiredFields(columns, preview.available_fields) : [];
  const unmapped = unmappedHeaders(columns);
  const flagged = flaggedColumns(columns);
  const busy = previewMut.isPending || commitMut.isPending;

  function runPreview(nextFile: File, columnMap?: Record<string, string>) {
    previewMut.mutate(
      { file: nextFile, columnMap },
      {
        onSuccess: (data) => {
          setPreview(data);
          setColumns(normalizeColumns(data.columns));
          setStep('map');
        },
      },
    );
  }

  function handleSelect(picked: File) {
    setRejectMsg(null);
    setFile(picked);
  }

  function handleFieldChange(index: number, field: string) {
    // Flip to `override` so a corrected column stops reading "Guessed — check
    // this", and the flagged count above the table drains as the operator works
    // through it.
    const next = columns.map((c) =>
      c.index === index ? { ...c, field, confidence: 'override' as const } : c,
    );
    setColumns(next);
  }

  /** Re-parse under the operator's mapping so step 3 shows real server output. */
  function handleReprocess() {
    if (file) runPreview(file, toColumnMap(columns));
  }

  function handleCommit() {
    if (!file) return;
    commitMut.mutate(
      { file, columnMap: toColumnMap(columns) },
      {
        onSuccess: (data) => {
          setImportId(data.import_request_id);
          setStep('result');
        },
      },
    );
  }

  const summary = statusQuery.data?.summary ?? null;
  const terminal = statusQuery.data?.status === 'done' || statusQuery.data?.status === 'dead';
  const tasksCreated = summary?.tasks_created ?? 0;
  const rowErrors = (summary?.row_errors ?? []) as { row: number; message: string }[];
  const resultNotices = summary?.warnings ?? [];

  // A clean import has nothing to read: tasks landed, no row was lost, and the
  // parser made no decision worth reporting.
  const cleanSuccess =
    terminal &&
    statusQuery.data?.status === 'done' &&
    tasksCreated > 0 &&
    rowErrors.length === 0 &&
    resultNotices.length === 0;

  /**
   * Seat focus once the import reaches a terminal state.
   *
   * The epic asked for auto-navigation to the schedule on success. A timed
   * context change is the wrong instrument — WCAG 2.2.1 would require a
   * turn-off/extend affordance for timing that isn't essential, and firing a
   * route change out from under a focus-trapped dialog is the hazard #1776
   * already cost us once. Focusing the primary action gets the same "zero
   * decisions, one keystroke" outcome with none of that.
   *
   * When there *is* something to read, focus goes to the outcome sentence
   * instead, so an assistive-tech user starts at the result and reads down
   * through the line numbers rather than being dropped past them (spec §5.8).
   */
  useEffect(() => {
    if (step !== 'result' || !terminal) return;
    if (cleanSuccess) viewScheduleRef.current?.focus();
    else outcomeRef.current?.focus();
  }, [step, terminal, cleanSuccess]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-import-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-card
          border border-neutral-border bg-neutral-surface p-5 shadow-pop focus:outline-none"
      >
        <header className="flex flex-col gap-3">
          <h2 id="csv-import-title" className="text-base font-semibold text-neutral-text-primary">
            Import from a spreadsheet
          </h2>
          <StepRail step={step} />
        </header>

        {/* ---------------------------------------------------------------- */}
        {step === 'upload' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-neutral-text-secondary">
              Upload a CSV or Excel file. Nothing is imported until you confirm the column mapping
              on the next step.
            </p>
            <ImportDropzone
              accept={CSV_IMPORT_ACCEPT}
              maxSizeMb={CSV_IMPORT_MAX_UPLOAD_MB}
              file={file}
              onSelect={handleSelect}
              onClear={() => setFile(null)}
              onReject={setRejectMsg}
              disabled={busy}
            />
            {/* Below the dropzone, not above: whoever already has a file should
                meet the dropzone first. Not gated on `busy` either — the
                template is independent of the preview request. */}
            <div className="flex flex-col gap-1">
              <p className="text-xs text-neutral-text-secondary">
                Not sure what the file should look like?
              </p>
              <button
                type="button"
                onClick={() => templateMut.mutate()}
                disabled={templateMut.isPending}
                aria-busy={templateMut.isPending}
                className="h-11 self-start rounded-control px-0 text-sm font-medium text-brand-primary
                  hover:underline disabled:cursor-not-allowed disabled:text-neutral-text-secondary
                  disabled:no-underline focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1"
              >
                {templateMut.isPending ? 'Preparing…' : 'Download a template'}
              </button>
            </div>
            {templateMut.isError && (
              <p role="alert" className="text-sm text-semantic-critical">
                Couldn&apos;t download the template. Check your connection and try again.
              </p>
            )}
            {/* Mounted unconditionally: a live region created in the same tick
                as its content does not reliably announce. */}
            <span aria-live="polite" className="sr-only">
              {templateMut.isSuccess ? 'Template downloaded.' : ''}
            </span>
            {rejectMsg && (
              <p role="alert" className="text-sm text-semantic-critical">
                {rejectMsg}
              </p>
            )}
            {previewMut.isError && (
              <p role="alert" className="text-sm text-semantic-critical">
                {importErrorMessage(previewMut.error)}
              </p>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'map' && preview && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-neutral-text-secondary">
              We matched your columns to TruePPM fields. Change any that are wrong — the sample
              below updates when you re-check the mapping.
            </p>

            {/* Above the table: the date-convention and separator notices change
                how you read the sample rows just below them. */}
            <FileNoticeList notices={preview.warnings} />

            {/* The only affordance that works on a wide sheet where the flagged
                row is scrolled out of view. `role="status"` also makes it the
                receipt for a "Re-check mapping" round-trip. */}
            {flagged.length > 0 && (
              <p role="status" className="flex items-start gap-1.5 text-sm text-semantic-at-risk">
                <WarningIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Check the {flagged.length} column{flagged.length === 1 ? '' : 's'} flagged below.
                </span>
              </p>
            )}

            <div className="overflow-x-auto rounded-card border border-neutral-border">
              <table className="w-full min-w-[22rem] text-sm">
                <caption className="sr-only">Detected column mapping</caption>
                <thead>
                  <tr className="border-b border-neutral-border">
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-text-secondary"
                    >
                      Spreadsheet column
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-text-secondary"
                    >
                      TruePPM field
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col) => (
                    <tr key={col.index} className="border-b border-neutral-border last:border-b-0">
                      <th scope="row" className="px-3 py-2 text-left align-top font-medium">
                        <span className="block">{col.header}</span>
                        <MappingNote
                          id={`csv-map-note-${col.index}`}
                          confidence={col.confidence}
                        />
                      </th>
                      <td className="px-3 py-2 align-top">
                        <select
                          aria-label={`TruePPM field for column ${col.header}`}
                          aria-describedby={
                            MAPPING_NOTES[col.confidence]
                              ? `csv-map-note-${col.index}`
                              : undefined
                          }
                          value={col.field}
                          onChange={(e) => handleFieldChange(col.index, e.target.value)}
                          className="h-11 w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm
                            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                        >
                          <option value="">Don&apos;t import</option>
                          {preview.available_fields.map((f) => (
                            <option key={f.field} value={f.field}>
                              {f.label}
                              {f.required ? ' (required)' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.sample_rows.length > 0 && (
              <details className="rounded-card border border-neutral-border p-3">
                <summary className="cursor-pointer text-sm font-medium text-neutral-text-primary">
                  First {preview.sample_rows.length} rows
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        {preview.headers.map((h) => (
                          <th
                            key={h}
                            scope="col"
                            className="whitespace-nowrap px-2 py-1 text-left font-medium text-neutral-text-secondary"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample_rows.map((row, i) => (
                        <tr key={i} className="border-t border-neutral-border">
                          {row.map((cell, j) => (
                            <td key={j} className="whitespace-nowrap px-2 py-1">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {missing.length > 0 && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-semantic-critical">
                <WarningIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Map a column to {missing.map((f) => f.label).join(' and ')} before continuing —
                  without it the import would create no tasks.
                </span>
              </p>
            )}
            {previewMut.isError && (
              <p role="alert" className="text-sm text-semantic-critical">
                {importErrorMessage(previewMut.error)}
              </p>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'confirm' && preview && (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-neutral-text-secondary">Rows read</dt>
              {/* "5,000" alone is a lie on a 6,000-row file: `row_count` is
                  post-truncation. State both numbers when the cap bit. */}
              <dd className="font-medium">
                {preview.truncated_rows > 0
                  ? `${preview.row_count.toLocaleString()} of ${(
                      preview.row_count + preview.truncated_rows
                    ).toLocaleString()}`
                  : preview.row_count.toLocaleString()}
              </dd>
              {preview.truncated_rows > 0 && (
                <>
                  <dt className="text-neutral-text-secondary">Rows over the file limit</dt>
                  <dd className="flex items-center gap-1.5 font-medium text-semantic-at-risk">
                    <WarningIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    {preview.truncated_rows.toLocaleString()} skipped
                  </dd>
                </>
              )}
              <dt className="text-neutral-text-secondary">Tasks to create</dt>
              <dd className="font-medium">{preview.task_count.toLocaleString()}</dd>
              <dt className="text-neutral-text-secondary">Resources to create</dt>
              <dd className="font-medium">{preview.resource_count.toLocaleString()}</dd>
            </dl>

            {/* Repeated from step 2 on purpose: this is the last screen before
                an irreversible commit, and the operator may never have scrolled
                to it on the mapping step. */}
            <FileNoticeList notices={preview.warnings} />

            {unmapped.length > 0 && (
              <p className="text-sm text-neutral-text-secondary">
                <span className="font-medium text-neutral-text-primary">
                  {unmapped.length} column{unmapped.length === 1 ? '' : 's'} will not be imported:
                </span>{' '}
                {unmapped.join(', ')}
              </p>
            )}

            {/* Split counts, not one total: rows that would be LOST are a
                different decision from rows that land with a field defaulted. */}
            {preview.error_count > 0 && (
              <p className="text-sm text-semantic-critical">
                {preview.error_count} row{preview.error_count === 1 ? '' : 's'} could not be read
                and will be skipped. The rest will still import.
              </p>
            )}
            {preview.warning_count > 0 && (
              <p className="text-sm text-semantic-at-risk">
                {preview.warning_count} row{preview.warning_count === 1 ? '' : 's'} will import with
                a field defaulted.
              </p>
            )}
            <RowIssueList
              issues={preview.row_errors as { row: number; message: string }[]}
              tone="error"
              title="Rows with problems"
            />
            {commitMut.isError && (
              <p role="alert" className="text-sm text-semantic-critical">
                {importErrorMessage(commitMut.error)}
              </p>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'result' && (
          <div className="flex flex-col gap-3">
            <p
              ref={outcomeRef}
              tabIndex={-1}
              aria-live="polite"
              className="text-sm text-neutral-text-primary focus:outline-none"
            >
              {!terminal
                ? 'Importing…'
                : statusQuery.data?.status === 'dead'
                  ? (summary?.error ?? 'The import failed. Nothing was changed.')
                  : // One sentence carries the whole outcome, so the polite
                    // announcement is complete without the reader having to
                    // navigate down to the lists.
                    `Imported ${tasksCreated} task${tasksCreated === 1 ? '' : 's'}.` +
                    (rowErrors.length > 0
                      ? ` ${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} could not be imported.`
                      : '') +
                    (resultNotices.length > 0
                      ? ` ${resultNotices.length} note${resultNotices.length === 1 ? '' : 's'} about this file.`
                      : '')}
            </p>
            {terminal && <FileNoticeList notices={resultNotices} />}
            {terminal && rowErrors.length > 0 && (
              <>
                {/* Partial success is a RESULT, not a failure: the valid rows
                    landed and the rest are addressable by line number. The
                    count itself lives in the outcome sentence above, which is
                    the live region — repeating it here would say the same
                    thing twice, so this paragraph carries only the next step. */}
                <p className="text-sm text-semantic-at-risk">
                  Fix them in your spreadsheet and import again — the rows that succeeded have
                  already landed.
                </p>
                <RowIssueList issues={rowErrors} tone="error" title="Rows not imported" />
              </>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-border pt-3">
          {step === 'map' && (
            <button
              type="button"
              onClick={handleReprocess}
              disabled={busy}
              className="h-11 rounded-control px-3 text-sm font-medium text-brand-primary
                hover:underline disabled:opacity-60 focus:outline-none focus:ring-2
                focus:ring-brand-primary focus:ring-offset-1"
            >
              {previewMut.isPending ? 'Re-checking…' : 'Re-check mapping'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-control border border-neutral-border px-3 text-sm font-medium
              text-neutral-text-primary hover:bg-neutral-surface-raised focus:outline-none
              focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            {step === 'result' && terminal ? 'Close' : 'Cancel'}
          </button>

          {step === 'upload' && (
            <button
              type="button"
              disabled={!file || busy}
              onClick={() => file && runPreview(file)}
              className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark disabled:opacity-60
                disabled:cursor-not-allowed focus:outline-none focus:ring-2
                focus:ring-brand-primary focus:ring-offset-1"
            >
              {previewMut.isPending ? 'Reading…' : 'Next'}
            </button>
          )}
          {step === 'map' && (
            <button
              type="button"
              disabled={missing.length > 0 || busy}
              onClick={() => setStep('confirm')}
              className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark disabled:opacity-60
                disabled:cursor-not-allowed focus:outline-none focus:ring-2
                focus:ring-brand-primary focus:ring-offset-1"
            >
              Next
            </button>
          )}
          {step === 'confirm' && (
            <button
              type="button"
              disabled={busy}
              onClick={handleCommit}
              className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark disabled:opacity-60
                focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              {commitMut.isPending ? 'Importing…' : `Import ${preview?.task_count ?? 0} tasks`}
            </button>
          )}
          {step === 'result' && terminal && tasksCreated > 0 && (
            <button
              ref={viewScheduleRef}
              type="button"
              onClick={() => {
                onClose();
                void navigate(`/projects/${projectId}/schedule`);
              }}
              className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark focus:outline-none
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              View schedule
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
