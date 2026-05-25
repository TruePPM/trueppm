/**
 * Collapsible header for the "Pulled" group at the bottom of the list. Its
 * open/closed state is URL-persisted (`?pulled=1`) by the caller, so a refresh
 * keeps the section as the user left it. The caret rotates on open.
 */

import { ChevronRightIcon } from '@/components/Icons';
import { FOCUS_RING } from './styles';

interface PulledSectionHeaderProps {
  count: number;
  open: boolean;
  onToggle: () => void;
}

export function PulledSectionHeader({ count, open, onToggle }: PulledSectionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center gap-2 border-t border-neutral-border bg-neutral-surface-raised
        px-3.5 py-2.5 text-left text-xs font-medium text-neutral-text-secondary
        ${open ? 'border-b border-neutral-border' : ''} ${FOCUS_RING}`}
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      />
      <span className="font-semibold text-neutral-text-primary">Pulled</span>
      <span className="tppm-mono tabular-nums text-neutral-text-disabled">{count}</span>
      <span className="text-neutral-text-secondary">· items promoted to a project backlog</span>
    </button>
  );
}
