/** Minimal "Add task to phase" modal for the per-phase + affordance (issue #208). */
import { useRef, useState, useEffect, type FormEvent } from 'react';
import { useCreateTask } from '@/hooks/useTaskMutations';
import { useProjectId } from '@/hooks/useProjectId';

interface Props {
  phaseName: string;
  phaseId: string;
  onClose: () => void;
}

function getFocusable(el: HTMLElement): HTMLElement[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function AddTaskModal({ phaseName, phaseId, onClose }: Props) {
  const projectId = useProjectId() ?? '';
  const createTask = useCreateTask(projectId || null);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createTask.isPending) return;
    createTask.mutate(
      { name: trimmed, duration: 5, parent_id: phaseId },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 z-50 bg-black/40 cursor-default"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Add task to ${phaseName}`}
          className="w-full max-w-sm rounded-lg border border-neutral-border bg-neutral-surface p-5 pointer-events-auto"
        >
          <h2 className="text-sm font-semibold text-neutral-text-primary mb-4">
            Add task to <span className="text-brand-primary">{phaseName}</span>
          </h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Task name <span aria-hidden="true">*</span>
              </span>
              <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                required
                aria-required="true"
                placeholder="Task name"
                className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {createTask.isError && (
              <p role="alert" className="text-xs text-semantic-critical">
                Failed to create task. Please try again.
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={createTask.isPending}
                className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || createTask.isPending}
                className="h-9 px-4 rounded text-sm font-medium bg-brand-primary text-white
                  disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
                  focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
              >
                {createTask.isPending ? 'Adding…' : 'Add task'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
