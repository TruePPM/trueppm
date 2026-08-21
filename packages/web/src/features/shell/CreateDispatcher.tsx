import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useCreateIntentStore } from '@/stores/createIntentStore';
import { NewProjectModal } from './NewProjectModal';
import { createdProjectDestination } from './createdProjectDestination';
import { authorLink } from '@/features/schedule/authorParam';

/**
 * Mounted once in AppShell (ADR-0131, 1179). Consumes the active `CreateIntent`
 * published by the "+ New" affordance (or, later, the ⌘K palette). The inline backlog
 * `story` target is consumed by `ProductBacklogPage`, not here.
 *
 * **A `task` intent no longer opens a form** (#2952, design case 18). It navigates to
 * the Designer with `?author=`, which lands the caret in a new row. The demotion is
 * the point: eight surfaces could create a task and each owned a modal, so where a
 * task came from decided what you could say about it and what it looked like while you
 * said it. The entry point survives; the form does not.
 *
 * What that costs, stated plainly: the modal collected a description, an assignee and a
 * date up front, and the row collects a name. Everything else moves to the drawer, one
 * click from the row that now exists. The trade is deliberate — a name is the only
 * field the plan actually needs, and the modal's other fields were the reason this path
 * felt heavier than typing.
 *
 * Sprint-safe (ADR-0102) and more so than before: the row is created with no sprint at
 * all, so it can never be silently injected into an active one.
 */
export function CreateDispatcher() {
  const intent = useCreateIntentStore((s) => s.intent);
  const close = useCreateIntentStore((s) => s.close);
  const navigate = useNavigate();

  // Navigation is a side effect, so it runs in an effect rather than during
  // render — `navigate()` in a render body warns and can double-fire under
  // StrictMode, which here would mean two rows.
  useEffect(() => {
    if (intent?.kind !== 'task') return;
    // Close FIRST. The intent is the thing that would re-trigger this effect,
    // and clearing it before navigating leaves no window where a re-render sees
    // a live task intent.
    close();
    void navigate(authorLink(intent.projectId, intent.isMilestone ? 'milestone' : 'task'));
  }, [intent, close, navigate]);

  if (!intent) return null;

  // Handled by the effect above — render nothing rather than a modal.
  if (intent.kind === 'task') return null;

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
