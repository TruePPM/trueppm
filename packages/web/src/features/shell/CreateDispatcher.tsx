import { useNavigate } from 'react-router';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import { NewProjectModal } from './NewProjectModal';
import { TaskFormModal } from '@/features/board/TaskFormModal';

/**
 * Mounted once in AppShell (ADR-0131, 1179). Renders the self-contained create
 * modals for the active `CreateIntent` published by the "+ New" affordance (or, later,
 * the ⌘K palette). The inline backlog `story` target is consumed by `ProductBacklogPage`,
 * not here — this dispatcher only owns the modal targets (task / milestone / project).
 *
 * Sprint-safe (ADR-0102): a `task` intent carries no sprint, so `TaskFormModal` opens
 * with `defaultSprintId` unset → the task is created unassigned and never silently
 * injected into an active sprint.
 */
export function CreateDispatcher() {
  const intent = useCreateIntentStore((s) => s.intent);
  const close = useCreateIntentStore((s) => s.close);
  const navigate = useNavigate();

  if (!intent) return null;

  if (intent.kind === 'task') {
    return (
      <TaskFormModal
        projectId={intent.projectId}
        task={null}
        isMilestone={intent.isMilestone}
        isMobile={false}
        onClose={close}
        onCreated={() => close()}
      />
    );
  }

  if (intent.kind === 'project') {
    return (
      <NewProjectModal
        programId={intent.programId}
        onClose={close}
        onCreated={(projectId) => {
          close();
          void navigate(`/projects/${projectId}/overview`);
        }}
      />
    );
  }

  // `story` is handled by ProductBacklogPage (the page is always mounted when the
  // story target is reachable — it only resolves on the backlog route).
  return null;
}
