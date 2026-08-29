import { useState } from 'react';
import { isAxiosError } from 'axios';
import {
  MS_PROJECT_ACCEPT,
  MS_PROJECT_MAX_UPLOAD_MB,
  useImportMsProject,
} from '@/hooks/useMsProjectImportExport';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { ImportDropzone, type ImportRejectReason } from './ImportDropzone';
import { MsProjectXmlRecipe } from './msProjectXmlRecipe';
import { CheckIcon, XMarkIcon } from '@/components/Icons';

interface Props {
  /** Active project; the modal is gated on a non-null id by the caller. */
  projectId: string | null;
  onClose: () => void;
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
  // Kept beside the message rather than derived from it: the advice branches on
  // WHY the file was refused, and re-deriving that by matching on the message
  // text would re-couple the copy to the logic.
  const [rejectReason, setRejectReason] = useState<ImportRejectReason | null>(null);

  const importMut = useImportMsProject(projectId);

  // The modal stays open while its body swaps phase (picking → uploading →
  // success/error), unmounting whichever control held focus. Passing the phase
  // as `focusKey` re-seats focus inside the dialog on each swap so Tab can't
  // escape to the background page (#1776). The uploading phase has no focusable
  // content — focus falls back to the dialog container (tabIndex={-1}).
  const phase = importMut.isSuccess
    ? 'success'
    : importMut.isError
      ? 'error'
      : importMut.isPending
        ? 'uploading'
        : 'picking';
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, phase);

  function handleSelect(picked: File) {
    setRejectMsg(null);
    setRejectReason(null);
    importMut.reset();
    setFile(picked);
  }

  function handleClear() {
    setFile(null);
    setRejectMsg(null);
    setRejectReason(null);
    importMut.reset();
  }

  function handleReject(message: string, reason: ImportRejectReason) {
    setRejectMsg(message);
    setRejectReason(reason);
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
        className="fixed inset-0 z-50 cursor-default bg-neutral-overlay"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[51] flex items-center justify-center p-4 max-md:items-stretch max-md:p-0">
        {/* On phones (≤ md, 768px) the card becomes a full-screen sheet: edge-to-edge,
            full height, no rounding/border, header + scrollable body + docked footer.
            Mirrors the repo's mobile-sheet convention (HeatmapCellDrawer). The 640px
            design boundary maps to this repo's `md` breakpoint since `sm` is redefined
            to 375px. (#788) */}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Import from MS Project"
          tabIndex={-1}
          // #2674: the flex + scroll shape below used to be `max-md:` only, so
          // the mobile sheet scrolled and the ordinary desktop dialog had no
          // height cap and no scroller at all — the exposure #2665 fixed on
          // `NewProjectModal`, left live here. It is now unconditional; the
          // `max-md:` classes that remain are the sheet's own chrome (edge-to-
          // edge, no rounding, safe-area padding), not its scrolling.
          className="pointer-events-auto flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden
            rounded-card border border-neutral-border
            bg-neutral-surface p-6 focus-visible:outline-none
            max-md:h-full max-md:max-w-none max-md:rounded-none max-md:border-0 max-md:pb-0"
        >
          <h2 className="mb-1 shrink-0 text-base font-semibold text-neutral-text-primary">
            Import from MS Project
          </h2>
          <p className="mb-5 shrink-0 text-xs text-neutral-text-secondary">
            Upload a Microsoft Project file to add its tasks to this project.
          </p>

          {/* Success — the import was queued. */}
          {importMut.isSuccess ? (
            <div role="status" className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                <p className="text-sm text-neutral-text-primary">
                  <CheckIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
                  Import started. Your tasks will appear in the schedule shortly.
                </p>
                <p className="text-xs text-neutral-text-secondary">
                  Large files can take a moment to process. The schedule refreshes automatically when
                  the import finishes.
                </p>
              </div>
              <div className="flex shrink-0 justify-end pt-2 max-md:-mx-6 max-md:border-t max-md:border-neutral-border max-md:px-6 max-md:pt-4 max-md:pb-[env(safe-area-inset-bottom)]">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 max-md:h-11 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Done
                </button>
              </div>
            </div>
          ) : importMut.isError ? (
            /* Hard error — nothing committed. */
            <div role="alert" className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                <p className="text-sm text-neutral-text-primary">
                  <XMarkIcon className="inline-block h-3 w-3 align-[-0.125em] mr-1" aria-hidden="true" />
                  {importErrorMessage(importMut.error)}
                </p>
              </div>
              <div className="flex shrink-0 justify-end gap-2 pt-2 max-md:-mx-6 max-md:border-t max-md:border-neutral-border max-md:px-6 max-md:pt-4 max-md:pb-[env(safe-area-inset-bottom)]">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 max-md:h-11 rounded-control border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={tryAgain}
                  className="h-9 max-md:h-11 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Try a different file
                </button>
              </div>
            </div>
          ) : importMut.isPending ? (
            /* Uploading — server-side parse progress is deferred to #61. */
            <div role="status" className="flex min-h-0 flex-1 flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">Uploading {file?.name}…</p>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-surface-raised"
                role="progressbar"
                aria-label="Uploading file"
              >
                <div className="h-full w-1/3 motion-safe:animate-pulse rounded-full bg-brand-primary" />
              </div>
            </div>
          ) : (
            /* Idle / file-selected. */
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                <ImportDropzone
                  accept={MS_PROJECT_ACCEPT}
                  maxSizeMb={MS_PROJECT_MAX_UPLOAD_MB}
                  file={file}
                  onSelect={handleSelect}
                  onClear={handleClear}
                  onReject={handleReject}
                />

                {/* One `role="alert"` wrapping the failure AND its remedy. As
                    siblings the recipe sits outside the alert's subtree, so a
                    screen-reader user hears "that file can't be imported" and
                    nothing about the fix — the actionable half never announced.
                    This file's own error branch already does it this way.

                    The recipe renders only for an `'extension'` rejection. A
                    `'size'` rejection is usually a valid but oversized MSPDI
                    `.xml`, and answering that with "save it as XML" describes what
                    the user just did (#2892).

                    Neutral, not amber: the class string was inherited from the
                    `.mpp` caveat banner this replaced, which was a genuine warning
                    *state*. This is instructional how-to (rules 8b/145), and an
                    amber card outshouts the red line that is the actual error.
                    `FormatPicker` renders the same copy neutral. */}
                {rejectMsg && (
                  <div role="alert" className="flex flex-col gap-2">
                    <p className="text-xs text-semantic-critical">{rejectMsg}</p>
                    {rejectReason === 'extension' && (
                      <p className="rounded-card border border-neutral-border bg-neutral-surface-raised p-2 text-xs text-neutral-text-secondary">
                        TruePPM imports MS Project XML. <MsProjectXmlRecipe />
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 max-md:-mx-6 max-md:border-t max-md:border-neutral-border max-md:px-6 max-md:pt-4 max-md:pb-[env(safe-area-inset-bottom)]">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 max-md:h-11 rounded-control border border-neutral-border px-4 text-sm font-medium
                    text-neutral-text-secondary hover:text-neutral-text-primary
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={!file}
                  className="h-9 max-md:h-11 rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse
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
