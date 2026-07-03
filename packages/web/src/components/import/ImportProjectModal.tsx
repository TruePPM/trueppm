import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import {
  MS_PROJECT_MAX_UPLOAD_MB,
  useCreateProjectFromImport,
} from '@/hooks/useMsProjectImportExport';
import { ImportDropzone } from './ImportDropzone';
import { FormatPicker } from './FormatPicker';

interface Props {
  onClose: () => void;
  /** Called with the new project's id once the 202 lands; the caller navigates. */
  onCreated: (projectId: string) => void;
  /** When set, the new project is created already assigned to this program. */
  programId?: string;
  /** Program name for the "Added to …" affordance (shown only with programId). */
  programName?: string;
}

/** Only `.xml` is offered today; `.mpp`/`.mpx` are gated in the picker (#128/#120). */
const XML_ONLY = ['.xml'] as const;

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
  return "Couldn't read this file. It may be corrupted or not a valid MS Project XML export.";
}

/**
 * Create-a-project-from-a-file modal (ADR-0092, #797).
 *
 * Distinct from {@link ImportModal} (which imports into an existing project):
 * this creates a NEW project from an MS Project XML file via
 * {@link useCreateProjectFromImport}. The 202 returns the project id
 * synchronously, so on success the modal hands that id to `onCreated` and the
 * caller navigates to the project, where the post-import `TaskRun` drives the
 * importing → success/failure state (the VoC "no silent async" requirement).
 *
 * Focus is trapped within the dialog and restored to the trigger on close,
 * matching the app's modal convention (ImportModal / NewProjectModal).
 */
export function ImportProjectModal({ onClose, onCreated, programId, programName }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [guidanceOpen, setGuidanceOpen] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const createMut = useCreateProjectFromImport();

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

  function handleSelect(picked: File) {
    setRejectMsg(null);
    createMut.reset();
    setFile(picked);
  }

  function handleReject(message: string) {
    setRejectMsg(message);
    // The usual rejected file is a .mpp/.mpx — surface the conversion guidance.
    setGuidanceOpen(true);
  }

  function handleImport() {
    if (!file || createMut.isPending) return;
    createMut.mutate(
      { file, programId },
      { onSuccess: (data) => onCreated(data.project_id) },
    );
  }

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
          <p className="mb-5 text-xs text-neutral-text-secondary">
            Upload a Microsoft Project file to create a new project from its schedule.
          </p>

          {createMut.isError ? (
            <div role="alert" className="flex flex-col gap-3">
              <p className="text-sm text-neutral-text-primary">
                <span aria-hidden="true">✕ </span>
                {importErrorMessage(createMut.error)}
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
                  onClick={() => {
                    setFile(null);
                    createMut.reset();
                  }}
                  className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
                    hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
                >
                  Try a different file
                </button>
              </div>
            </div>
          ) : createMut.isPending ? (
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
                guidanceOpen={guidanceOpen}
                onToggleGuidance={() => setGuidanceOpen((o) => !o)}
              />

              <ImportDropzone
                accept={XML_ONLY}
                maxSizeMb={MS_PROJECT_MAX_UPLOAD_MB}
                file={file}
                onSelect={handleSelect}
                onClear={() => {
                  setFile(null);
                  setRejectMsg(null);
                  createMut.reset();
                }}
                onReject={handleReject}
              />

              {rejectMsg && (
                <p role="alert" className="text-xs text-semantic-critical">
                  {rejectMsg}
                </p>
              )}

              {programId && programName && (
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
