/**
 * Status facet — the closed `TaskStatus` enum in fixed pipeline order.
 * ADR-0624, issue #2387.
 *
 * Two rules this facet enforces that the other two don't need:
 *   - every enum value is always listed, including zero-count ones (a missing
 *     option would read as a bug, and picking a zero is a legitimate way to
 *     confirm nothing is in that state);
 *   - the order is never re-sorted by count — it is the pipeline, and the
 *     sequence itself is information.
 *
 * The colored dot is redundant with the status name beside it, never the sole
 * carrier of which status a row is (rule 6 / WCAG 1.4.1).
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { MultiSelectFacet, type FacetOptionGroup } from './MultiSelectFacet';
import { STATUS_FACET_ORDER, statusDisplayName } from './statusFilter';
import type { TaskStatus } from '@/types';

/** Dot tint per status, mirroring the `StatusPill` border/text tones. */
const STATUS_DOT: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-text-disabled',
  NOT_STARTED: 'bg-neutral-text-secondary',
  IN_PROGRESS: 'bg-brand-primary',
  REVIEW: 'bg-brand-accent',
  ON_HOLD: 'bg-semantic-warning',
  COMPLETE: 'bg-semantic-on-track',
};

interface StatusFacetProps {
  counts: Record<TaskStatus, number>;
  selected: TaskStatus[];
  onChange: (next: TaskStatus[]) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presentation?: 'popover' | 'sheet';
}

export function StatusFacet({
  counts,
  selected,
  onChange,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  presentation,
}: StatusFacetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const groups: FacetOptionGroup[] = [
    {
      key: 'statuses',
      options: STATUS_FACET_ORDER.map((status) => ({
        id: status,
        name: statusDisplayName(status),
        count: counts[status] ?? 0,
        leading: (
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
          />
        ),
      })),
    },
  ];

  const selectedNames = selected.map(statusDisplayName);
  let triggerLabel: string;
  if (selectedNames.length === 0) triggerLabel = 'Status: any';
  else if (selectedNames.length === 1) triggerLabel = `Status: ${selectedNames[0]}`;
  else triggerLabel = `Status: ${selectedNames[0]} +${selectedNames.length - 1}`;

  return (
    <MultiSelectFacet
      triggerLabel={triggerLabel}
      menuLabel="Filter by status"
      groups={groups}
      selected={selected}
      onChange={(next) => onChange(next as TaskStatus[])}
      clearLabel="Clear statuses"
      footerHint="Fixed pipeline order · zero counts kept"
      triggerRef={triggerRef}
      open={open}
      onOpenChange={setOpen}
      presentation={presentation}
    />
  );
}
