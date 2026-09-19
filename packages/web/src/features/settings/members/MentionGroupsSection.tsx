import { useState, type FormEvent } from 'react';
import { extractFieldErrors } from '@/lib/apiError';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import type { ProjectMembership } from '@/api/types';
import {
  useMentionGroups,
  useMentionGroupMutations,
} from '../hooks/useMentionGroups';
import type { ProjectMemberOption } from './MentionGroupRow';
import { MentionGroupList } from './MentionGroupList';
import { MentionGroupCreateForm } from './MentionGroupCreateForm';

interface MentionGroupsSectionProps {
  projectId: string;
  /** Current user's role ordinal for this project (null while loading). */
  myRole: number | null;
  /** Project members, used to populate the add-member picker. */
  members: ProjectMembership[];
}

/**
 * Project Settings → Members: user-defined @mention group management (issue 515).
 *
 * RBAC mirrors the server (ADR-0212 §3): Admin+ curates the set of groups
 * (create/rename/delete/email-default); Scheduler+ edits membership; any member
 * may mute a group for themselves. The section is hidden entirely below
 * Scheduler since there is nothing a Member/Viewer can manage here except mute,
 * which requires an existing group to act on — so it renders read-with-mute for
 * any member when at least one group exists.
 */
export function MentionGroupsSection({
  projectId,
  myRole,
  members,
}: MentionGroupsSectionProps) {
  const { data: groups = [], isLoading, isError } = useMentionGroups(projectId);
  const { create, update, remove, addMember, removeMember, mute } =
    useMentionGroupMutations(projectId);

  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const canManageGroup = myRole != null && myRole >= ROLE_ADMIN;
  const canManageMembers = myRole != null && myRole >= ROLE_SCHEDULER;

  const memberOptions: ProjectMemberOption[] = members.map((m) => ({
    userId: m.user,
    username: m.user_detail.username,
  }));

  const isBusy =
    create.isPending ||
    update.isPending ||
    remove.isPending ||
    addMember.isPending ||
    removeMember.isPending ||
    mute.isPending;

  // Surface the server's field error (reserved name / duplicate) inline.
  const nameErrorMessage = extractFieldErrors(create.error).name;

  function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newName.trim()) return;
    create.mutate(
      { name: newName.trim(), description: newDescription.trim() || undefined },
      {
        onSuccess: () => {
          setNewName('');
          setNewDescription('');
        },
      },
    );
  }

  // Below Scheduler with no groups to mute: nothing to show.
  if (!canManageMembers && groups.length === 0) return null;

  return (
    <section aria-labelledby="mention-groups-heading">
      <h2
        id="mention-groups-heading"
        className="text-base font-semibold text-neutral-text-primary mb-1"
      >
        Mention groups
        {groups.length > 0 && (
          <span className="ml-2 tppm-mono text-sm font-normal text-neutral-text-secondary">
            {groups.length}
          </span>
        )}
      </h2>
      <p className="mb-4 text-xs text-neutral-text-secondary">
        Custom <span className="tppm-mono">@groups</span> for notifying a curated
        set of project members in comments.
      </p>

      <MentionGroupList
        isLoading={isLoading}
        isError={isError}
        groups={groups}
        listLabel="Mention groups"
        canManageGroup={canManageGroup}
        canManageMembers={canManageMembers}
        memberOptions={memberOptions}
        isBusy={isBusy}
        onRename={(id, name) => update.mutate({ id, name })}
        onDelete={(id) => remove.mutate(id)}
        onToggleEmailDefault={(id, value) => update.mutate({ id, email_default_on: value })}
        onAddMember={(id, user) => addMember.mutate({ id, user })}
        onRemoveMember={(id, user) => removeMember.mutate({ id, user })}
        onToggleMute={(id, muted) => mute.mutate({ id, muted })}
      />

      {/* Create form — Admin+ */}
      {canManageGroup && (
        <MentionGroupCreateForm
          idPrefix="new-group"
          namePlaceholder="subcontractors"
          newName={newName}
          newDescription={newDescription}
          onNameChange={setNewName}
          onDescriptionChange={setNewDescription}
          onSubmit={handleCreate}
          submitDisabled={!newName.trim() || create.isPending}
          nameErrorMessage={nameErrorMessage}
        />
      )}
    </section>
  );
}
