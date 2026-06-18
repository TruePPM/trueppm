import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  MS_PROJECT_ACCEPT,
  MS_PROJECT_MAX_UPLOAD_MB,
  useImportMsProject,
} from '@/hooks/useMsProjectImportExport';
import { ImportDropzone } from './ImportDropzone';

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
  return "Couldn't import this file. It may be corrupted or saved in an unsupported MS Project version.";
}

/**
 * Import-from-MS-Project modal: the first file-IO surface (#68). It owns the
 * upload state machine (idle → uploading → success/error) and reuses the
 * shared {@link ImportDropzone}. The import is async on the server, so success
 * confirms the file was queued — the Gantt refetches when the worker lands the
 * tasks (live parse progress is deferred to #61). The CSV/Excel wizard (#111)
 * extends this shell with a multi-step body.
 *
 * Focus is trapped within the dialog and restored to the trigger on close,
 * matching the app's modal convention (NewProjectModal).
 */
export function ImportModal({ projectId, onClose }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const importMut = useImportMsProject(projectId);

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

  const isMpp = file?.name.toLowerCase().endsWith('.mpp') ?? false;

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

  function tryAgain() {
    setFile(null);
    importMut.reset();
  }

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-50 cursor-default bg-black/40"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[51] flex items-center justify-center p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Import from MS Project"
          tabIndex={-1}
          className="pointer-events-auto w-full max-w-[560px] rounded-card border border-neutral-border
            bg-neutral-surface p-6 focus-visible:outline-none"
        >
          <h2 className="mb-1 text-base font-semibold text-neutral-text-primary">
            Import from MS Project
          </h2>
          <p className="mb-5 text-xs text-neutral-text-secondary">
            Upload a Microsoft Project file to add its tasks to this project.
          </p>

          {/* Success — the import was queued. */}
          {importMut.isSuccess ? (
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">
                <span aria-hidden="true">✓ </span>
                Import started. Your tasks will appear in the schedule shortly.
              </p>
              <p className="text-xs text-neutral-text-secondary">
                Large files can take a moment to process. The schedule refreshes automatically when
                the import finishes.
              </p>
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded bg-brand-primary px-4 text-sm font-medium text-white
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Done
                </button>
              </div>
            </div>
          ) : importMut.isError ? (
            /* Hard error — nothing committed. */
            <div role="alert" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">
                <span aria-hidden="true">✕ </span>
                {importErrorMessage(importMut.error)}
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={tryAgain}
                  className="h-9 rounded bg-brand-primary px-4 text-sm font-medium text-white
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Try a different file
                </button>
              </div>
            </div>
          ) : importMut.isPending ? (
            /* Uploading — server-side parse progress is deferred to #61. */
            <div role="status" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">Uploading {file?.name}…</p>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-surface-raised"
                role="progressbar"
                aria-label="Uploading file"
              >
                <div className="h-full w-1/3 animate-pulse rounded-full bg-brand-primary" />
              </div>
            </div>
          ) : (
            /* Idle / file-selected. */
            <div className="flex flex-col gap-4">
              <ImportDropzone
                accept={MS_PROJECT_ACCEPT}
                maxSizeMb={MS_PROJECT_MAX_UPLOAD_MB}
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

              {/* .mpp requires the server's MPXJ (Java) toolchain; not all
                  deployments ship it. Warn rather than block — the API still
                  accepts .mpp where the toolchain is present. */}
              {isMpp && (
                <p className="rounded border border-semantic-warning/40 bg-semantic-warning-bg p-2 text-xs text-neutral-text-secondary">
                  .mpp import needs the MS Project toolchain on the server. If the import fails,
                  open the file in MS Project and save it as XML, then upload the .xml instead.
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={!file}
                  className="h-9 rounded bg-brand-primary px-4 text-sm font-medium text-white
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
