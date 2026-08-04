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
        programName={intent.programName}
        onClose={close}
        onCreated={(projectId, intent) => {
          close();
          // "Create & import spreadsheet" (#2710) lands in the Schedule with the
          // CSV wizard already open, rather than on an empty Overview the user
          // would then have to find an overflow menu inside. The wizard needs a
          // project id, so the project is created first and the deep link hands
          // it in — `?import=csv` follows the same `useSearchParams` convention
          // ScheduleView already uses for `?task=`, `?focus=`, `?cp=`.
          void navigate(
            intent?.importCsv
              ? `/projects/${projectId}/schedule?import=csv`
              : `/projects/${projectId}/overview`,
          );
        }}
      />
    );
  }

  // `story` is handled by ProductBacklogPage (the page is always mounted when the
  // story target is reachable — it only resolves on the backlog route).
  return null;
}
