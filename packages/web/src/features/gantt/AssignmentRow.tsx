import { useState, type KeyboardEvent } from 'react';
import type { TaskAssignment } from '@/types';

export interface AssignmentRowProps {
  assignment: TaskAssignment;
  onUnitsChange: (decimal: number) => void;
  onRemove: () => void;
  isUpdating: boolean;
  isRemoving: boolean;
}

export function AssignmentRow({
  assignment,
  onUnitsChange,
  onRemove,
  isUpdating,
  isRemoving,
}: AssignmentRowProps) {
  // Draft state: integer percent shown in the input
  const [draft, setDraft] = useState<string>(String(Math.round(assignment.units * 100)));

  // Sync draft when the server value changes (e.g. after optimistic rollback)
  const serverPct = Math.round(assignment.units * 100);

  function commitDraft() {
    const parsed = parseInt(draft, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 200) {
      // Revert to current server value
      setDraft(String(serverPct));
      return;
    }
    const decimal = parsed / 100;
    if (decimal !== assignment.units) {
      onUnitsChange(decimal);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      commitDraft();
      (e.target as HTMLInputElement).blur();
    }
  }

  const isDisabled = isUpdating || isRemoving;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-neutral-border/40 last:border-b-0">
      {/* Resource name */}
      <span
        className="flex-1 text-sm text-neutral-text-primary truncate"
        title={assignment.resourceName}
      >
        {assignment.resourceName}
      </span>

      {/* Units input — integer percent */}
      <input
        type="number"
        min={1}
        max={200}
        value={draft}
        disabled={isDisabled}
        aria-label={`Allocation percent for ${assignment.resourceName}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={handleKeyDown}
        className="w-14 text-xs text-center border border-neutral-border rounded px-1.5 py-1
          bg-neutral-surface text-neutral-text-primary
          disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />

      {/* Percent label */}
      <span className="text-xs text-neutral-text-disabled shrink-0" aria-hidden="true">
        %
      </span>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        disabled={isDisabled}
        aria-label={`Remove ${assignment.resourceName} from task`}
        className="w-6 h-6 flex items-center justify-center rounded text-neutral-text-disabled
          hover:text-semantic-critical
          disabled:opacity-40 disabled:cursor-not-allowed
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          p-3 -mx-1 md:mx-0 md:p-0"
      >
        ×
      </button>
    </div>
  );
}
