import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { canEditTask } from '@/lib/roles';
import { registry, type DrawerSectionRegistration } from '@/lib/widget-registry';
import { registerOssDrawerSections } from './sections';
// Importing SectionList loads the drawer module, whose init registers the OSS
// sections; the explicit call below is a defensive idempotent guarantee.
import { SectionList } from './TaskDetailDrawer';
import { TaskDescriptionField } from './TaskDescriptionField';
import { TaskScheduleStrip } from './TaskScheduleStrip';

registerOssDrawerSections();

/**
 * Full-page focus view of a single task (handoff "what changed" #13 — drawer for
 * context + expand-to-full-page for deep work). Renders the same registry-driven
 * sections the drawer hosts, in a roomy single column so everything is visible
 * at once (no tab switching). Reached from the drawer's Expand control at
 * `/projects/:projectId/tasks/:taskId`.
 *
 * The name and Description edit inline with a blur-PATCH (no drawer Save bar on
 * the page); every write gates on the same server-derived `canEdit` verdict the
 * drawer computes so the deep-work surface never diverges from it (#2154).
 */
export function TaskDetailPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const { tasks, isLoading } = useScheduleTasks(projectId);
  const { role: userRole } = useCurrentUserRole(projectId);
  const updateTask = useUpdateTask();

  const task = tasks?.find((t) => t.id === taskId);

  // Effective edit capability (ADR-0133): prefer the server per-task verdict,
  // fall back to the client role rule only when absent — the exact contract the
  // drawer uses, so the page never shows a write control the drawer would hide
  // (or vice versa). Threaded into every section and the schedule strip.
  const canEdit = task?.canEdit ?? canEditTask(userRole);

  // Inline drafts for the two page-level editable fields. Seed once per task
  // identity; a background refetch of the same task does not clobber an in-flight
  // edit (the page commits on blur, not through the drawer's staged draft). Our
  // own blur-PATCH updates the cache optimistically, leaving the draft in sync.
  const [draftName, setDraftName] = useState(task?.name ?? '');
  const [draftNotes, setDraftNotes] = useState(task?.notes ?? '');
  const descScrollRef = useRef(0);
  useEffect(() => {
    setDraftName(task?.name ?? '');
    setDraftNotes(task?.notes ?? '');
    descScrollRef.current = 0;
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- re-seed on task identity only

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

  const accessibleTitle = `${task.wbs ? `${task.wbs} — ` : ''}${draftName || task.name}`;

  // Commit the name on blur/Enter. Never persist an empty name (would 400 and
  // wipe the title) — revert the draft to the saved value instead. baseVersion
  // gives the same field-level merge / 409 protection the drawer's save has.
  const commitName = () => {
    const next = draftName.trim();
    if (next.length === 0) {
      setDraftName(task.name);
      return;
    }
    if (!canEdit || next === task.name) return;
    updateTask.mutate({ id: task.id, projectId: projectId ?? '', name: next, baseVersion: task.serverVersion });
  };

  const commitNotes = () => {
    if (!canEdit || draftNotes === (task.notes ?? '')) return;
    updateTask.mutate({ id: task.id, projectId: projectId ?? '', notes: draftNotes, baseVersion: task.serverVersion });
  };

  return (
    <div className="h-full overflow-y-auto bg-app-canvas">
      <div className="mx-auto max-w-3xl p-6">
        <Link
          to={backLink}
          className="text-sm text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          ← Back to schedule
        </Link>

        {/* sr-only heading keeps the page's landmark/heading structure stable for
            AT and tests while the visible title is an inline editable input. */}
        <h1 className="sr-only">{accessibleTitle}</h1>
        <div className="mt-3 flex items-baseline gap-2">
          {task.wbs && (
            <span className="tppm-mono shrink-0 text-sm font-semibold text-neutral-text-secondary">
              {task.wbs}
            </span>
          )}
          <input
            aria-label="Task name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onBlur={commitName}
            // Read-only for non-editors renders as plain heading text (no border,
            // no caret) so it never invites an edit that would 403 (ADR-0133).
            readOnly={!canEdit}
            className={[
              'min-w-0 flex-1 bg-transparent border-none px-0 rounded-control',
              'font-display text-2xl font-semibold text-neutral-text-primary',
              canEdit
                ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1'
                : 'cursor-default focus:outline-none',
            ].join(' ')}
          />
        </div>

        <div className="mt-4">
          <TaskScheduleStrip task={task} projectId={projectId} canEdit={canEdit} />
        </div>

        {/* Description — deferred to the drawer's curated layout there, but the
            deep-work page must show (and edit) it too. Blur-PATCH fallback: no
            staged draft, so no cross-field change signal (changedElsewhere). */}
        <div className="mt-5">
          <TaskDescriptionField
            value={draftNotes}
            onChange={setDraftNotes}
            onBlur={commitNotes}
            changedElsewhere={false}
            readOnly={!canEdit}
            scrollTopRef={descScrollRef}
          />
        </div>

        {/* The full task detail — the same sections the drawer hosts. */}
        <div className="mt-5 overflow-hidden rounded-card border border-neutral-border bg-neutral-surface">
          <SectionList
            sections={sections}
            taskId={task.id}
            projectId={projectId ?? ''}
            userRole={userRole}
            canEdit={canEdit}
          />
        </div>
      </div>
    </div>
  );
}
