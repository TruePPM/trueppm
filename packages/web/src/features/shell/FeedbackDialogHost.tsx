/**
 * Single mount point for the feedback dialog (#2392).
 *
 * Lives in `AppShell` rather than in `UserMenu` because the ⌘K palette opens the
 * same dialog, and because closing the menu that launched it would otherwise
 * unmount it mid-read. Renders nothing until opened.
 */
import { useFeedbackStore } from '@/stores/feedbackStore';
import { FeedbackDialog } from './FeedbackDialog';

export function FeedbackDialogHost() {
  const open = useFeedbackStore((s) => s.open);
  const setOpen = useFeedbackStore((s) => s.setOpen);
  if (!open) return null;
  return <FeedbackDialog onClose={() => setOpen(false)} />;
}
