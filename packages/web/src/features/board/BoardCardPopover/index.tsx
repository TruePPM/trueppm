import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import type { Task } from '@/types';
import { useSprints } from '@/hooks/useSprints';
import { CardPopoverShell } from './CardPopoverShell';
import { CardPopoverBodyA } from './CardPopoverBodyA';
import { CardPopoverFooter } from './CardPopoverFooter';

export interface BoardCardPopoverProps {
  task: Task;
  /** Project context — used to resolve the sprint name for the chip. */
  projectId: string;
  /** Card element the popover is anchored to (desktop). Ignored on mobile. */
  anchor: HTMLElement | null;
  /** True when the calling viewport is below the `md` breakpoint. */
  isMobile: boolean;
  /** Open the existing TaskDetailDrawer for this task. */
  onOpenDetail: () => void;
  /** Open the drawer in edit mode (one-line swap target for #305 modal). */
  onEdit: () => void;
  /** Close the popover (Esc, outside click, route change, or after a footer action). */
  onClose: () => void;
}

/**
 * Card information popover (issue #304, ADR-0051). Variation A is the
 * production body — rows, footer with Open detail / Edit, no Move picker
 * (Marcus's audit-trail concern is sidestepped by deferring B's Move).
 *
 * Body is swappable via a single import — variation B was deliberately not
 * implemented; YAGNI. When B becomes useful, add `CardPopoverBodyB.tsx`
 * alongside this file and swap the import here.
 */
export function BoardCardPopover({
  task,
  projectId,
  anchor,
  isMobile,
  onOpenDetail,
  onEdit,
  onClose,
}: BoardCardPopoverProps) {
  const openDetailRef = useRef<HTMLButtonElement>(null);
  const titleId = `card-popover-title-${task.id}`;

  // Resolve sprint name when the task is sprint-committed. Loading state
  // renders a placeholder chip ("Sprint: …") to avoid layout shift.
  const { sprints } = useSprints(task.sprintId ? projectId : null);
  const sprintName = task.sprintId
    ? (sprints.find((s) => s.id === task.sprintId)?.name ?? '…')
    : null;

  // Move focus to the primary CTA on open so keyboard users land on the
  // most likely next action.
  useEffect(() => {
    const id = window.setTimeout(() => openDetailRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // Close on route change — guards against stale popover when the user
  // navigates away (e.g. via a deep link in another tab).
  const { pathname } = useLocation();
  const openPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname !== openPathRef.current) {
      onClose();
    }
  }, [pathname, onClose]);

  return (
    <CardPopoverShell
      anchor={anchor}
      isMobile={isMobile}
      titleId={titleId}
      onClose={onClose}
    >
      <CardPopoverBodyA task={task} sprintName={sprintName} />
      <CardPopoverFooter
        onOpenDetail={onOpenDetail}
        onEdit={onEdit}
        openDetailRef={openDetailRef}
      />
    </CardPopoverShell>
  );
}
