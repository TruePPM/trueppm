import { useRef, useState, useEffect, type FormEvent } from 'react';

interface Props {
  onSubmit: (name: string, duration: number) => void;
  onCancel: () => void;
  isPending?: boolean;
}

/**
 * Inline task-creation form — rendered in a toolbar strip below the active view's
 * own toolbar. Autofocuses the name field on mount. Submits on Enter; Escape cancels.
 */
export function AddTaskForm({ onSubmit, onCancel, isPending = false }: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [duration, setDuration] = useState(1);

  // Autofocus name field on mount
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isPending) return;
    onSubmit(trimmed, duration);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 px-4 h-10 border-b border-neutral-border bg-neutral-surface flex-shrink-0"
      aria-label="Add task"
    >
      <input
        ref={nameRef}
        type="text"
        placeholder="Task name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
        maxLength={512}
        required
        disabled={isPending}
        className="flex-1 min-w-0 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
          text-sm text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        aria-label="Task name"
      />
      <label className="flex items-center gap-1 flex-shrink-0 text-sm text-neutral-text-secondary">
        <input
          type="number"
          min={1}
          max={9999}
          value={duration}
          onChange={(e) => setDuration(Math.max(1, Number(e.target.value)))}
          disabled={isPending}
          className="w-14 h-7 px-2 rounded border border-neutral-border bg-neutral-surface
            text-sm text-neutral-text-primary text-right
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          aria-label="Duration in days"
        />
        <span className="text-xs">days</span>
      </label>
      <button
        type="submit"
        disabled={!name.trim() || isPending}
        className="h-7 px-3 rounded text-xs font-medium bg-brand-primary text-white
          disabled:opacity-50 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        {isPending ? 'Adding…' : 'Add'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isPending}
        className="h-7 px-3 rounded text-xs font-medium border border-neutral-border
          text-neutral-text-secondary hover:text-neutral-text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Cancel
      </button>
    </form>
  );
}
