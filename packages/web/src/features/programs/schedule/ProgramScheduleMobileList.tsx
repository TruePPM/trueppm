import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { WarningIcon } from '@/components/Icons';
import { fmtUtcLong, fmtUtcShort } from '@/lib/formatUtcDate';
import { useProgramRollup } from '../ProgramOverviewPage';
import type { ProgramSchedule, ProgramScheduleTask } from '../hooks/useProgramSchedule';

/**
 * Phone surface for the program schedule (#3480): the canvas Gantt is a wide
 * timeline, so below `md` the page renders this DOM list instead — the same
 * idiom as the project schedule's phone list (`MobileSchedule`: critical rail,
 * 44px+ row targets, short dates), grouped by member project.
 *
 * Render-don't-derive (ADR-0115): every date, criticality flag and cross-project
 * edge is read straight off the server payload; the P80 finish comes from the
 * rollup's Monte Carlo forecast (`GET /programs/{id}/rollup/`). Nothing is
 * recomputed here. A row is listed when it is on the program-true critical path
 * or is an endpoint of a cross-project link — the two things the desktop view
 * exists to show.
 */
export function ProgramScheduleMobileList({
  data,
  programId,
}: {
  data: ProgramSchedule;
  programId: string | undefined;
}) {
  const navigate = useNavigate();
  const { data: rollup } = useProgramRollup(programId);

  const programP80 = typeof rollup?.forecast?.value === 'string' ? rollup.forecast.value : null;
  const p80ByProject = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const row of rollup?.projects ?? []) map.set(row.id, row.p80);
    return map;
  }, [rollup]);

  const lanes = useMemo(() => {
    const crossIds = new Set<string>();
    for (const link of data.links) {
      if (!link.is_cross_project) continue;
      crossIds.add(link.predecessor_id);
      crossIds.add(link.successor_id);
    }
    return data.projects.map((project) => {
      const tasks = data.tasks
        .filter(
          (t) => t.project_id === project.id && (t.is_critical === true || crossIds.has(t.id)),
        )
        .sort((a, b) => (a.early_start ?? '9999').localeCompare(b.early_start ?? '9999'));
      return { project, tasks, crossIds };
    });
  }, [data]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-neutral-surface-sunken">
      <div
        className="border-b border-neutral-border bg-neutral-surface px-4 py-3"
        data-testid="program-schedule-mobile-summary"
      >
        <p className="text-sm text-neutral-text-primary">
          {programP80 ? (
            <>
              P80 finish <span className="tppm-mono font-semibold">{fmtUtcLong(programP80)}</span>
            </>
          ) : (
            <span className="text-neutral-text-secondary">No P80 forecast yet</span>
          )}
        </p>
        {/* A hint, not a wall (#3480): the list is the phone answer, the timeline
            is the richer one. */}
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Showing critical-path tasks and cross-project links. Open the program schedule on a tablet
          or desktop for the full timeline.
        </p>
      </div>
      <ul className="divide-y-0" aria-label="Critical path by project">
        {lanes.map(({ project, tasks, crossIds }) => {
          const p80 = p80ByProject.get(project.id) ?? null;
          return (
            <li key={project.id} className="mt-3" aria-label={project.name}>
              <div className="flex min-h-11 items-center gap-2 border-y border-neutral-border bg-neutral-surface px-4 py-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-text-primary">
                  {project.name}
                </h2>
                <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                  {p80 ? `P80 ${fmtUtcShort(p80)}` : 'No forecast'}
                </span>
              </div>
              {tasks.length === 0 ? (
                <p className="bg-neutral-surface px-4 py-3 text-sm text-neutral-text-secondary">
                  No critical-path tasks in this project.
                </p>
              ) : (
                <ul className="divide-y divide-neutral-border bg-neutral-surface">
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      isCross={crossIds.has(task.id)}
                      onOpen={(projectId, taskId) =>
                        void navigate(`/projects/${projectId}/schedule?task=${taskId}`)
                      }
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TaskRow({
  task,
  isCross,
  onOpen,
}: {
  task: ProgramScheduleTask;
  isCross: boolean;
  onOpen: (projectId: string, taskId: string) => void;
}) {
  const name = task.is_external ? task.title : task.name;
  const datesText = !task.early_start
    ? 'Not scheduled'
    : task.is_milestone || !task.early_finish || task.early_finish === task.early_start
      ? fmtUtcShort(task.early_start)
      : `${fmtUtcShort(task.early_start)} – ${fmtUtcShort(task.early_finish)}`;
  const label =
    `${name}, ${datesText}` +
    (task.is_critical ? ', on the critical path' : '') +
    (isCross ? ', cross-project link' : '');

  const content = (
    <span className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2">
      <span
        aria-hidden="true"
        className={`h-4 w-1 shrink-0 rounded-full ${
          task.is_critical ? 'bg-semantic-critical' : 'bg-transparent'
        }`}
      />
      <span className="tppm-mono shrink-0 rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5 text-xs text-neutral-text-secondary">
        {task.hex_id}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-text-primary">{name}</span>
      {task.is_critical && (
        <WarningIcon className="h-3 w-3 shrink-0 text-semantic-critical" aria-hidden="true" />
      )}
      {isCross && (
        <span className="shrink-0 rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs text-neutral-text-secondary">
          Cross-project
        </span>
      )}
      <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">{datesText}</span>
    </span>
  );

  // An external (redacted) task belongs to a project the viewer cannot open, so
  // it is a static row — a link would land on a 403.
  if (task.is_external) {
    return (
      <li aria-label={label} data-testid="program-schedule-mobile-row">
        {content}
      </li>
    );
  }
  return (
    <li data-testid="program-schedule-mobile-row">
      <button
        type="button"
        aria-label={label}
        onClick={() => onOpen(task.project_id, task.id)}
        className="block w-full text-left active:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
      >
        {content}
      </button>
    </li>
  );
}
