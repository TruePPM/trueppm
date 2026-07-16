/**
 * Default right-pane state when nothing is selected. Invites action rather
 * than showing a bare "Nothing selected" — the primary CTA opens the create
 * form. Hidden for viewers without edit rights? No: the CTA is gated, but the
 * invitation copy still orients read-only users.
 */

import { Button } from '@/components/Button';
import { ListIcon, PlusIcon } from '@/components/Icons';

interface DetailEmptyProps {
  canEdit: boolean;
  onCreate: () => void;
}

export function DetailEmpty({ canEdit, onCreate }: DetailEmptyProps) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center bg-neutral-surface-sunken px-6 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-border bg-neutral-surface text-neutral-text-secondary">
        <ListIcon aria-hidden="true" className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-sm font-semibold text-neutral-text-primary">Select an item</h2>
      <p className="mt-2 max-w-[280px] text-xs leading-relaxed text-neutral-text-secondary">
        Pick an item from the list to view its details, or create a new program backlog item.
      </p>
      {canEdit && (
        <Button variant="primary" className="mt-4" onClick={onCreate}>
          <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
          New item
        </Button>
      )}
    </div>
  );
}
