import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  RISK_IMPORT_ACCEPT,
  RISK_IMPORT_MAX_UPLOAD_MB,
  useImportRisks,
  type RiskImportIssue,
} from '@/hooks/useImportRisks';
import { ImportDropzone } from '@/components/import/ImportDropzone';

interface Props {
  /** Active project; the modal is gated on a non-null id by the caller. */
  projectId: string | null;
  onClose: () => void;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Pull the server's `detail` message out of a failed request, if present. */
function importErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string') return detail;
  }
  return "Couldn't import this file. Check it's a CSV and try again.";
}

/** A scrollable list of per-row issues (errors or warnings). */
function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: RiskImportIssue[];
  tone: 'error' | 'warning';
}) {
  if (issues.length === 0) return null;
  const headingColor = tone === 'error' ? 'text-semantic-critical' : 'text-semantic-warning';
  const boxColor =
    tone === 'error'
      ? 'border-semantic-critical/40 bg-semantic-critical-bg'
      : 'border-semantic-warning/40 bg-semantic-warning-bg';
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-xs font-medium ${headingColor}`}>{title}</p>
      <ul
        className={`max-h-32 overflow-y-auto rounded-card border ${boxColor} p-2 text-xs text-neutral-text-secondary`}
      >
        {issues.map((issue, i) => (
          <li key={`${issue.row}-${issue.field}-${i}`}>
            Row {issue.row} · {issue.field}: {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Import-risks-from-CSV modal (issue 223): the symmetric counterpart of the risk
 * register's "Export CSV". It owns the upload state machine
 * (idle → uploading → result | error) and reuses the shared
 * {@link ImportDropzone}. Unlike the async MS Project import, this import is
 * synchronous, so the success branch renders a result summary (imported /
 * skipped counts + per-row errors and warnings) rather than a "queued" notice.
 *
 * Focus is trapped within the dialog and restored to the trigger on close,
 * matching the app's modal convention (ImportModal / NewProjectModal).
 */
export function RiskImportModal({ projectId, onClose }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const importMut = useImportRisks(projectId);

  // Capture trigger before the modal opens; restore focus on unmount.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  // Escape closes; Tab/Shift+Tab cycles within the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleSelect(picked: File) {
    setRejectMsg(null);
    importMut.reset();
    setFile(picked);
  }

  function handleClear() {
    setFile(null);
    setRejectMsg(null);
    importMut.reset();
  }

  function handleImport() {
    if (!file || importMut.isPending) return;
    importMut.mutate(file);
  }

  function importAnother() {
    setFile(null);
    importMut.reset();
  }

  const result = importMut.data;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-50 cursor-default bg-neutral-overlay"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[51] flex items-center justify-center p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Import risks from CSV"
          tabIndex={-1}
          className="pointer-events-auto w-full max-w-[560px] rounded-card border border-neutral-border
            bg-neutral-surface p-6 focus-visible:outline-none"
        >
          <h2 className="mb-1 text-base font-semibold text-neutral-text-primary">
            Import risks from CSV
          </h2>
          <p className="mb-5 text-xs text-neutral-text-secondary">
            Upload a CSV to add risks to this project. Columns match the export — Title is required;
            unknown columns are ignored.
          </p>

          {importMut.isSuccess && result ? (
            /* Result — partial success: counts + per-row diagnostics. */
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">
                <span aria-hidden="true" className="text-semantic-on-track">
                  ✓{' '}
                </span>
                Imported {result.imported} {result.imported === 1 ? 'risk' : 'risks'}
                {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}.
              </p>
              <IssueList title="Skipped rows" issues={result.errors} tone="error" />
              <IssueList title="Warnings" issues={result.warnings} tone="warning" />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={importAnother}
                  className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Import another
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Done
                </button>
              </div>
            </div>
          ) : importMut.isError ? (
            /* Hard error — the file was rejected outright; nothing committed. */
            <div role="alert" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">
                <span aria-hidden="true">✕ </span>
                {importErrorMessage(importMut.error)}
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={importAnother}
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Try a different file
                </button>
              </div>
            </div>
          ) : importMut.isPending ? (
            /* Uploading — the parse is synchronous on the server. */
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">Importing {file?.name}…</p>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-surface-raised"
                role="progressbar"
                aria-label="Importing file"
              >
                <div className="h-full w-1/3 motion-safe:animate-pulse rounded-full bg-brand-primary" />
              </div>
            </div>
          ) : (
            /* Idle / file-selected. */
            <div className="flex flex-col gap-4">
              <ImportDropzone
                accept={RISK_IMPORT_ACCEPT}
                maxSizeMb={RISK_IMPORT_MAX_UPLOAD_MB}
                file={file}
                onSelect={handleSelect}
                onClear={handleClear}
                onReject={setRejectMsg}
              />

              {rejectMsg && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {rejectMsg}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={!file}
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
                    hover:bg-brand-primary-dark disabled:cursor-not-allowed disabled:opacity-50
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                    focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Import
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
