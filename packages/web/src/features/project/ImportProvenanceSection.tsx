/**
 * Project Overview → Project history section (#799 — import provenance).
 *
 * Renders the "Imported from <file> on <date> by <user>" affordance the
 * Marcus (PMO) persona asked for on the #796 epic's VoC panel. Source of
 * record is GET /projects/{pk}/imports/ — see useImportRequests.
 *
 * Self-hiding: the section returns `null` when the project has no recorded
 * imports, so projects authored in TruePPM (the common case) don't see an
 * empty placeholder. Rows are purged from the backend after 7 days, so a
 * project imported a month ago naturally rolls off this surface; the
 * enterprise audit overlay carries the durable record.
 */

import { formatRelative } from '@/lib/formatRelative';
import { useImportRequests } from '@/hooks/useImportRequests';
import type {
  ImportProvenanceRow,
  ImportRequestStatus,
} from '@/hooks/useImportRequests';

interface ImportProvenanceSectionProps {
  projectId: string;
}

export function ImportProvenanceSection({ projectId }: ImportProvenanceSectionProps) {
  const { data, isLoading, isError } = useImportRequests(projectId);

  // While loading, keep the page quiet — the section is informational and the
  // overview already shows skeletons elsewhere; a fourth skeleton here adds
  // visual noise for what is the empty case 95% of the time.
  if (isLoading || isError) return null;
  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-label="Project history">
      <h2 className="text-sm font-semibold text-neutral-text-secondary uppercase tracking-wide mb-3">
        Project history
      </h2>
      <ul
        className="flex flex-col gap-2 p-4 rounded border border-neutral-border bg-neutral-surface-raised"
        aria-label="Imports for this project"
      >
        {rows.map((row) => (
          <ImportProvenanceItem key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function ImportProvenanceItem({ row }: { row: ImportProvenanceRow }) {
  const requestedAt = new Date(row.requested_at);
  const user = row.initiated_by_username ?? 'an unknown user';
  // Distinct verb for the "created project from this import" case (Marcus
  // wants to see at a glance whether the project predates the import or
  // was born from it).
  const verb = row.creates_project ? 'Imported into a new project' : 'Imported';

  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <span className="text-neutral-text-primary">
        {verb} from <span className="font-medium tppm-mono">{row.filename}</span>
        {' · '}
        <span title={requestedAt.toISOString()}>{formatRelative(requestedAt)}</span>
        {' · by '}
        <span className="font-medium">{user}</span>
      </span>
      <span className="text-xs text-neutral-text-secondary">
        <StatusBadge status={row.status} />
        {row.task_count != null && (
          <>
            {' '}
            <span className="tppm-mono">{row.task_count}</span> task
            {row.task_count === 1 ? '' : 's'} imported
          </>
        )}
      </span>
    </li>
  );
}

// Status pill colors mirror the design system semantic palette so the
// failed-import case stands out without needing a separate row treatment.
const STATUS_CLASS: Record<ImportRequestStatus, string> = {
  pending: 'border-neutral-border text-neutral-text-secondary',
  dispatched: 'border-brand-primary/40 text-brand-primary',
  done: 'border-semantic-on-track/40 text-semantic-on-track',
  dead: 'border-semantic-critical/40 text-semantic-critical',
};

const STATUS_LABEL: Record<ImportRequestStatus, string> = {
  pending: 'Queued',
  dispatched: 'Running',
  done: 'Complete',
  dead: 'Failed',
};

function StatusBadge({ status }: { status: ImportRequestStatus }) {
  return (
    <span
      className={`inline-block bg-transparent border rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
      aria-label={`Import status: ${STATUS_LABEL[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
