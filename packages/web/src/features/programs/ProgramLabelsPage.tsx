/**
 * /programs/:programId/labels — find work by label across a program (#2333, ADR-0638).
 *
 * Labels are project-scoped (ADR-0400), so this view groups by label *name*
 * across the program's projects. Three consequences drive the whole layout:
 *
 *  1. **Rows are grouped by project.** Within a project every chip for a given
 *     name is the same color, so color varies only across a boundary the user
 *     has already been shown. Ungrouped, the same label in two colors reads
 *     unmistakably as a bug.
 *  2. **The filter control is deliberately colorless.** Tinting it would assert
 *     one project's color as canonical and make every other row look wrong.
 *     Do not "fix" this by styling it with a label color.
 *  3. **Partial visibility is disclosed.** A program member need not belong to
 *     every project in the program; what is withheld is stated rather than
 *     silently dropped.
 */
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { LabelPill } from '@/components/LabelPill';
import {
  useProgramLabelCatalog,
  useProgramLabelTasks,
  type ProgramLabelTask,
} from './hooks/useProgramLabels';

/** Shared with the Board facet (ADR-0620) so a fifth view cannot invent its own key. */
const LABEL_PARAM = 'fl';

function groupByProject(tasks: ProgramLabelTask[]): [string, ProgramLabelTask[]][] {
  const groups = new Map<string, ProgramLabelTask[]>();
  for (const task of tasks) {
    const key = task.project.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(task);
    else groups.set(key, [task]);
  }
  return [...groups.entries()];
}

function WithheldNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="mt-4 text-xs text-neutral-text-secondary" data-testid="withheld-note">
      {count === 1
        ? "1 project in this program isn't shown — you're not a member of it."
        : `${count} projects in this program aren't shown — you're not a member of them.`}
    </p>
  );
}

/** "1 project" / "3 projects" — a count and its noun, agreeing. */
function countOf(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

export function ProgramLabelsPage() {
  const { programId } = useParams<{ programId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get(LABEL_PARAM) ?? '';

  const catalog = useProgramLabelCatalog(programId);
  const tasks = useProgramLabelTasks(programId, selected);

  const groups = useMemo(
    () => groupByProject(tasks.data?.results ?? []),
    [tasks.data?.results],
  );

  // Only explain the per-project color rule when the result set actually shows
  // more than one color for the selected name — otherwise it becomes chrome
  // people stop reading long before they hit the case it explains.
  const showsMultipleColors = useMemo(() => {
    const colors = new Set<string>();
    for (const task of tasks.data?.results ?? []) {
      for (const label of task.labels) {
        if (label.name.toLowerCase() === selected.toLowerCase()) colors.add(label.color);
      }
    }
    return colors.size > 1;
  }, [tasks.data?.results, selected]);

  const onSelect = (name: string) => {
    const next = new URLSearchParams(searchParams);
    if (name) next.set(LABEL_PARAM, name);
    else next.delete(LABEL_PARAM);
    setSearchParams(next, { replace: true });
  };

  const withheld =
    tasks.data?.withheld_project_count ?? catalog.data?.withheld_project_count ?? 0;

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-neutral-text-primary">Labels</h1>
        <p className="mt-1 text-sm text-neutral-text-secondary">
          Find work by label across every project in this program.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-border pb-3">
        <label
          htmlFor="program-label-filter"
          className="text-sm font-medium text-neutral-text-primary"
        >
          Label
        </label>
        {/* Neutral by design — see the file header, point 2. */}
        <select
          id="program-label-filter"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          className="min-h-[44px] rounded-control border border-neutral-border bg-neutral-surface
            px-2 text-sm text-neutral-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          <option value="">Choose a label…</option>
          {(catalog.data?.results ?? []).map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name} — in {countOf(entry.project_count, 'project')}
            </option>
          ))}
        </select>
        {selected && tasks.data ? (
          <span className="text-sm text-neutral-text-secondary" aria-live="polite">
            {countOf(tasks.data.count, 'task')} · {countOf(groups.length, 'project')}
          </span>
        ) : null}
      </div>

      {!selected ? (
        <div className="py-16 text-center">
          <p className="text-sm font-medium text-neutral-text-primary">
            Pick a label to see its work
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-neutral-text-secondary">
            Labels are created per project — this finds every task carrying the same label
            name across the program.
          </p>
          <WithheldNote count={withheld} />
        </div>
      ) : null}

      {selected && tasks.isPending ? (
        <div className="mt-4 space-y-3" aria-busy="true">
          {[0, 1].map((group) => (
            <div key={group}>
              <div className="h-4 w-40 animate-pulse rounded bg-neutral-surface-raised" />
              <div className="mt-2 space-y-1">
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className="h-11 animate-pulse rounded-card bg-neutral-surface-raised"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selected && tasks.isError ? (
        <div className="mt-6 text-center">
          <p className="text-sm text-neutral-text-primary">Couldn&apos;t load tasks for this label.</p>
          <button
            type="button"
            onClick={() => void tasks.refetch()}
            className="mt-2 min-h-[44px] rounded-control border border-neutral-border px-3 text-sm
              text-neutral-text-primary hover:bg-chrome-row-hover
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            Try again
          </button>
        </div>
      ) : null}

      {selected && tasks.isSuccess ? (
        <>
          {showsMultipleColors ? (
            <p className="mt-3 text-xs text-neutral-text-secondary">
              Label colors are set per project, so the same label can look different in each.
            </p>
          ) : null}

          {groups.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm text-neutral-text-primary">
                No tasks carry <strong>{selected}</strong> in this program.
              </p>
              <WithheldNote count={withheld} />
            </div>
          ) : (
            <>
              {groups.map(([projectId, rows]) => (
                <section key={projectId} className="mt-6" aria-labelledby={`grp-${projectId}`}>
                  <h2
                    id={`grp-${projectId}`}
                    className="sticky top-0 z-10 flex items-baseline gap-2 bg-neutral-surface py-1
                      text-sm font-medium text-neutral-text-primary"
                  >
                    <span className="truncate">{rows[0].project.name}</span>
                    <span className="tppm-mono text-xs text-neutral-text-secondary">
                      {rows[0].project.code}
                    </span>
                    <span className="ml-auto text-xs font-normal text-neutral-text-secondary">
                      {rows.length} {rows.length === 1 ? 'task' : 'tasks'}
                    </span>
                  </h2>
                  <ul className="divide-y divide-neutral-border/30 rounded-card border border-neutral-border">
                    {rows.map((task) => (
                      <li key={task.id}>
                        <Link
                          to={`/projects/${task.project.id}/schedule?task=${task.id}`}
                          className="flex min-h-[44px] flex-wrap items-center gap-2 px-3 py-2 text-sm
                            hover:bg-chrome-row-hover
                            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                            focus-visible:ring-brand-primary"
                        >
                          <span className="tppm-mono text-xs text-neutral-text-secondary">
                            {task.wbs_path}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-neutral-text-primary">
                            {task.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {task.labels.map((label) => (
                              <LabelPill key={label.id} label={label} />
                            ))}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <WithheldNote count={withheld} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
