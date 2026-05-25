/**
 * Right-pane dispatcher. The URL decides which body renders (decision D8):
 *   ?new=1                     → create form
 *   ?item=BI-003&pull=1        → pull-confirm (only while the item is PROPOSED)
 *   ?item=BI-003               → detail/edit view
 *   (none)                     → empty state
 *
 * All handlers funnel into the controller; navigation away (linked task, add
 * project) uses the router. The pane is always mounted by the layout; only its
 * contents swap.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { BacklogController } from '../hooks/useBacklogController';
import type { MemberProject } from '../types';
import { DetailCreate } from './DetailCreate';
import { DetailEmpty } from './DetailEmpty';
import { DetailPullConfirm } from './DetailPullConfirm';
import { DetailView } from './DetailView';

interface DetailPaneProps {
  controller: BacklogController;
}

export function DetailPane({ controller }: DetailPaneProps) {
  const { url, selectedItem, members, memberProjects, canEdit, canDelete, tagUniverse } =
    controller;
  const navigate = useNavigate();
  const safeMembers = members ?? [];

  const pullActive = url.isPull && selectedItem?.status === 'PROPOSED';

  // Direct-nav to ?pull=1 on a non-PROPOSED item silently drops back to view.
  useEffect(() => {
    if (url.isPull && selectedItem && selectedItem.status !== 'PROPOSED') {
      url.closePull();
    }
  }, [url, selectedItem]);

  if (url.isNew) {
    return (
      <DetailCreate
        members={safeMembers}
        tagSuggestions={tagUniverse}
        onCancel={url.closeDetail}
        onCreate={async (input) => {
          const created = await controller.createItem(input);
          url.selectItem(created.id);
        }}
      />
    );
  }

  if (pullActive && selectedItem) {
    return (
      <DetailPullConfirm
        item={selectedItem}
        projects={memberProjects}
        onCancel={url.closePull}
        onConfirm={(project: MemberProject) => controller.pullItem(selectedItem, project)}
        onAddProject={() => void navigate('../projects')}
      />
    );
  }

  if (selectedItem) {
    return (
      <DetailView
        item={selectedItem}
        members={safeMembers}
        tagSuggestions={tagUniverse}
        canEdit={canEdit}
        canDelete={canDelete}
        onClose={url.closeDetail}
        onSave={(patch) => void controller.updateItem(selectedItem.id, patch)}
        onArchive={() => void controller.archiveItem(selectedItem.id)}
        onRestore={() => void controller.restoreItem(selectedItem.id)}
        onDelete={() => {
          void controller.deleteItem(selectedItem.id);
          url.closeDetail();
        }}
        onSendBack={() =>
          void controller.updateItem(selectedItem.id, { status: 'PROPOSED', pulledTo: undefined })
        }
        onPull={() => url.openPull(selectedItem.id)}
        onOpenLinkedTask={() => {
          if (selectedItem.pulledTo) void navigate(`/projects/${selectedItem.pulledTo.projectId}`);
        }}
      />
    );
  }

  return <DetailEmpty canEdit={canEdit} onCreate={url.openCreate} />;
}
