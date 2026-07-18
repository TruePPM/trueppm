import { useMemo } from 'react';
import { Link, useParams } from 'react-router';

import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditTask } from '@/lib/roles';
import { registry, type DrawerSectionRegistration } from '@/lib/widget-registry';
import { registerOssDrawerSections } from './sections';
// Importing SectionList loads the drawer module, whose init registers the OSS
// sections; the explicit call below is a defensive idempotent guarantee.
import { SectionList } from './TaskDetailDrawer';
import { TaskScheduleStrip } from './TaskScheduleStrip';

registerOssDrawerSections();

/**
 * Full-page focus view of a single task (handoff "what changed" #13 — drawer for
 * context + expand-to-full-page for deep work). Renders the same registry-driven
 * sections the drawer hosts, in a roomy single column so everything is visible
 * at once (no tab switching). Reached from the drawer's Expand control at
 * `/projects/:projectId/tasks/:taskId`.
 */
export function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const { tasks, isLoading } = useScheduleTasks(projectId);
  const { role: userRole } = useCurrentUserRole(projectId);

  const task = tasks?.find((t) => t.id === taskId);

  // All registered sections (priority-sorted), filtered by canRender for this
  // task — same contract as the drawer; on a full page we show every tab's
  // sections in one column rather than behind tabs.
  const sections = useMemo(() => {
    if (!task) return [];
    // A phase (summary that groups real WBS work) has a structural, non-subtask
    // child — the Subtasks section gates on this so its section is dropped here
    // exactly as its tab is hidden in the drawer (#1750).
    const hasStructuralChildren = (tasks ?? []).some(
      (t) => t.parentId === task.id && t.isSubtask !== true,
    );
    return (registry.get('task_detail.section') as DrawerSectionRegistration[]).filter(
      // `user` gates Enterprise-only sections; OSS canRender predicates read only
      // `task`. The full page has no separate section-context user (matches the
      // drawer's `sectionContext?.user` being undefined).
      (s) => !s.canRender || s.canRender({ user: undefined, task, hasStructuralChildren }),
    );
  }, [task, tasks]);

  const backLink = projectId ? `/projects/${projectId}/schedule` : '/';

  if (!task) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Link
          to={backLink}
          className="text-sm text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ← Back to schedule
        </Link>
        <p role="status" className="mt-8 text-center text-sm text-neutral-text-secondary">
          {isLoading ? 'Loading task…' : 'Task not found.'}
        </p>
      </div>
    );
  }

  const title = `${task.wbs ? `${task.wbs} — ` : ''}${task.name}`;

  return (
    <div className="h-full overflow-y-auto bg-app-canvas">
      <div className="mx-auto max-w-3xl p-6">
        <Link
          to={backLink}
          className="text-sm text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ← Back to schedule
        </Link>

        <h1 className="mt-3 font-display text-2xl font-semibold text-neutral-text-primary">
          {title}
        </h1>

        <div className="mt-4">
          <TaskScheduleStrip task={task} projectId={projectId} canEdit={canEditTask(userRole)} />
        </div>

        {/* The full task detail — the same sections the drawer hosts. */}
        <div className="mt-4 overflow-hidden rounded-card border border-neutral-border bg-neutral-surface">
          <SectionList
            sections={sections}
            taskId={task.id}
            projectId={projectId ?? ''}
            userRole={userRole}
          />
        </div>
      </div>
    </div>
  );
}
