import { useState, type FormEvent } from 'react';
import { extractFieldErrors } from '@/lib/apiError';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';
import {
  useProgramMentionGroups,
  useProgramMentionGroupMutations,
} from '../hooks/useProgramMentionGroups';
import type { ProjectMemberOption } from './MentionGroupRow';
import { MentionGroupList } from './MentionGroupList';
import { MentionGroupCreateForm } from './MentionGroupCreateForm';

interface ProgramMentionGroupsSectionProps {
  programId: string;
  /** Current user's role ordinal for this program (null while loading). */
  myRole: number | null;
  /** Program members, used to populate the add-member picker. */
  members: ProgramMembership[];
  /** Whether the program is closed (#2549). Every write on this viewset — create,
   *  rename, delete, add-member, remove-member — is gated server-side by
   *  IsProgramNotClosed (`destroy` is separately re-asserted in the view body
   *  even though it sits in the permission class's bypass list, see
   *  ProgramUserDefinedMentionGroupViewSet.destroy), so all of them fold this in.
   *  Mute/unmute are exempt: they are a member's own subscription, not gated by
   *  program-closed. */
  isClosed?: boolean;
}

/**
 * Program Settings → Access: user-defined @mention group management (ADR-0248,
 * issue 516). The program-scoped parallel of {@link MentionGroupsSection}.
 *
 * RBAC mirrors the server (ADR-0248 §3): the Program Owner curates the set of
 * groups (create/rename/delete/email-default); Program Admin+ edits membership;
 * any member may mute a group for themselves. The section is hidden entirely
 * below Admin when no group exists (nothing to manage or mute); once a group
 * exists it renders read-with-mute for any member.
 */
export function ProgramMentionGroupsSection({
  programId,
  myRole,
  members,
  isClosed = false,
}: ProgramMentionGroupsSectionProps) {
  const { data: groups = [], isLoading, isError } = useProgramMentionGroups(programId);
  const { create, update, remove, addMember, removeMember, mute } =
    useProgramMentionGroupMutations(programId);

  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const canManageGroup = myRole != null && myRole >= ROLE_OWNER && !isClosed;
  const canManageMembers = myRole != null && myRole >= ROLE_ADMIN && !isClosed;

  // Members are selectable across all projects in the program (ADR-0248 §2); the
  // program-membership roster is that union, so dedupe by user id defensively.
  const seen = new Set<string>();
  const memberOptions: ProjectMemberOption[] = [];
  for (const m of members) {
    // String: a <select> option value, compared with mention-group member ids
    // (also strings). `m.user` is the integer PK (#2633).
    const userId = String(m.user);
    if (seen.has(userId)) continue;
    seen.add(userId);
    memberOptions.push({ userId, username: m.user_detail.username });
  }

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

  // Below Admin with no groups to mute: nothing to show.
  if (!canManageMembers && groups.length === 0) return null;

  return (
    <section aria-labelledby="program-mention-groups-heading" className="mt-8">
      <h2
        id="program-mention-groups-heading"
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
        Custom <span className="tppm-mono">@groups</span> for notifying a curated set of members
        across the program&rsquo;s projects in comments.
      </p>

      <MentionGroupList
        isLoading={isLoading}
        isError={isError}
        groups={groups}
        listLabel="Program mention groups"
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

      {/* Create form — Owner only */}
      {!canManageGroup && isClosed && myRole != null && myRole >= ROLE_OWNER && (
        <p className="mt-2 text-xs text-neutral-text-secondary italic">
          This program is closed — reopen it to manage mention groups.
        </p>
      )}
      {canManageGroup && (
        <MentionGroupCreateForm
          idPrefix="new-program-group"
          namePlaceholder="tech-leads"
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
