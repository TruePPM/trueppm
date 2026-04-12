import { useRef, useState, useEffect, type FormEvent } from 'react';
import { useCreateProject } from '@/hooks/useProjectMutations';

interface Props {
  onClose: () => void;
  /** Called after the project is created so the caller can navigate to it. */
  onCreated: (projectId: string) => void;
}

/**
 * Modal dialog for creating a new project.
 * Uses a role="dialog" overlay pattern; focus is trapped via the form itself.
 * Calendar is optional — the Project model allows null.
 */
export function NewProjectModal({ onClose, onCreated }: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const createProject = useCreateProject();

  // Autofocus project name on mount
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createProject.isPending) return;
    createProject.mutate(
      { name: trimmed, start_date: startDate, description: description.trim() || undefined },
      { onSuccess: (data) => onCreated(data.id) },
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div
          className="w-full max-w-md rounded-lg border border-neutral-border bg-neutral-surface p-6 shadow-none"
        >
          <h2 className="text-base font-semibold text-neutral-text-primary mb-4">
            New project
          </h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Project name */}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Name <span aria-hidden="true">*</span>
              </span>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                required
                disabled={createProject.isPending}
                placeholder="My Project"
                className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {/* Start date */}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Start date <span aria-hidden="true">*</span>
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                disabled={createProject.isPending}
                className="h-9 px-3 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {/* Description (optional) */}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-text-secondary">
                Description
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={createProject.isPending}
                rows={2}
                maxLength={1000}
                placeholder="Optional"
                className="px-3 py-2 rounded border border-neutral-border bg-neutral-surface
                  text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled resize-none
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />
            </label>

            {/* Error message */}
            {createProject.isError && (
              <p role="alert" className="text-xs text-semantic-critical">
                Failed to create project. Please try again.
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={createProject.isPending}
                className="h-9 px-4 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || createProject.isPending}
                className="h-9 px-4 rounded text-sm font-medium bg-brand-primary text-white
                  disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-primary-dark
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {createProject.isPending ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
