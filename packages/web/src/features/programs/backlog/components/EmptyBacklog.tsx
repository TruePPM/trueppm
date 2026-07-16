/**
 * Full-page empty state when the program has no backlog items at all (distinct
 * from <NoResults>, which is the filtered-to-zero case). Replaces the toolbar,
 * list, and right pane entirely. Built on the shared <EmptyState> anatomy
 * (web-rule 177 — `role="status"`, decorative icon, warm copy). (The "Import
 * CSV" CTA is hidden until CSV import ships — #1045/#746; a visible "coming
 * soon" dead-end damages first-impression trust on a new surface.)
 */

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ListIcon, PlusIcon } from '@/components/Icons';

interface EmptyBacklogProps {
  canEdit: boolean;
  onCreate: () => void;
}

export function EmptyBacklog({ canEdit, onCreate }: EmptyBacklogProps) {
  return (
    <EmptyState
      icon={ListIcon}
      title="The program backlog is empty"
      description="Capture cross-project ideas, themes, and unscoped work here. They live at the program level until they’re pulled into a specific project’s backlog."
      action={
        canEdit ? (
          <Button variant="primary" onClick={onCreate}>
            <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
            Create your first item
          </Button>
        ) : undefined
      }
    />
  );
}
