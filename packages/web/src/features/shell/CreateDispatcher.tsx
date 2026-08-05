import { useNavigate } from 'react-router';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import { NewProjectModal } from './NewProjectModal';
import { createdProjectDestination } from './createdProjectDestination';
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
        programName={intent.programName}
        onClose={close}
        onCreated={(projectId, intent) => {
          close();
          // Centralized in `createdProjectDestination` (ADR-0800) so the CSV-import
          // deep link (#2710), the seeded-schedule landing (#2731) and the
          // agile-backlog landing (#2734) apply the same way at every entry point
          // that can open this modal — see that module for the full rationale.
          void navigate(createdProjectDestination(projectId, intent));
        }}
      />
    );
  }

  // `story` is handled by ProductBacklogPage (the page is always mounted when the
  // story target is reachable — it only resolves on the backlog route).
  return null;
}
