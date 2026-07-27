import { useState } from 'react';
import { isAxiosError } from 'axios';
import { useNavigate } from 'react-router';
import {
  CSV_IMPORT_ACCEPT,
  CSV_IMPORT_MAX_UPLOAD_MB,
  missingRequiredFields,
  toColumnMap,
  unmappedHeaders,
  useCsvImportCommit,
  useCsvImportPreview,
  useCsvImportStatus,
  type CsvColumnMapping,
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

  // Re-seat focus inside the dialog on every step swap: the control that held
  // focus unmounts with the step body, and without this Tab escapes to the page
  // behind (#1776, web-rule 211).
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, step);

  const missing = preview ? missingRequiredFields(columns, preview.available_fields) : [];
  const unmapped = unmappedHeaders(columns);
  const busy = previewMut.isPending || commitMut.isPending;

  function runPreview(nextFile: File, columnMap?: Record<string, string>) {
    previewMut.mutate(
      { file: nextFile, columnMap },
      {
        onSuccess: (data) => {
          setPreview(data);
          setColumns(data.columns);
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
    const next = columns.map((c) => (c.index === index ? { ...c, field } : c));
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
          border border-neutral-border bg-neutral-surface p-5 shadow-lg focus:outline-none"
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

            <div className="overflow-x-auto rounded-card border border-neutral-border">
              <table className="w-full text-sm">
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
                      <th scope="row" className="px-3 py-2 text-left font-medium">
                        {col.header}
                      </th>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`TruePPM field for column ${col.header}`}
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
              <dd className="font-medium">{preview.row_count}</dd>
              <dt className="text-neutral-text-secondary">Tasks to create</dt>
              <dd className="font-medium">{preview.task_count}</dd>
              <dt className="text-neutral-text-secondary">Resources to create</dt>
              <dd className="font-medium">{preview.resource_count}</dd>
            </dl>

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
            <p aria-live="polite" className="text-sm text-neutral-text-primary">
              {!terminal
                ? 'Importing…'
                : statusQuery.data?.status === 'dead'
                  ? (summary?.error ?? 'The import failed. Nothing was changed.')
                  : `Imported ${tasksCreated} task${tasksCreated === 1 ? '' : 's'}.`}
            </p>
            {terminal && rowErrors.length > 0 && (
              <>
                {/* Partial success is a RESULT, not a failure: the valid rows
                    landed and the rest are addressable by line number. */}
                <p className="text-sm text-semantic-at-risk">
                  {rowErrors.length} row{rowErrors.length === 1 ? '' : 's'} could not be imported.
                  Fix them in your spreadsheet and import again — the rows above already landed.
                </p>
                <RowIssueList issues={rowErrors} tone="error" title="Rows not imported" />
              </>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        <footer className="flex items-center justify-end gap-2 border-t border-neutral-border pt-3">
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
