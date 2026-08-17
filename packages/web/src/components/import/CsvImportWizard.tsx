import { useEffect, useRef, useState, type RefObject } from 'react';
import { isAxiosError } from 'axios';
import { useNavigate } from 'react-router';
import {
  CSV_IMPORT_ACCEPT,
  CSV_IMPORT_MAX_UPLOAD_MB,
  downloadIssuesCsv,
  flaggedColumns,
  groupIssuesByCause,
  missingRequiredFields,
  normalizeColumns,
  overrideMap,
  toColumnMap,
  unmappedHeaders,
  useCsvImportCommit,
  useCsvImportPreview,
  useCsvImportStatus,
  useCsvImportTemplate,
  type CsvColumnMapping,
  type CsvMappingConfidence,
  type CsvPreview,
  type CsvRowIssue,
} from '@/hooks/useCsvImport';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useUndoImportFixOperation, describeUndo } from '@/hooks/useBatchOperations';
import { toast } from '@/components/Toast';
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
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs font-medium
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

/** How many affected rows one group names before it says "and N more". */
const ROWS_SHOWN_PER_CAUSE = 12;

/**
 * One name for the diagnostics list on both the confirm and result steps.
 *
 * The same content under two names would be two different `region` landmarks
 * two steps apart. "What we could not read" was the other candidate and is
 * wrong on the result step specifically: the parked rows were understood well
 * enough to be written into the outline with their values, which is the whole
 * claim the step above it makes.
 */
const ROW_ISSUE_LIST_TITLE = 'Rows with problems';

/**
 * Per-row problems, folded into one entry per cause (#2732).
 *
 * A flat list is unreadable at the size real sheets produce: one wrong date
 * format is one edit and four hundred identical lines. Grouping by the
 * diagnostic `code` puts the *edit* at the top of each entry, with the rows it
 * would fix listed under it and one concrete example of what the parser said.
 *
 * The rows are plain text, not links: nothing in the app can open a cell in the
 * operator's spreadsheet, and a control that looks actionable and is not is
 * worse than a number they can read off.
 */
function RowIssueList({
  issues,
  tone,
  title,
  onDownload,
}: {
  issues: CsvRowIssue[];
  tone: 'error' | 'warning';
  title: string;
  /** Renders a "Download as CSV" action when supplied. */
  onDownload?: () => void;
}) {
  // Unconditional, so the region exists before its text does: a live region
  // created in the same tick as its content does not reliably announce — the
  // same reason UploadStep mounts its "Template downloaded." span up front.
  const [downloaded, setDownloaded] = useState(false);
  const groups = groupIssuesByCause(issues);
  if (issues.length === 0) return null;
  const toneClass = tone === 'error' ? 'text-semantic-critical' : 'text-semantic-at-risk';
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className={`text-xs font-semibold ${toneClass}`}>{title}</h4>
        {onDownload && (
          <button
            type="button"
            onClick={() => {
              onDownload();
              setDownloaded(true);
            }}
            className="h-11 rounded-control px-2 text-xs font-medium text-brand-primary
                  hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1"
          >
            Download problem rows (CSV)
          </button>
        )}
      </div>
      {/* A download changes nothing on the page, so without this it is
          indistinguishable from a dead button for a screen-reader user. */}
      <span aria-live="polite" className="sr-only">
        {downloaded ? 'Problem rows downloaded.' : ''}
      </span>
      <ul className="max-h-40 overflow-y-auto rounded-control border border-neutral-border text-xs">
        {groups.map((group) => (
          <li key={group.key} className="border-b border-neutral-border px-2 py-1 last:border-b-0">
            <p className="font-medium text-neutral-text-primary">
              {group.label} —{' '}
              {group.rows.length === 1 ? '1 row' : `${group.rows.length.toLocaleString()} rows`}
            </p>
            {/* Row numbers first on the second line: the operator's next action
                is to open the spreadsheet at those rows. `.tppm-mono` rather
                than bare `font-mono` — a comma-joined run of numbers is exactly
                what tabular figures are for (rule 8c). */}
            <p className="tppm-mono text-neutral-text-secondary">
              {group.rows
                .slice(0, ROWS_SHOWN_PER_CAUSE)
                .map((r) => `Row ${r}`)
                .join(', ')}
              {group.rows.length > ROWS_SHOWN_PER_CAUSE &&
                ` and ${(group.rows.length - ROWS_SHOWN_PER_CAUSE).toLocaleString()} more`}
            </p>
            {/* Suppressed when it would repeat the heading verbatim, which is
                the shape of the no-`code` fallback: there the label IS the
                message, and rendering both prints it twice. */}
            {group.example !== group.label && (
              <p className="text-neutral-text-secondary">{group.example}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Whole-file parser decisions — which worksheet was read, how ambiguous dates
 * were resolved, whether the row cap bit, whether label values were shortened.
 *
 * Deliberately *not* headed "Warnings": `warning_count` already owns that word
 * for a distinct meaning under the interchange spec (§5.8) — a row that imported
 * with a field defaulted. These are scoped to the file rather than to any row,
 * and blurring the two would mislead on the one screen where the operator is
 * deciding whether to commit. Several of them are genuinely destructive (a
 * dropped worksheet, truncated rows), so the tone is at-risk throughout rather
 * than neutral provenance.
 *
 * A labelled `<section>` (role `region`), not a live region: this is static
 * descriptive content that arrives with a whole step transition. `role="status"`
 * is implicitly atomic, so it would re-announce the entire list on every
 * re-check, on top of the focus trap's re-seat.
 */
function FileNoticeList({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <section
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
    <span id={id} className={`mt-0.5 flex items-start gap-1 text-xs font-normal ${note.tone}`}>
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
 * - **Partial success is a result, not a failure, and not data loss.** The valid
 *   rows land as the plan; the rows that could not be resolved land too, parked
 *   in an "Import review" branch at the bottom of the outline with the values
 *   the operator wrote (#2732). So the terminal view's job is to say what is
 *   waiting and where, not to ask for a re-upload — fixing a parked row is an
 *   ordinary task edit, undoable and broadcast like any other.
 */
export function CsvImportWizard({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columns, setColumns] = useState<CsvColumnMapping[]>([]);
  const [importId, setImportId] = useState<string | null>(null);
  // Which columns the operator has actually touched since the last preview —
  // the only ones a re-check may pin (web-rule 289).
  const [changed, setChanged] = useState<ReadonlySet<number>>(() => new Set());
  // ADR-0810 (#2756): flips once the operator undoes a completed import — the
  // result step then shows what happened instead of a "View schedule" button
  // pointing at rows that no longer exist.
  const [undone, setUndone] = useState(false);

  const previewMut = useCsvImportPreview(projectId);
  const commitMut = useCsvImportCommit(projectId);
  const statusQuery = useCsvImportStatus(projectId, importId);
  const templateMut = useCsvImportTemplate();
  const undoMut = useUndoImportFixOperation(projectId);

  const closeRef = useRef<HTMLButtonElement>(null);
  const viewScheduleRef = useRef<HTMLButtonElement>(null);

  // Re-seat focus inside the dialog on every step swap: the control that held
  // focus unmounts with the step body, and without this Tab escapes to the page
  // behind (#1776, web-rule 211).
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, step);

  const missing = preview ? missingRequiredFields(columns, preview.available_fields) : [];
  const unmapped = unmappedHeaders(columns);
  const flagged = flaggedColumns(columns);
  const busy = previewMut.isPending || commitMut.isPending;
  // Resolved here so each step body takes a plain string and never has to know
  // the shape of a mutation object.
  const previewErrorMsg = previewMut.isError ? importErrorMessage(previewMut.error) : null;
  const commitErrorMsg = commitMut.isError ? importErrorMessage(commitMut.error) : null;

  function runPreview(nextFile: File, columnMap?: Record<string, string>) {
    previewMut.mutate(
      { file: nextFile, columnMap },
      {
        onSuccess: (data) => {
          setPreview(data);
          setColumns(normalizeColumns(data.columns));
          // The server's verdicts are authoritative again, including `override`
          // for whatever we just pinned.
          setChanged(new Set());
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
    setChanged((prev) => new Set(prev).add(index));
  }

  /**
   * Re-parse under the operator's mapping so step 3 shows real server output.
   *
   * Only the touched columns are pinned — see {@link overrideMap}. Everything
   * else is re-detected, so a guess the operator never looked at comes back
   * still reading as a guess.
   */
  function handleReprocess() {
    if (file) runPreview(file, overrideMap(columns, changed));
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

  function handleUndo() {
    if (!importId) return;
    undoMut.mutate(importId, {
      onSuccess: (data) => {
        setUndone(true);
        toast.info(describeUndo(data.undo));
      },
      onError: () => toast.error("Couldn't undo the import — try again."),
    });
  }

  const summary = statusQuery.data?.summary ?? null;
  const terminal = statusQuery.data?.status === 'done' || statusQuery.data?.status === 'dead';
  // The plan count when the server sends one; `tasks_created` includes the
  // review branch's own rows, which are not plan tasks (#2732). Falls back so a
  // status row written by an older worker still reads sensibly.
  const tasksCreated = summary?.plan_tasks_created ?? summary?.tasks_created ?? 0;
  const parkedCount = summary?.parked_row_count ?? 0;
  const reviewBranch = summary?.review_branch_name || 'Import review';
  const rowErrors = summary?.row_errors ?? [];
  const resultNotices = summary?.warnings ?? [];
  // Whether a date column is in play, which decides if the "dates are
  // re-derived on this calendar" note belongs on the confirm step. Read off the
  // live mapping rather than the preview, so a column the operator just pointed
  // at a date field counts before the next re-check.
  const datesImported = columns.some(
    (c) => c.field === 'planned_start' || c.field === 'planned_finish',
  );

  // A clean import has nothing to read: tasks landed, nothing was parked, and
  // the parser made no decision worth reporting.
  const cleanSuccess =
    terminal &&
    statusQuery.data?.status === 'done' &&
    tasksCreated > 0 &&
    rowErrors.length === 0 &&
    parkedCount === 0 &&
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
   * When there *is* something to read, focus goes to Close rather than to the
   * schedule, so nobody is walked past a partial-success report on their way
   * out (spec §5.8). The outcome sentence carries the counts and is an
   * `aria-live` region, so it announces without needing to hold focus — which
   * is what keeps this safe: a `tabIndex={-1}` paragraph is invisible to
   * `useFocusTrap`'s selector, and focusing one with nothing focusable ahead of
   * it in the dialog would let Shift+Tab walk straight out (web-rule 288).
   */
  useEffect(() => {
    if (step !== 'result' || !terminal) return;
    if (cleanSuccess) viewScheduleRef.current?.focus();
    else closeRef.current?.focus();
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
          <UploadStep
            file={file}
            busy={busy}
            rejectMsg={rejectMsg}
            previewErrorMsg={previewErrorMsg}
            templatePending={templateMut.isPending}
            templateFailed={templateMut.isError}
            templateDownloaded={templateMut.isSuccess}
            onSelect={handleSelect}
            onClear={() => setFile(null)}
            onReject={setRejectMsg}
            onDownloadTemplate={() => templateMut.mutate()}
          />
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'map' && preview && (
          <MapStep
            preview={preview}
            columns={columns}
            flagged={flagged}
            missing={missing}
            previewErrorMsg={previewErrorMsg}
            onFieldChange={handleFieldChange}
          />
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'confirm' && preview && (
          <ConfirmStep
            preview={preview}
            unmapped={unmapped}
            datesImported={datesImported}
            commitErrorMsg={commitErrorMsg}
          />
        )}

        {/* ---------------------------------------------------------------- */}
        {step === 'result' && (
          <ResultStep
            terminal={terminal}
            failed={statusQuery.data?.status === 'dead'}
            errorText={summary?.error ?? null}
            tasksCreated={tasksCreated}
            parkedCount={parkedCount}
            reviewBranch={reviewBranch}
            rowErrors={rowErrors}
            notices={resultNotices}
            undone={undone}
            undoPending={undoMut.isPending}
            onUndo={handleUndo}
          />
        )}

        {/* ---------------------------------------------------------------- */}
        <WizardFooter
          step={step}
          terminal={terminal}
          busy={busy}
          canAdvanceFromMap={missing.length === 0}
          hasFile={file !== null}
          previewPending={previewMut.isPending}
          commitPending={commitMut.isPending}
          taskCount={preview?.task_count ?? 0}
          tasksCreated={tasksCreated}
          parkedCount={parkedCount}
          undone={undone}
          closeRef={closeRef}
          viewScheduleRef={viewScheduleRef}
          onClose={onClose}
          onReprocess={handleReprocess}
          onNextFromUpload={() => file && runPreview(file)}
          onNextFromMap={() => setStep('confirm')}
          onCommit={handleCommit}
          onViewSchedule={() => {
            onClose();
            void navigate(`/projects/${projectId}/schedule`);
          }}
        />
      </div>
    </div>
  );
}

/** Step 1 — pick a file, or grab a template that shows the expected shape. */
function UploadStep({
  file,
  busy,
  rejectMsg,
  previewErrorMsg,
  templatePending,
  templateFailed,
  templateDownloaded,
  onSelect,
  onClear,
  onReject,
  onDownloadTemplate,
}: {
  file: File | null;
  busy: boolean;
  rejectMsg: string | null;
  previewErrorMsg: string | null;
  templatePending: boolean;
  templateFailed: boolean;
  templateDownloaded: boolean;
  onSelect: (picked: File) => void;
  onClear: () => void;
  onReject: (message: string) => void;
  onDownloadTemplate: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-text-secondary">
        Upload a CSV or Excel file. Nothing is imported until you confirm the column mapping on the
        next step.
      </p>
      <ImportDropzone
        accept={CSV_IMPORT_ACCEPT}
        maxSizeMb={CSV_IMPORT_MAX_UPLOAD_MB}
        file={file}
        onSelect={onSelect}
        onClear={onClear}
        onReject={onReject}
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
          onClick={onDownloadTemplate}
          disabled={templatePending}
          aria-busy={templatePending}
          className="h-11 self-start rounded-control px-0 text-sm font-medium text-brand-primary
            hover:underline disabled:cursor-not-allowed disabled:text-neutral-text-secondary
            disabled:no-underline focus:outline-none focus:ring-2 focus:ring-brand-primary
            focus:ring-offset-1"
        >
          {templatePending ? 'Preparing…' : 'Download a template'}
        </button>
      </div>
      {templateFailed && (
        <p role="alert" className="text-sm text-semantic-critical">
          Couldn&apos;t download the template. Check your connection and try again.
        </p>
      )}
      {/* Mounted unconditionally: a live region created in the same tick
          as its content does not reliably announce. */}
      <span aria-live="polite" className="sr-only">
        {templateDownloaded ? 'Template downloaded.' : ''}
      </span>
      {rejectMsg && (
        <p role="alert" className="text-sm text-semantic-critical">
          {rejectMsg}
        </p>
      )}
      {previewErrorMsg && (
        <p role="alert" className="text-sm text-semantic-critical">
          {previewErrorMsg}
        </p>
      )}
    </div>
  );
}

/** Step 2 — confirm or correct the detected column mapping. */
function MapStep({
  preview,
  columns,
  flagged,
  missing,
  previewErrorMsg,
  onFieldChange,
}: {
  preview: CsvPreview;
  columns: CsvColumnMapping[];
  flagged: CsvColumnMapping[];
  missing: { field: string; label: string }[];
  previewErrorMsg: string | null;
  onFieldChange: (index: number, field: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-text-secondary">
        We matched your columns to TruePPM fields. Change any that are wrong — the sample below
        updates when you re-check the mapping.
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
                  <MappingNote id={`csv-map-note-${col.index}`} confidence={col.confidence} />
                </th>
                <td className="px-3 py-2 align-top">
                  <select
                    aria-label={`TruePPM field for column ${col.header}`}
                    aria-describedby={
                      MAPPING_NOTES[col.confidence] ? `csv-map-note-${col.index}` : undefined
                    }
                    value={col.field}
                    onChange={(e) => onFieldChange(col.index, e.target.value)}
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
            Map a column to {missing.map((f) => f.label).join(' and ')} before continuing — without
            it the import would create no tasks.
          </span>
        </p>
      )}
      {previewErrorMsg && (
        <p role="alert" className="text-sm text-semantic-critical">
          {previewErrorMsg}
        </p>
      )}
    </div>
  );
}

/** Step 3 — the last screen before an irreversible commit. */
function ConfirmStep({
  preview,
  unmapped,
  datesImported,
  commitErrorMsg,
}: {
  preview: CsvPreview;
  unmapped: string[];
  /** Whether any column maps to a date field, so the re-derive note applies. */
  datesImported: boolean;
  commitErrorMsg: string | null;
}) {
  // `error_count` counts diagnostics; `parked_row_count` counts rows. They are
  // 1:1 today, but the server owns that relationship — read its number when it
  // sends one rather than re-deriving it here.
  const parkedCount = preview.parked_row_count ?? preview.error_count;
  const reviewBranch = preview.review_branch_name ?? 'Import review';
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-neutral-text-secondary">Rows read</dt>
        {/* "5,000" alone is a lie on a 6,000-row file: `row_count` is
                  post-truncation. State both numbers when the cap bit. */}
        {/* The overflow itself is spelled out by the parser's own notice
                  below; this only has to stop the bare count reading as though
                  the whole file arrived. */}
        <dd className={`font-medium ${preview.truncated_rows > 0 ? 'text-semantic-at-risk' : ''}`}>
          {preview.truncated_rows > 0
            ? `${preview.row_count.toLocaleString()} of ${(
                preview.row_count + preview.truncated_rows
              ).toLocaleString()}`
            : preview.row_count.toLocaleString()}
        </dd>
        <dt className="text-neutral-text-secondary">Tasks to create</dt>
        <dd className="font-medium">{preview.task_count.toLocaleString()}</dd>
        <dt className="text-neutral-text-secondary">Resources to create</dt>
        <dd className="font-medium">{preview.resource_count.toLocaleString()}</dd>
        {parkedCount > 0 && (
          <>
            <dt className="text-neutral-text-secondary">Parked for review</dt>
            <dd className="font-medium text-semantic-at-risk">
              {parkedCount.toLocaleString()}
            </dd>
          </>
        )}
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

      {/* Split counts, not one total: rows that cannot join the plan are a
                different decision from rows that land with a field defaulted.
                Said HERE, at map/confirm time, rather than only in the result —
                the operator should never be surprised by the review branch
                after the fact (#2732). */}
      {/* The count itself lives in the `<dl>` above; repeating it here would
                render one number twice on one screen (web-rule 284). This
                paragraph carries only what the count cannot say. */}
      {parkedCount > 0 && (
        <p className="text-sm text-semantic-at-risk">
          {parkedCount === 1 ? 'That row' : 'Those rows'} can&rsquo;t become{' '}
          {parkedCount === 1 ? 'a task' : 'tasks'}, so {parkedCount === 1 ? 'it' : 'they'} will be
          parked in an &ldquo;{reviewBranch}&rdquo; branch at the bottom of the outline, with the
          values you wrote &mdash; nothing is dropped.
        </p>
      )}
      {preview.warning_count > 0 && (
        <p className="text-sm text-semantic-at-risk">
          {preview.warning_count.toLocaleString()} row{preview.warning_count === 1 ? '' : 's'} will
          import with a field defaulted.
        </p>
      )}
      {/* Imported dates are constraints the engine re-derives, not gospel —
                stated before the commit rather than discovered afterwards when
                a date moves. */}
      {datesImported && (
        <p className="text-sm text-neutral-text-secondary">
          Imported dates are treated as a starting point: the schedule is recalculated on this
          project&rsquo;s calendar, so some dates may move.
        </p>
      )}
      {/* The download is offered HERE too, not only on the result step: this is
                the screen where the commit decision is made, and the grouped
                list truncates each cause at ROWS_SHOWN_PER_CAUSE. A surface that
                says it truncated has to offer a way past the cap on that same
                surface. */}
      <RowIssueList
        issues={preview.row_errors}
        tone="error"
        title={ROW_ISSUE_LIST_TITLE}
        onDownload={() => downloadIssuesCsv(preview.row_errors)}
      />
      {commitErrorMsg && (
        <p role="alert" className="text-sm text-semantic-critical">
          {commitErrorMsg}
        </p>
      )}
    </div>
  );
}

/**
 * One sentence carrying the whole outcome, so the polite announcement is
 * complete without the reader having to navigate down to the lists.
 *
 * `tasksCreated` is the *plan* count, never the raw row count: the review branch
 * writes tasks too, and "imported 14 tasks" would otherwise include three
 * placeholders the operator still has to fix.
 */
function outcomeSentence(
  tasksCreated: number,
  parkedCount: number,
  reviewBranch: string,
  noticeCount: number,
): string {
  return (
    `Imported ${tasksCreated.toLocaleString()} task${tasksCreated === 1 ? '' : 's'}.` +
    (parkedCount > 0
      ? ` ${parkedCount.toLocaleString()} row${parkedCount === 1 ? '' : 's'} parked in the ` +
        `“${reviewBranch}” branch.`
      : '') +
    (noticeCount > 0
      ? ` ${noticeCount.toLocaleString()} note${noticeCount === 1 ? '' : 's'} about this file.`
      : '')
  );
}

/** Step 4 — what actually happened, once the import reaches a terminal state. */
function ResultStep({
  terminal,
  failed,
  errorText,
  tasksCreated,
  parkedCount,
  reviewBranch,
  rowErrors,
  notices,
  undone,
  undoPending,
  onUndo,
}: {
  terminal: boolean;
  failed: boolean;
  errorText: string | null;
  tasksCreated: number;
  parkedCount: number;
  reviewBranch: string;
  rowErrors: CsvRowIssue[];
  notices: string[];
  /** ADR-0810 (#2756): the operator already undid this import. */
  undone: boolean;
  undoPending: boolean;
  onUndo: () => void;
}) {
  let outcome: string;
  if (!terminal) outcome = 'Importing…';
  else if (undone) outcome = 'Import undone — the rows it created were removed.';
  else if (failed) outcome = errorText ?? 'The import failed. Nothing was changed.';
  else outcome = outcomeSentence(tasksCreated, parkedCount, reviewBranch, notices.length);

  const canUndo = terminal && !failed && !undone && tasksCreated + parkedCount > 0;

  // The button has advertised "(⌘Z)" since #2756 and nothing ever listened for
  // it (#2892). A label naming a shortcut that does not exist is worse than no
  // label: the user tries it, an import they wanted gone stays, and they have no
  // reason to look for the button. Bound here rather than at the dialog root so
  // it exists only while the undo is actually available — `canUndo` already
  // encodes terminal / not-failed / not-already-undone / something-was-created.
  //
  // Keyed on `e.key`, which is correct for a Meta/Ctrl combo: Option composition
  // (web/CLAUDE.md rule 294) is what forces `e.code` for Alt+letter bindings, and
  // ⌘/Ctrl leave the letter alone. Shift+⌘Z is excluded — that is redo, and there
  // is nothing to redo here.
  useEffect(() => {
    if (!canUndo || undoPending) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      onUndo();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canUndo, undoPending, onUndo]);

  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" className="text-sm text-neutral-text-primary">
        {outcome}
      </p>
      {terminal && !undone && <FileNoticeList notices={notices} />}
      {terminal && !undone && parkedCount > 0 && (
        /* Partial success is a RESULT, not a failure — and since #2732 it is
                  not data loss either. The count lives in the outcome sentence
                  above, which is the live region, so this paragraph carries only
                  what to do next: the rows are in the plan, and fixing one is an
                  ordinary edit rather than a re-upload of the whole file. */
        <p className="text-sm text-semantic-at-risk">
          Those rows are already in your outline under &ldquo;{reviewBranch}&rdquo;, with the values
          you wrote. Rename or delete each one like any other task — the branch is gone once it is
          empty.
        </p>
      )}
      {terminal && !undone && rowErrors.length > 0 && (
        <RowIssueList
          issues={rowErrors}
          tone="error"
          title={ROW_ISSUE_LIST_TITLE}
          onDownload={() => downloadIssuesCsv(rowErrors)}
        />
      )}
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoPending}
          className="self-start text-sm font-medium text-brand-primary hover:underline
                disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
        >
          {undoPending ? 'Undoing…' : 'Undo import (⌘Z)'}
        </button>
      )}
    </div>
  );
}

/** The action bar. Which buttons exist is a function of the step, so it is one
 *  component rather than five conditionals inside the dialog body. */
function WizardFooter({
  step,
  terminal,
  busy,
  canAdvanceFromMap,
  hasFile,
  previewPending,
  commitPending,
  taskCount,
  tasksCreated,
  parkedCount,
  undone,
  closeRef,
  viewScheduleRef,
  onClose,
  onReprocess,
  onNextFromUpload,
  onNextFromMap,
  onCommit,
  onViewSchedule,
}: {
  step: Step;
  terminal: boolean;
  busy: boolean;
  canAdvanceFromMap: boolean;
  hasFile: boolean;
  previewPending: boolean;
  commitPending: boolean;
  taskCount: number;
  /** Plan tasks created — excludes the Import review branch. */
  tasksCreated: number;
  /** Rows parked in that branch; they are in the outline too. */
  parkedCount: number;
  /** ADR-0810 (#2756): the operator undid this import — nothing left to view. */
  undone: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
  viewScheduleRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onReprocess: () => void;
  onNextFromUpload: () => void;
  onNextFromMap: () => void;
  onCommit: () => void;
  onViewSchedule: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-border pt-3">
      {step === 'map' && (
        <button
          type="button"
          onClick={onReprocess}
          disabled={busy}
          className="h-11 rounded-control px-3 text-sm font-medium text-brand-primary
                hover:underline disabled:opacity-60 focus:outline-none focus:ring-2
                focus:ring-brand-primary focus:ring-offset-1"
        >
          {previewPending ? 'Re-checking…' : 'Re-check mapping'}
        </button>
      )}
      <button
        ref={closeRef}
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
          disabled={!hasFile || busy}
          onClick={onNextFromUpload}
          className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark disabled:opacity-60
                disabled:cursor-not-allowed focus:outline-none focus:ring-2
                focus:ring-brand-primary focus:ring-offset-1"
        >
          {previewPending ? 'Reading…' : 'Next'}
        </button>
      )}
      {step === 'map' && (
        <button
          type="button"
          disabled={!canAdvanceFromMap || busy}
          onClick={onNextFromMap}
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
          onClick={onCommit}
          className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark disabled:opacity-60
                focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          {commitPending ? 'Importing…' : `Import ${taskCount.toLocaleString()} tasks`}
        </button>
      )}
      {/* `parkedCount` is in the gate, not just `tasksCreated`: an import whose
          rows ALL parked creates zero plan tasks but does put the operator's
          data in the outline, and the result step tells them so. Gating on the
          plan count alone would name the destination and remove the way there
          (web-rule 290). */}
      {step === 'result' && terminal && !undone && (tasksCreated > 0 || parkedCount > 0) && (
        <button
          ref={viewScheduleRef}
          type="button"
          onClick={onViewSchedule}
          className="h-11 rounded-control bg-brand-primary px-3 text-sm font-medium
                text-neutral-text-inverse hover:bg-brand-primary-dark focus:outline-none
                focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          View schedule
        </button>
      )}
    </footer>
  );
}
