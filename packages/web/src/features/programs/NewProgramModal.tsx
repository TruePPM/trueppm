import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProgramMethodology } from '@/api/types';
import { useCreateProgram } from '@/hooks/useProgramMutations';

interface Props {
  onClose: () => void;
  onCreated: (programId: string) => void;
}

const METHODOLOGIES: ReadonlyArray<{
  id: ProgramMethodology;
  label: string;
  description: string;
}> = [
  { id: 'WATERFALL', label: 'Waterfall', description: 'Phase-gate program with Gantt-led projects' },
  { id: 'AGILE',     label: 'Agile',     description: 'Sprint-led projects with shared backlog' },
  { id: 'HYBRID',    label: 'Hybrid',    description: 'Mixed methodologies across projects (default)' },
];

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * Single-step modal for creating a new Program (ADR-0070).
 *
 * Programs are lightweight relative to projects, so this is one form rather
 * than a multi-step wizard. Focus is trapped within the dialog and restored
 * to the trigger element when the modal closes (WCAG 2.4.3).
 *
 * The dialog includes an in-form note that program members are NOT auto-added
 * to the program's projects — pre-empting the onboarding gotcha called out
 * in ADR-0070 §Risks.
 */
export function NewProgramModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [methodology, setMethodology] = useState<ProgramMethodology>('HYBRID');
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  const createProgram = useCreateProgram();

  // Capture the previously-focused element so we can restore focus when the
  // modal unmounts.
  useEffect(() => {
    triggerRef.current = document.activeElement;
    nameRef.current?.focus();
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
          last?.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) {
      setError('Name is required.');
      nameRef.current?.focus();
      return;
    }
    setError(null);
    try {
      const program = await createProgram.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        methodology,
      });
      onCreated(program.id);
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : 'Failed to create program.';
      setError(message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-program-heading"
        className="w-full max-w-md rounded-card border border-neutral-border bg-neutral-surface p-6"
      >
        <h2 id="new-program-heading" className="text-lg font-semibold text-neutral-text-primary">
          New program
        </h2>

        <form className="mt-4 space-y-4" onSubmit={(e) => void handleSubmit(e)}>
          <div>
            <label htmlFor="program-name" className="block text-sm font-medium text-neutral-text-primary">
              Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="program-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={255}
              required
              aria-required="true"
              className="mt-1 block w-full rounded-control border border-neutral-border bg-neutral-surface px-3 py-2 text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </div>

          <div>
            <label htmlFor="program-description" className="block text-sm font-medium text-neutral-text-primary">
              Description
            </label>
            <textarea
              id="program-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-control border border-neutral-border bg-neutral-surface px-3 py-2 text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
          </div>

          <fieldset>
            <legend className="block text-sm font-medium text-neutral-text-primary">Methodology</legend>
            <div className="mt-2 space-y-2">
              {METHODOLOGIES.map((m) => (
                <label
                  key={m.id}
                  htmlFor={`program-methodology-${m.id}`}
                  aria-label={`${m.label} — ${m.description}`}
                  className="flex cursor-pointer items-start gap-3 rounded-card border border-neutral-border p-3
                    has-[:checked]:border-brand-primary has-[:checked]:bg-brand-primary/5"
                >
                  <input
                    id={`program-methodology-${m.id}`}
                    type="radio"
                    name="methodology"
                    value={m.id}
                    checked={methodology === m.id}
                    onChange={() => setMethodology(m.id)}
                    className="mt-0.5 h-4 w-4 text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                  />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-neutral-text-primary">
                      {m.label}
                      {m.id === 'HYBRID' && (
                        <span className="ml-1 text-neutral-text-secondary">(default)</span>
                      )}
                    </span>
                    <span className="text-xs text-neutral-text-secondary">{m.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Onboarding hint — pre-empts the "program members get project access" gotcha
              (ADR-0070 §Risks). Three placements: create modal (here), members tab heading,
              projects tab heading — see ux-design output. */}
          <p
            role="note"
            className="rounded-card border border-neutral-border bg-neutral-surface-raised p-3 text-xs text-neutral-text-secondary"
          >
            <span aria-hidden="true">ⓘ </span>
            You will be added as Owner automatically. Project access is managed separately
            on each project — program members are not added to projects unless you invite
            them individually.
          </p>

          {error && (
            <p role="alert" className="text-xs text-semantic-critical">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-control border border-neutral-border px-4 text-sm font-medium text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createProgram.isPending}
              className="h-9 rounded-control bg-brand-primary px-4 text-sm font-medium text-white
                hover:bg-brand-primary/90 disabled:opacity-60
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {createProgram.isPending ? 'Creating…' : 'Create program'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
