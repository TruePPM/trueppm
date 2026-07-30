import type { SyncConflict } from '@/api/conflict';
import { Button } from '@/components/Button';

// #2036: human-readable labels for the snake_case field names the API returns in
// a 409 `conflict_fields` list, so the conflict banner reads in domain terms.
const CONFLICT_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  notes: 'Notes',
  status: 'Status',
  duration: 'Duration',
  percent_complete: 'Progress',
  planned_start: 'Planned start',
  type: 'Type',
  governance_class: 'Governance class',
  delivery_mode: 'Delivery mode',
  story_points: 'Story points',
  sprint: 'Sprint',
};

function conflictFieldLabel(field: string): string {
  return (
    CONFLICT_FIELD_LABELS[field] ??
    field.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

/** Join field labels into a natural-language list ("Name, Notes and Status"). */
function formatConflictFieldList(fields: string[]): string {
  const labels = fields.map(conflictFieldLabel);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Render a server value from the 409 body for display, or null when there's
 * nothing meaningful to show (RBAC-filtered fields arrive absent/null).
 */
function formatServerValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** One conflicted field and, when the server disclosed it, its current value. */
function ConflictFieldItem({ field, serverValue }: { field: string; serverValue: unknown }) {
  const shown = formatServerValue(serverValue);
  return (
    <li>
      <span className="font-medium">{conflictFieldLabel(field)}</span>
      {shown !== null && <> — now “{shown}” on the server</>}
    </li>
  );
}

export interface SyncConflictBannerProps {
  conflict: SyncConflict;
  /** Disables both actions while a save is in flight. */
  isPending: boolean;
  /** Rebase onto the server's version and re-save with the user's edits. */
  onKeepEdits: () => void;
  /** Dismiss the banner and let the user reconcile by hand. */
  onKeepEditing: () => void;
}

/**
 * Inline 409 banner for the task modal (ADR-0217, #2036).
 *
 * A sync conflict on this surface used to close the modal and discard every
 * field the user had edited. This names the conflicting fields in place and
 * offers rebase-and-resave instead, so nothing typed is lost. The mutation
 * suppresses its own conflict toast so this banner is the single signal.
 */
export function SyncConflictBanner({
  conflict,
  isPending,
  onKeepEdits,
  onKeepEditing,
}: SyncConflictBannerProps) {
  const named = conflict.conflict_fields.length > 0;
  return (
    <div
      role="alert"
      className="bg-semantic-at-risk-bg border border-semantic-at-risk/30 text-semantic-at-risk text-xs px-3 py-2.5 rounded-card space-y-2"
    >
      <p className="font-semibold">
        Someone else changed{' '}
        {named ? formatConflictFieldList(conflict.conflict_fields) : 'this task'} while you were
        editing.
      </p>
      {named && (
        <ul className="list-disc pl-4 space-y-0.5">
          {conflict.conflict_fields.map((field) => (
            <ConflictFieldItem key={field} field={field} serverValue={conflict.server_value[field]} />
          ))}
        </ul>
      )}
      <p>
        Keep your edits (they’ll overwrite the changes above), or keep editing to reconcile them
        yourself.
      </p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button type="button" size="sm" onClick={onKeepEdits} disabled={isPending}>
          Keep my edits &amp; save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onKeepEditing}
          disabled={isPending}
        >
          Keep editing
        </Button>
      </div>
    </div>
  );
}
