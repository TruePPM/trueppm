/**
 * Program-backlog page header — eyebrow (program name), title, and the primary
 * Create action. Create requires edit rights; for viewers the button is hidden
 * entirely so the treatment stays consistent with the empty states
 * (EmptyBacklog / DetailEmpty also hide their CTA for viewers — #1996 ux-review
 * §6.1). The "Import CSV" action is hidden until CSV import ships (#1045/#746) —
 * a visible "coming soon" dead-end on a primary action signals incompleteness on
 * a new surface.
 */

import type { Program } from '@/api/types';
import { Button } from '@/components/Button';
import { PlusIcon } from '@/components/Icons';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';

interface BacklogHeaderProps {
  programName: string | undefined;
  /** Program identity fields for the header marker (#963). */
  program: Pick<Program, 'color' | 'code' | 'name'> | undefined;
  canEdit: boolean;
  onCreate: () => void;
}

export function BacklogHeader({ programName, program, canEdit, onCreate }: BacklogHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-border bg-neutral-surface-raised px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {/* One marker for the whole board (#963) — the program identity lives in
            the header, so the rows below stay free of per-row noise. */}
        {program && <ProgramIdentitySquare program={program} size="md" />}
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.06em] text-neutral-text-secondary">
            {programName ?? ' '}
          </div>
          <h1 className="mt-0.5 text-xl font-bold tracking-[-0.01em] text-neutral-text-primary">
            Backlog
          </h1>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {canEdit && (
          <Button variant="primary" onClick={onCreate}>
            <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
            New item
          </Button>
        )}
      </div>
    </header>
  );
}
