import { useState } from 'react';
import { useSprintScopeChanges } from '@/hooks/useSprints';
import { ScopeChangeDrawer } from './ScopeChangeDrawer';

interface Props {
  /** The ACTIVE sprint whose mid-sprint additions to surface. */
  sprintId: string;
}

/**
 * Board SprintPanel header badge (#543): "⚠ N added mid-sprint", shown only when
 * tasks were injected after activation. Both Alex (SM) and Jordan (PO) flagged a
 * silent mid-sprint slip as a Hard-NO; this is the visible, team-readable signal
 * that opens the scope-change audit drawer (who/when/what/points). Self-contained
 * so the SprintPanel only mounts one element.
 */
export function SprintScopeBadge({ sprintId }: Props) {
  const { data } = useSprintScopeChanges(sprintId);
  const [open, setOpen] = useState(false);
  const count = data?.summary.added_mid_sprint_count ?? 0;
  if (count === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="mt-0.5 inline-flex items-center gap-1 self-start rounded-full border border-semantic-at-risk/40
          bg-semantic-at-risk-bg px-2 py-0.5 text-xs font-medium text-semantic-at-risk
          hover:border-semantic-at-risk focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <span aria-hidden="true">⚠</span>
        <span className="tppm-mono">{count}</span> task{count === 1 ? '' : 's'} added mid-sprint
      </button>
      {open && <ScopeChangeDrawer sprintId={sprintId} onClose={() => setOpen(false)} />}
    </>
  );
}
