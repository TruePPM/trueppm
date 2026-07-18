import { WarningIcon } from '@/components/Icons';
import { useMemo } from 'react';
import { useProgramId } from '@/hooks/useProgramId';
import {
  useProgramResourceContention,
  type ProgramAllocationResource,
  type ProgramAllocationTask,
} from '@/hooks/useProgramResourceContention';
import {
  defaultWindow,
  detectOverallocatedAssignments,
  detectOverallocationWeekRange,
} from '@/features/resource/resourceUtils';
import { PermissionDeniedNotice } from '@/features/resource/PermissionDeniedNotice';

/**
 * Within-program resource contention view (#1149).
 *
 * Surfaces people over-allocated across the **sibling projects of one program**
 * in overlapping windows — the contention the GA-launch sample program
 * deliberately creates. Reads the Scheduler+ `resource-contention` endpoint and
 * reuses the per-project allocation math (ADR-0031, client-side detection):
 * `detectOverallocatedAssignments` flags the spans, `detectOverallocationWeekRange`
 * labels the window.
 *
 * This is OSS, within-program **visibility** only — it shows contention, it does
 * not level resources or cross a program boundary.
 */
export function ProgramResourcesPage() {
  const programId = useProgramId();
  // Window is stable within a session (defaultWindow is ±4 weeks from today);
  // memoize so the query key doesn't churn each render.
  const window_ = useMemo(() => defaultWindow(), []);
  const { data, status } = useProgramResourceContention(programId ?? undefined, {
    start: window_.start,
    end: window_.end,
  });

  return (
    <div className="px-6 py-5 max-w-4xl">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-neutral-text-primary m-0">Resource contention</h1>
        <p className="mt-1 text-sm text-neutral-text-secondary">
          People staffed across more than one of this program&rsquo;s projects in overlapping
          windows. Over-allocation is anyone above their capacity on a given day.
        </p>
      </header>

      {status === 'loading' && (
        <p role="status" className="text-sm text-neutral-text-secondary">
          Loading contention…
        </p>
      )}

      {status === 'forbidden' && <PermissionDeniedNotice />}

      {status === 'schedule-not-run' && (
        <div
          role="status"
          className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-6 text-center text-sm text-neutral-text-secondary"
        >
          No project in this program has a computed schedule yet. Run the scheduler on a member
          project to see resource contention across the program.
        </div>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="rounded-card border border-semantic-critical/30 bg-semantic-critical-bg px-4 py-3 text-sm text-semantic-critical"
        >
          Couldn&rsquo;t load resource contention. Try again.
        </div>
      )}

      {status === 'success' && data && <ContentionList resources={data.resources} />}
    </div>
  );
}

function ContentionList({ resources }: { resources: ProgramAllocationResource[] }) {
  // Contended people first (the point of the view), then the server's
  // alphabetical order is preserved by the stable sort.
  const rows = useMemo(() => {
    return resources
      .map((r) => {
        const max = Number(r.max_units);
        const overSet = detectOverallocatedAssignments(r.tasks, max);
        const weekRange = detectOverallocationWeekRange(r.tasks, max);
        return { resource: r, max, overSet, weekRange };
      })
      .sort((a, b) => Number(b.weekRange !== null) - Number(a.weekRange !== null));
  }, [resources]);

  if (rows.length === 0) {
    return (
      <div
        role="status"
        className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-6 text-center text-sm text-neutral-text-secondary"
      >
        No one is assigned across this program&rsquo;s projects in the current window.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3 p-0 m-0 list-none">
      {rows.map(({ resource, max, overSet, weekRange }) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          maxUnits={max}
          overSet={overSet}
          weekRange={weekRange}
        />
      ))}
    </ul>
  );
}

function ResourceCard({
  resource,
  maxUnits,
  overSet,
  weekRange,
}: {
  resource: ProgramAllocationResource;
  maxUnits: number;
  overSet: Set<string>;
  weekRange: string | null;
}) {
  const byProject = useMemo(() => groupByProject(resource.tasks), [resource.tasks]);
  const capacityPct = Math.round(maxUnits * 100);

  return (
    <li className="rounded-card border border-neutral-border bg-neutral-surface p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-medium text-neutral-text-primary truncate">{resource.name}</span>
          <span className="tppm-mono text-xs text-neutral-text-secondary">
            {capacityPct}% capacity
          </span>
        </div>
        {weekRange !== null && (
          <span
            className="inline-flex items-center gap-1 text-xs font-semibold text-semantic-critical"
            aria-label={`Over-allocated in ${weekRange}`}
          >
            <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
            Over-allocated · <span className="tppm-mono">{weekRange}</span>
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {byProject.map((grp) => (
          <div key={grp.projectId} className="flex flex-col gap-1">
            <div className="text-xs font-semibold tracking-wide uppercase text-neutral-text-secondary">
              {grp.projectName}
            </div>
            <ul className="flex flex-col gap-0.5 p-0 m-0 list-none">
              {grp.tasks.map((t) => {
                const over = overSet.has(t.assignment_id);
                return (
                  <li
                    key={t.assignment_id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="truncate text-neutral-text-primary">
                      {over && (
                        <span
                          className="text-semantic-critical mr-1"
                          aria-label="contributes to over-allocation"
                        >
                          ●
                        </span>
                      )}
                      {t.name}
                    </span>
                    <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
                      {formatUnits(t.units)} · {formatSpan(t)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </li>
  );
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  tasks: ProgramAllocationTask[];
}

function groupByProject(tasks: ProgramAllocationTask[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const t of tasks) {
    let grp = map.get(t.project_id);
    if (!grp) {
      grp = { projectId: t.project_id, projectName: t.project_name, tasks: [] };
      map.set(t.project_id, grp);
    }
    grp.tasks.push(t);
  }
  return [...map.values()];
}

function formatUnits(units: string): string {
  // "1.00" → "100%", "0.50" → "50%"
  return `${Math.round(Number.parseFloat(units) * 100)}%`;
}

function formatSpan(t: ProgramAllocationTask): string {
  if (!t.early_start || !t.early_finish) return 'unscheduled';
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  return `${fmt(t.early_start)}–${fmt(t.early_finish)}`;
}
