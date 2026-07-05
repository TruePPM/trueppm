import { useState, type FormEvent } from 'react';
import { Button } from '@/components/Button';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';
import type { ProjectMembership } from '@/api/types';
import {
  useMentionGroups,
  useMentionGroupMutations,
} from '../hooks/useMentionGroups';
import { MentionGroupRow, type ProjectMemberOption } from './MentionGroupRow';

interface MentionGroupsSectionProps {
  projectId: string;
  /** Current user's role ordinal for this project (null while loading). */
  myRole: number | null;
  /** Project members, used to populate the add-member picker. */
  members: ProjectMembership[];
}

/**
 * Project Settings → Members: user-defined @mention group management (#515).
 *
 * RBAC mirrors the server (ADR-0211 §3): Admin+ curates the set of groups
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
  const createError = create.error as
    | { response?: { data?: { name?: string[] } } }
    | null;
  const nameErrorMessage = createError?.response?.data?.name?.[0];

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

      {isLoading && (
        <div className="space-y-px">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="h-12 rounded bg-neutral-surface-raised motion-safe:animate-pulse"
            />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-semantic-critical py-2">
          Failed to load mention groups — please refresh.
        </p>
      )}

      {!isLoading && !isError && groups.length === 0 && (
        <p className="text-sm text-neutral-text-disabled py-2">
          No mention groups yet.
          {canManageGroup && ' Create one below.'}
        </p>
      )}

      {!isLoading && !isError && groups.length > 0 && (
        <ul
          aria-label="Mention groups"
          className="rounded border border-neutral-border divide-y divide-neutral-border bg-neutral-surface"
        >
          {groups.map((g) => (
            <MentionGroupRow
              key={g.id}
              group={g}
              canManageGroup={canManageGroup}
              canManageMembers={canManageMembers}
              memberOptions={memberOptions}
              onRename={(id, name) => update.mutate({ id, name })}
              onDelete={(id) => remove.mutate(id)}
              onToggleEmailDefault={(id, value) =>
                update.mutate({ id, email_default_on: value })
              }
              onAddMember={(id, user) => addMember.mutate({ id, user })}
              onRemoveMember={(id, user) => removeMember.mutate({ id, user })}
              onToggleMute={(id, muted) => mute.mutate({ id, muted })}
              isBusy={isBusy}
            />
          ))}
        </ul>
      )}

      {/* Create form — Admin+ */}
      {canManageGroup && (
        <form onSubmit={handleCreate} className="mt-4 space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <label htmlFor="new-group-name" className="sr-only">
                Group name
              </label>
              <input
                id="new-group-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="subcontractors"
                aria-invalid={nameErrorMessage ? true : undefined}
                className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="new-group-description" className="sr-only">
                Description (optional)
              </label>
              <input
                id="new-group-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)"
                className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
            </div>
            <Button type="submit" disabled={!newName.trim() || create.isPending}>
              New group
            </Button>
          </div>
          {nameErrorMessage && (
            <p role="alert" className="text-xs text-semantic-critical">
              {nameErrorMessage}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
