/**
 * Route → create-target resolver for the context-aware "+ New" affordance
 * (ADR-0131 §B, 1179). Pure (pathname in, targets out) so it is trivially
 * unit-tested; the RBAC gate and the id wiring live in `CreateMenu`.
 *
 * Grouping is contextual: each route resolves to the create flow(s) that make
 * sense *there* — never a generic dialog. Routes not listed resolve to `[]`
 * (the "+ New" is suppressed): overview, calendar, resources, reports, settings,
 * My Work (Priya — contributor surface), risk (its view owns a prominent create),
 * and the unscoped workspace root (the Sidebar owns workspace project-create).
 */
export type CreateTargetKind = 'task' | 'milestone' | 'story' | 'project';

export interface CreateTarget {
  kind: CreateTargetKind;
  /** Lowercase noun for the button/menu label ("New task", "Task"). */
  label: string;
}

const LABEL: Record<CreateTargetKind, string> = {
  task: 'task',
  milestone: 'milestone',
  story: 'story',
  project: 'project',
};

/** Views where a project-scoped task create is the right action. */
const TASK_VIEWS = new Set(['board', 'grid', 'sprints']);

function targets(...kinds: CreateTargetKind[]): CreateTarget[] {
  return kinds.map((kind) => ({ kind, label: LABEL[kind] }));
}

/**
 * Resolve the ordered create targets for a pathname. The first target is the
 * primary; >1 means the "+ New" renders a small menu (Schedule = Task / Milestone).
 */
export function resolveCreateTargets(pathname: string): CreateTarget[] {
  const projectMatch = /^\/projects\/[^/]+\/([^/?#]+)/.exec(pathname);
  if (projectMatch) {
    const view = projectMatch[1];
    if (view === 'schedule') return targets('task', 'milestone');
    if (view === 'product-backlog') return targets('story');
    if (TASK_VIEWS.has(view)) return targets('task');
    return [];
  }
  // Any program-scoped route → create a project in this program.
  if (/^\/programs\/[^/]+(\/|$)/.test(pathname)) return targets('project');
  return [];
}
