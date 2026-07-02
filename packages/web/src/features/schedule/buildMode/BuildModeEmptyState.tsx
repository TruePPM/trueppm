import { useEffect, useRef } from 'react';
import { Button } from '@/components/Button';

export interface BuildModeEmptyStateProps {
  /** Called when the CTA button is clicked or Enter is pressed inside the panel. */
  onAddFirstTask: () => void;
}

/**
 * Empty-state shown inside TaskListPanel when build-mode is on and the project
 * has zero tasks. Single primary CTA. The CTA button auto-focuses on mount so
 * Enter triggers the action immediately without an extra click — buttons emit
 * a synthetic click on Enter natively, no extra keyboard handler needed.
 */
export function BuildModeEmptyState({ onAddFirstTask }: BuildModeEmptyStateProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return (
    <div
      role="region"
      aria-label="No tasks yet"
      className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center"
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
      <Button
        ref={buttonRef}
        variant="primary"
        size="lg"
        onClick={onAddFirstTask}
        className="gap-2"
      >
        + Add first task
        <kbd className="inline-flex h-5 px-1.5 items-center rounded-chip border border-navy-900/40 text-xs tppm-mono">
          ⏎
        </kbd>
      </Button>
      <p className="mt-6 text-[12px] text-neutral-text-secondary max-w-xs">
        New here? Press <kbd className="inline-flex h-4 px-1 items-center rounded-chip border border-neutral-border text-xs tppm-mono">?</kbd> to see all keyboard shortcuts.
      </p>
    </div>
  );
}
