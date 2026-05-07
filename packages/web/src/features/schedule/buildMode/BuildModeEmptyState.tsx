import { useEffect, useRef } from 'react';

export interface BuildModeEmptyStateProps {
  /** Called when the CTA button is clicked or Enter is pressed inside the panel. */
  onAddFirstTask: () => void;
}

/**
 * Empty-state shown inside TaskListPanel when build-mode is on and the project
 * has zero tasks. Single primary CTA. Pressing Enter inside the panel container
 * is equivalent to clicking the CTA — the empty-state container is focused
 * on mount so the keyboard path works without an extra click.
 */
export function BuildModeEmptyState({ onAddFirstTask }: BuildModeEmptyStateProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="No tasks yet — press Enter or click the button to add the first task"
      tabIndex={0}
      className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-inset"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onAddFirstTask();
        }
      }}
    >
      <div
        className="text-2xl text-neutral-text-disabled mb-4 tracking-widest"
        aria-hidden="true"
      >
        ◆ ◆ ◆
      </div>
      <h2 className="text-[17px] font-semibold text-neutral-text-primary mb-2">
        No tasks yet
      </h2>
      <p className="text-[13px] text-neutral-text-secondary max-w-xs mb-5">
        Press Enter, or click below to add the first task.
      </p>
      <button
        type="button"
        onClick={onAddFirstTask}
        className="inline-flex h-9 px-4 items-center gap-2 rounded
          bg-brand-primary text-white text-[13px] font-medium
          hover:opacity-95
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-2 focus:ring-offset-neutral-surface"
      >
        + Add first task
        <kbd className="inline-flex h-5 px-1.5 items-center rounded border border-white/40 text-[11px] tppm-mono">
          ⏎
        </kbd>
      </button>
      <p className="mt-6 text-[12px] text-neutral-text-secondary max-w-xs">
        New here? Press <kbd className="inline-flex h-4 px-1 items-center rounded border border-neutral-border text-[11px] tppm-mono">?</kbd> to see all keyboard shortcuts.
      </p>
    </div>
  );
}
