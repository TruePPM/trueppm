import { useEffect, useRef, useState } from 'react';
import type { Program } from '@/api/types';
import { useDeleteProgram } from '@/hooks/useProgramMutations';

interface Props {
  program: Program;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * Type-to-confirm cascade-delete dialog for a Program (ADR-0070 §Risks).
 *
 * Two intent locks before submit:
 *  1. The user types the exact program name into the confirm input.
 *  2. The submit button is explicit ("Delete program and remove members") and
 *     red — not a generic "OK".
 *
 * The server-side service layer atomically removes all memberships and then
 * soft-deletes the program in one transaction, so there is no orphan window
 * to worry about on the client side.
 */
export function DeleteProgramDialog({ program, onClose, onDeleted }: Props) {
  const deleteProgram = useDeleteProgram();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const confirmRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const canDelete = confirm.trim() === program.name && !deleteProgram.isPending;

  async function handleDelete(): Promise<void> {
    setError(null);
    try {
      await deleteProgram.mutateAsync(program.id);
      onDeleted();
    } catch (err) {
      setError(
        err instanceof Error && err.message ? err.message : 'Failed to delete program.',
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-program-heading"
        className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-6"
      >
        <h2 id="delete-program-heading" className="text-lg font-semibold text-neutral-text-primary">
          Delete &ldquo;{program.name}&rdquo;?
        </h2>

        <div className="mt-4 space-y-3 text-sm text-neutral-text-secondary">
          <p>
            This program has {program.member_count}{' '}
            member{program.member_count === 1 ? '' : 's'} and {program.project_count}{' '}
            project{program.project_count === 1 ? '' : 's'}.
          </p>
          <p>Deleting will:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Remove all program members</li>
            <li>Detach all projects (they become standalone, untouched)</li>
            <li>Permanently delete the program</li>
          </ul>
          <p className="text-xs">Project member access and project data are not affected.</p>
        </div>

        <label htmlFor="delete-confirm" className="mt-5 block text-sm font-medium text-neutral-text-primary">
          Type the program name to confirm:
        </label>
        <input
          id="delete-confirm"
          ref={confirmRef}
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
          className="mt-1 block w-full rounded border border-neutral-border bg-neutral-surface px-3 py-2 text-sm
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />

        {error && (
          <p role="alert" className="mt-3 text-xs text-semantic-critical">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded border border-neutral-border px-4 text-sm font-medium text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={!canDelete}
            className="h-9 rounded bg-semantic-critical px-4 text-sm font-medium text-white
              hover:bg-semantic-critical/90 disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
          >
            {deleteProgram.isPending ? 'Deleting…' : 'Delete program and remove members'}
          </button>
        </div>
      </div>
    </div>
  );
}
