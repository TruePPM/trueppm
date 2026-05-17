/**
 * Status picker — popover anchored to a status chip in /me/work (issue #499).
 *
 * Renders 4 selectable status options. On mobile (<md) the popover floats
 * over the row; on desktop it anchors below-left of the trigger chip. Both
 * dismiss on Escape or pointer-down outside.
 *
 * Optimistic updates and request lifecycle are owned by the parent — this
 * component is purely presentational, invoking ``onSelect(next)`` and
 * ``onClose()`` callbacks.
 */
import { useEffect, useRef } from 'react';
import type { TaskStatus } from '@/types';

const OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'NOT_STARTED', label: 'Not started' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'REVIEW', label: 'In review' },
  { value: 'COMPLETE', label: 'Complete' },
];

interface Props {
  taskName: string;
  current: TaskStatus;
  onSelect: (next: TaskStatus) => void;
  onClose: () => void;
}

export function StatusPicker({ taskName, current, onSelect, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  // Move keyboard focus into the picker on open so arrow keys work
  // immediately. Esc closes; pointer-down outside closes.
  useEffect(() => {
    firstOptionRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="status-picker-title"
      className="absolute z-30 mt-1 w-56 rounded-md border border-neutral-border bg-neutral-surface
                 focus-within:ring-2 focus-within:ring-brand-primary"
    >
      <div
        id="status-picker-title"
        className="px-3 py-2 text-xs font-semibold tracking-widest uppercase
                   text-neutral-text-secondary border-b border-neutral-border/50"
      >
        Move &ldquo;{taskName}&rdquo; to
      </div>
      <ul role="listbox" aria-label="Status options" className="py-1">
        {OPTIONS.map((opt, idx) => {
          const selected = opt.value === current;
          return (
            <li key={opt.value} role="option" aria-selected={selected}>
              <button
                type="button"
                ref={idx === 0 ? firstOptionRef : null}
                onClick={() => onSelect(opt.value)}
                disabled={selected}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-left
                  text-neutral-text-primary hover:bg-neutral-surface-raised
                  disabled:cursor-default disabled:text-neutral-text-secondary
                  focus-visible:outline-none focus-visible:bg-brand-primary/10
                  focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
              >
                <span>{opt.label}</span>
                {selected && (
                  <span aria-hidden="true" className="text-xs text-brand-primary">
                    ●
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-neutral-border/50 px-3 py-2 text-right">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
            rounded px-1"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
