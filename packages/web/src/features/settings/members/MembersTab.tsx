import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useMembers } from '../hooks/useMembers';
import { useUpdateMemberRole } from '../hooks/useUpdateMemberRole';
import { useRemoveMember } from '../hooks/useRemoveMember';
import { MemberRow } from './MemberRow';
import { InviteForm } from './InviteForm';
import { MentionGroupsSection } from './MentionGroupsSection';
import { ROLE_OWNER } from '@/lib/roles';

export function MembersTab() {
  const projectId = useProjectId();
  const { user } = useCurrentUser();
  const { role: myRole } = useCurrentUserRole(projectId);
  const { data: members = [], isLoading, isError } = useMembers(projectId);
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateMemberRole(projectId ?? '');
  const { mutate: removeMember, isPending: isRemoving } = useRemoveMember(projectId ?? '');

  if (!projectId) return null;

  const isOwnerRole = myRole === ROLE_OWNER;
  const ownerCount = members.filter((m) => m.role === ROLE_OWNER).length;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      {/* Members list */}
      <section aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-base font-semibold text-neutral-text-primary mb-4">
          Members
          {members.length > 0 && (
            <span className="ml-2 tppm-mono text-sm font-normal text-neutral-text-secondary">
              {members.length}
            </span>
          )}
        </h2>

        {isLoading && (
          <div className="space-y-px">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-14 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <p role="alert" className="text-sm text-semantic-critical py-4">
            Failed to load members — please refresh.
          </p>
        )}

        {!isLoading && !isError && members.length === 0 && (
          <p className="text-sm text-neutral-text-disabled py-4">
            No members yet. Add someone below.
          </p>
        )}

        {!isLoading && !isError && members.length > 0 && (
          <ul
            aria-label="Project members"
            className="rounded border border-neutral-border divide-y divide-neutral-border bg-neutral-surface"
          >
            {members.map((m) => (
              <MemberRow
                key={m.id}
                membership={m}
                isSelf={user?.id === m.user}
                isOwnerRole={isOwnerRole}
                isSoleOwner={m.role === ROLE_OWNER && ownerCount === 1}
                onChangeRole={(membershipId, role) => updateRole({ membershipId, role })}
                onRemove={(membershipId) => removeMember(membershipId)}
                isUpdatingRole={isUpdatingRole}
                isRemoving={isRemoving}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Invite form — OWNER only */}
      {isOwnerRole && (
        <section aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-base font-semibold text-neutral-text-primary mb-4">
            Add member
          </h2>
          <InviteForm projectId={projectId} />
        </section>
      )}

      {/* User-defined @mention groups (issue 515) */}
      <MentionGroupsSection projectId={projectId} myRole={myRole} members={members} />
    </div>
  );
}
