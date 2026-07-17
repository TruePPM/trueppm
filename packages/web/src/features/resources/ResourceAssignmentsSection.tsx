import { useId } from 'react';
import axios from 'axios';
import { Link } from 'react-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useResourceAssignments } from '@/hooks/useResourceAssignments';
import type { ResourceAssignment } from '@/hooks/useResourceAssignments';
import { StatusPill, STATUS_LABEL } from '@/features/grid/ui';
import { groupAssignmentsByProject } from './groupAssignmentsByProject';

/**
 * "Assignments" section of the org catalog ResourceDetailPanel (#2047, ADR-0499):
 * what is this person working on, across every project. Read-only projection of a
 * new IsOrgAdmin-gated endpoint.
 *
 * Two gates keep it safe and quiet for the wrong audience:
 *  1. `can_access_admin_settings` — hide the section entirely for non-admins so we
 *     never fire a request that would 403. This client boolean is *broader* than
 *     the server's IsOrgAdmin, so it is a UX gate, not the security boundary.
 *  2. a 403 backstop — if a workspace-admin-but-not-org-admin slips past gate 1,
 *     the endpoint 403s and we render nothing rather than an error (the server
 *     gate is authoritative). Any *other* error shows an inline alert + retry.
 */
export function ResourceAssignmentsSection({ resourceId }: { resourceId: string }) {
  const { user } = useCurrentUser();
  const canView = user?.can_access_admin_settings ?? false;
  // Gate the whole data component so the hook only runs for admins (a non-admin
  // never issues the request). Hooks can't be conditional, hence the split.
  if (!canView) return null;
  return <AssignmentsSectionInner resourceId={resourceId} />;
}

function AssignmentsSectionInner({ resourceId }: { resourceId: string }) {
  const headingId = useId();
  const { data, isLoading, isError, error, refetch } = useResourceAssignments(resourceId);

  // The server gate is authoritative: a 403 means "you may not see this", so we
  // hide the section rather than surfacing a scary error (see component doc).
  if (isError && axios.isAxiosError(error) && error.response?.status === 403) {
    return null;
  }

  return (
    <section aria-labelledby={headingId}>
      <p
        id={headingId}
        className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2"
      >
        Assignments
      </p>

      {isLoading ? (
        <AssignmentsSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-semantic-critical/40 bg-semantic-critical-bg text-xs text-semantic-critical"
        >
          <span>Couldn’t load assignments.</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="shrink-0 underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            Retry
          </button>
        </div>
      ) : !data || data.length === 0 ? (
        <p className="text-xs text-neutral-text-disabled">No current assignments.</p>
      ) : (
        <AssignmentsList assignments={data} />
      )}
    </section>
  );
}

function AssignmentsList({ assignments }: { assignments: ResourceAssignment[] }) {
  const groups = groupAssignmentsByProject(assignments);
  // Neutral cross-project counts only — no units total, no utilization score
  // (that's the Enterprise line, ADR-0499). "N tasks across M projects" is a fact.
  const taskCount = assignments.length;
  const projectCount = groups.length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-text-secondary">
        {taskCount} {taskCount === 1 ? 'task' : 'tasks'} across {projectCount}{' '}
        {projectCount === 1 ? 'project' : 'projects'}
      </p>

      {groups.map((group) => (
        <div key={group.projectId}>
          <Link
            to={`/projects/${group.projectId}/resources/allocation`}
            aria-label={`${group.projectName} — open allocation view`}
            className="flex items-center gap-1 text-xs font-medium text-neutral-text-primary hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
          >
            <span className="min-w-0 truncate" title={group.projectName}>
              {group.projectName}
            </span>
            <span className="shrink-0 text-neutral-text-secondary" aria-hidden="true">
              ({group.assignments.length})
            </span>
          </Link>
          {/* aria-label keeps the list role (a named role="group" would strip list
              semantics and is pruned by Chromium — rule 760). */}
          <ul aria-label={group.projectName} className="mt-1 space-y-1">
            {group.assignments.map((a) => (
              <AssignmentRow key={a.id} assignment={a} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AssignmentRow({ assignment: a }: { assignment: ResourceAssignment }) {
  const pct = Math.round(a.percentComplete);
  const done = a.status === 'COMPLETE';
  // Task name alone is ambiguous across projects, so the accessible name carries
  // project + status + percent + allocation (rule 171 — one composite phrase; the
  // numeric spans below are aria-hidden to avoid a double read).
  const label = `${a.taskName}, ${a.projectName}, ${STATUS_LABEL[a.status] ?? a.status}, ${pct}% complete, ${a.units} allocation units`;
  return (
    <li>
      <Link
        to={`/projects/${a.projectId}/schedule?task=${a.taskId}`}
        aria-label={label}
        className="block rounded-card px-1 py-1.5 hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <span
          className={`block text-xs truncate ${done ? 'line-through text-neutral-text-disabled' : 'text-neutral-text-primary'}`}
          title={a.taskName}
        >
          {a.taskName}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5" aria-hidden="true">
          <StatusPill status={a.status} />
          <span className="shrink-0 tppm-mono text-xs text-neutral-text-secondary">{pct}%</span>
          <span
            className="shrink-0 tppm-mono text-xs text-neutral-text-secondary"
            title={`${a.units} allocation units`}
          >
            {a.units}×
          </span>
        </span>
      </Link>
    </li>
  );
}

function AssignmentsSkeleton() {
  return (
    <div className="space-y-1" aria-busy="true" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-11 rounded border border-neutral-border bg-neutral-surface-raised animate-pulse"
        />
      ))}
    </div>
  );
}
