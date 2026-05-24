import { useEffect, useRef, useState } from 'react';
import { usePrograms } from '@/hooks/usePrograms';
import { useAssignProjectToProgram } from '@/hooks/useProgramMutations';
import { ROLE_ADMIN } from '@/lib/roles';

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

/**
 * Modal picker for moving a standalone project INTO a program (ADR-0083, #697).
 *
 * This is the inverse of `AddProjectToProgramModal` (which picks a project for a
 * given program): here the project is fixed and the user picks the destination
 * program. Both share the `useAssignProjectToProgram` mutation. Only open,
 * non-closed programs the caller administers are offered — the server still
 * enforces ADMIN on the project itself, surfaced inline on failure.
 */
export function MoveToProgramModal({ projectId, projectName, onClose }: Props) {
  const { data: programs, isLoading } = usePrograms();
  const assignProject = useAssignProjectToProgram();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    dialogRef.current?.focus();
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

  // Eligible destinations: open programs the caller administers. The server
  // also requires ADMIN on the project; that check can only fail server-side,
  // so its error is surfaced inline rather than pre-filtered here.
  const eligible = (programs ?? []).filter(
    (p) => !p.is_closed && p.my_role !== null && p.my_role >= ROLE_ADMIN,
  );

  async function handleSubmit(): Promise<void> {
    if (!selectedId) return;
    setError(null);
    try {
      await assignProject.mutateAsync({ projectId, programId: selectedId });
      onClose();
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : 'Failed to move project.';
      setError(message);
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-program-heading"
        tabIndex={-1}
        className="flex w-full max-w-lg flex-col rounded-lg border border-neutral-border bg-neutral-surface focus:outline-none"
      >
        <header className="border-b border-neutral-border p-6">
          <h2 id="move-program-heading" className="text-lg font-semibold text-neutral-text-primary">
            Move &ldquo;{projectName}&rdquo; to a program
          </h2>
          <p className="mt-2 text-xs text-neutral-text-secondary">
            <span aria-hidden="true">ⓘ </span>
            The project keeps its own members, tasks, and history. Moving it only groups it under
            the program for shared rollup and policy.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading && (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  aria-hidden="true"
                  className="h-9 animate-pulse rounded bg-neutral-surface-raised"
                />
              ))}
            </div>
          )}

          {!isLoading && eligible.length === 0 && (
            <p className="text-sm text-neutral-text-secondary">
              You don&rsquo;t administer any open program to move this into. Create a program first,
              then move the project from here.
            </p>
          )}

          {!isLoading && eligible.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary">
                Choose a program ({eligible.length})
              </legend>
              <ul className="divide-y divide-neutral-border rounded border border-neutral-border">
                {eligible.map((p) => (
                  <li key={p.id}>
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 hover:bg-neutral-surface-raised">
                      <input
                        type="radio"
                        name="program"
                        value={p.id}
                        checked={selectedId === p.id}
                        onChange={() => setSelectedId(p.id)}
                        className="h-4 w-4 text-brand-primary
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-text-primary">
                        {p.name}
                      </span>
                      {p.code && (
                        <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                          {p.code}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="border-t border-neutral-border px-6 py-2 text-xs text-semantic-critical"
          >
            {error}
          </p>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-border p-4">
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
            onClick={() => void handleSubmit()}
            disabled={!selectedId || assignProject.isPending}
            className="h-9 rounded bg-brand-primary px-4 text-sm font-medium text-white
              hover:bg-brand-primary/90 disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            {assignProject.isPending ? 'Moving…' : 'Move project'}
          </button>
        </footer>
      </div>
    </div>
  );
}
