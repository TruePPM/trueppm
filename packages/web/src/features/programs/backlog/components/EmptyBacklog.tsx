/**
 * Full-page empty state when the program has no backlog items at all (distinct
 * from <NoResults>, which is the filtered-to-zero case). Replaces the toolbar,
 * list, and right pane entirely. Both CTAs are offered — "Import CSV" matters
 * here because people often arrive with an existing list.
 */

import { ListIcon } from '@/components/Icons';
import { BTN_PRIMARY, BTN_SECONDARY } from './styles';

interface EmptyBacklogProps {
  canEdit: boolean;
  onCreate: () => void;
  onImport: () => void;
}

export function EmptyBacklog({ canEdit, onCreate, onImport }: EmptyBacklogProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary">
        <ListIcon aria-hidden="true" className="h-8 w-8" />
      </div>
      <h2 className="mt-5 text-[17px] font-semibold text-neutral-text-primary">
        The program backlog is empty
      </h2>
      <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-neutral-text-secondary">
        Capture cross-project ideas, themes, and unscoped work here. They live at the program level
        until they&rsquo;re pulled into a specific project&rsquo;s backlog.
      </p>
      {canEdit && (
        <div className="mt-5 flex items-center gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={onCreate}>
            + Create your first item
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={onImport}>
            Import CSV
          </button>
        </div>
      )}
    </div>
  );
}
