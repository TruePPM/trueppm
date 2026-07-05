import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  MS_PROJECT_MAX_UPLOAD_MB,
  useCreateProjectFromImport,
} from '@/hooks/useMsProjectImportExport';
import {
  SEED_MAX_UPLOAD_MB,
  seedImportErrors,
  useImportProgramSeed,
} from '@/hooks/useProgramSeedIo';
import { ImportDropzone } from './ImportDropzone';
import { FormatPicker, type ImportFormat } from './FormatPicker';

interface Props {
  onClose: () => void;
  /** Called with the new project's id once the 202 lands; the caller navigates. */
  onCreated: (projectId: string) => void;
  /**
   * Called with the new program's id when a native TruePPM seed is imported
   * (ADR-0222). Only wired by the standalone entry (Sidebar) — a native export
   * re-materializes as a whole program, so it is not offered when `programId`
   * scopes the dialog to an existing program.
   */
  onProgramImported?: (programId: string) => void;
  /** When set, the new project is created already assigned to this program. */
  programId?: string;
  /** Program name for the "Added to …" affordance (shown only with programId). */
  programName?: string;
}

/** Only `.xml` is offered for MS Project today; `.mpp`/`.mpx` are gated (#128/#120). */
const XML_ONLY = ['.xml'] as const;
/** Native TruePPM seeds are canonical JSON documents (ADR-0109, #1611). */
const JSON_ONLY = ['.json'] as const;

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Pull the server's `detail` message out of a failed MS Project request, if present. */
function msProjectErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string') return detail;
  }
  return "Couldn't read this file. It may be corrupted or not a valid MS Project XML export.";
}

/**
 * Create-a-project-from-a-file modal (ADR-0092, ADR-0222, #797, #1611).
 *
 * Distinct from {@link ImportModal} (which imports into an existing project):
 * this creates a NEW thing from an uploaded file. Two sources via
 * {@link FormatPicker}:
 * - **MS Project** `.xml` → {@link useCreateProjectFromImport}. The 202 returns a
 *   project id synchronously; on success the modal hands it to `onCreated` and
 *   the caller navigates to the project, where the post-import `TaskRun` drives
 *   the importing → success/failure state (the VoC "no silent async" rule).
 * - **TruePPM** `.json` (native canonical seed) → {@link useImportProgramSeed}.
 *   A native export re-materializes as a whole *program* (ADR-0222), so on
 *   success the modal hands the new program id to `onProgramImported`. This tile
 *   is only live in the standalone entry (no `programId`).
 *
 * Focus is trapped within the dialog and restored to the trigger on close,
 * matching the app's modal convention (ImportModal / NewProjectModal).
 */
export function ImportProjectModal({
  onClose,
  onCreated,
  onProgramImported,
  programId,
  programName,
}: Props) {
  // A native TruePPM seed imports as a whole program, which cannot be nested
  // inside an existing program — so the tile is only a live choice in the
  // standalone entry (ADR-0222). Scoped-to-a-program dialogs stay MS Project.
  const truePpmEnabled = !programId;

  const [format, setFormat] = useState<ImportFormat>('msproject');
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [guidanceOpen, setGuidanceOpen] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const createMut = useCreateProjectFromImport();
  const seedMut = useImportProgramSeed();

  const isTruePpm = format === 'trueppm';
  const activeMut = isTruePpm ? seedMut : createMut;

  useEffect(() => {
    triggerRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

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

  function resetMutations() {
    createMut.reset();
    seedMut.reset();
  }

  function handleFormatChange(next: ImportFormat) {
    if (next === format) return;
    // A picked file is format-specific (different accepted extensions), so
    // switching formats clears it and any prior attempt.
    setFormat(next);
    setFile(null);
    setRejectMsg(null);
    setGuidanceOpen(false);
    resetMutations();
  }

  function handleSelect(picked: File) {
    setRejectMsg(null);
    resetMutations();
    setFile(picked);
  }

  function handleReject(message: string) {
    setRejectMsg(message);
    // For MS Project the usual rejected file is a .mpp/.mpx — surface the
    // conversion guidance. The native JSON path has no such disclosure.
    if (!isTruePpm) setGuidanceOpen(true);
  }

  function handleImport() {
    if (!file || activeMut.isPending) return;
    if (isTruePpm) {
      seedMut.mutate(file, {
        onSuccess: (program) => onProgramImported?.(program.id),
      });
      return;
    }
    createMut.mutate({ file, programId }, { onSuccess: (data) => onCreated(data.project_id) });
  }

  // The native seed importer returns a line-level validation report (a list);
  // MS Project returns a single message. Normalize both to a string[].
  const errorLines: string[] = isTruePpm
    ? (() => {
        const lines = seedImportErrors(seedMut.error);
        return lines.length > 0
          ? lines
          : ['Import failed — please check the file and try again.'];
      })()
    : [msProjectErrorMessage(createMut.error)];

  const subtitle = isTruePpm
    ? 'Upload a TruePPM export (.json) to recreate its program and projects.'
    : 'Upload a Microsoft Project file to create a new project from its schedule.';

  return (
    <>
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
          aria-label="Import a project"
          tabIndex={-1}
          className="pointer-events-auto w-full max-w-[560px] rounded-card border border-neutral-border
            bg-neutral-surface p-6 focus-visible:outline-none"
        >
          <h2 className="mb-1 text-base font-semibold text-neutral-text-primary">
            Import a project
          </h2>
          <p className="mb-5 text-xs text-neutral-text-secondary">{subtitle}</p>

          {activeMut.isError ? (
            <div role="alert" className="flex flex-col gap-3">
              {errorLines.length === 1 ? (
                <p className="text-sm text-neutral-text-primary">
                  <span aria-hidden="true">✕ </span>
                  {errorLines[0]}
                </p>
              ) : (
                <div>
                  <p className="text-sm font-medium text-neutral-text-primary">
                    <span aria-hidden="true">✕ </span>
                    Couldn&apos;t import this file:
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-neutral-text-secondary">
                    {errorLines.slice(0, 8).map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                    {errorLines.length > 8 && <li>…and {errorLines.length - 8} more.</li>}
                  </ul>
                </div>
              )}
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
                  onClick={() => {
                    setFile(null);
                    resetMutations();
                  }}
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Try a different file
                </button>
              </div>
            </div>
          ) : activeMut.isPending ? (
            <div role="status" className="flex flex-col gap-3">
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
            <div className="flex flex-col gap-4">
              <FormatPicker
                format={format}
                onSelectFormat={handleFormatChange}
                truePpmEnabled={truePpmEnabled}
                guidanceOpen={guidanceOpen}
                onToggleGuidance={() => setGuidanceOpen((o) => !o)}
              />

              <ImportDropzone
                accept={isTruePpm ? JSON_ONLY : XML_ONLY}
                maxSizeMb={isTruePpm ? SEED_MAX_UPLOAD_MB : MS_PROJECT_MAX_UPLOAD_MB}
                file={file}
                onSelect={handleSelect}
                onClear={() => {
                  setFile(null);
                  setRejectMsg(null);
                  resetMutations();
                }}
                onReject={handleReject}
              />

              {rejectMsg && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {rejectMsg}
                </p>
              )}

              {!isTruePpm && programId && programName && (
                <p className="text-xs text-neutral-text-secondary">
                  Will be added to the <strong>{programName}</strong> program.
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
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
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
