/**
 * Program-backlog page header — eyebrow (program name), title, and the two
 * primary actions. Create / Import require edit rights; for viewers the
 * buttons render disabled with an explanatory tooltip rather than disappearing
 * (01-page-layout RBAC: "don't hide").
 */

import type { Program } from '@/api/types';
import { PlusIcon } from '@/components/Icons';
import { ProgramIdentitySquare } from '@/features/programs/ProgramIdentitySquare';
import { BTN_PRIMARY, BTN_SECONDARY } from './styles';

interface BacklogHeaderProps {
  programName: string | undefined;
  /** Program identity fields for the header marker (#963). */
  program: Pick<Program, 'color' | 'code' | 'name'> | undefined;
  canEdit: boolean;
  onCreate: () => void;
  onImport: () => void;
}

const NO_EDIT_TOOLTIP = 'Editing the backlog requires Admin role';

export function BacklogHeader({
  programName,
  program,
  canEdit,
  onCreate,
  onImport,
}: BacklogHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-border bg-neutral-surface-raised px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {/* One marker for the whole board (#963) — the program identity lives in
            the header, so the rows below stay free of per-row noise. */}
        {program && <ProgramIdentitySquare program={program} size="md" />}
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-neutral-text-secondary">
            {programName ?? ' '}
          </div>
          <h1 className="mt-0.5 text-xl font-bold tracking-[-0.01em] text-neutral-text-primary">
            Backlog
          </h1>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={onImport}
          disabled={!canEdit}
          title={canEdit ? undefined : NO_EDIT_TOOLTIP}
        >
          Import CSV
        </button>
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={onCreate}
          disabled={!canEdit}
          title={canEdit ? undefined : NO_EDIT_TOOLTIP}
        >
          <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
          New item
        </button>
      </div>
    </header>
  );
}
