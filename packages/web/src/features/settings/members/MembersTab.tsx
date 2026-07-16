import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useMembers } from '../hooks/useMembers';
import { useUpdateMemberRole } from '../hooks/useUpdateMemberRole';
import { useRemoveMember } from '../hooks/useRemoveMember';
import { MemberRow } from './MemberRow';
import { InviteForm } from './InviteForm';
import { MentionGroupsSection } from './MentionGroupsSection';
import { DefaultMemberRoleSetting } from './DefaultMemberRoleSetting';
import { ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';

export function MembersTab() {
  const projectId = useProjectId();
  const { user } = useCurrentUser();
  const { role: myRole } = useCurrentUserRole(projectId);
  const { data: members = [], isLoading, isError } = useMembers(projectId);
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateMemberRole(projectId ?? '');
  const { mutate: removeMember, isPending: isRemoving } = useRemoveMember(projectId ?? '');

  if (!projectId) return null;

  const isOwnerRole = myRole === ROLE_OWNER;
  // default_member_role PATCH is Admin+-gated server-side (settings-field allowlist);
  // gate the control the same way so it never flashes for roles the server would 403.
  const canEditDefaultRole = myRole != null && myRole >= ROLE_ADMIN;
  const ownerCount = members.filter((m) => m.role === ROLE_OWNER).length;

  return (
    <div className="px-6 pb-8 max-w-[920px] space-y-8">
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

      {/* Default role for members added without one (ADR-0363, #157) — Admin+ */}
      {canEditDefaultRole && <DefaultMemberRoleSetting projectId={projectId} />}

      {/* User-defined @mention groups (issue 515) */}
      <MentionGroupsSection projectId={projectId} myRole={myRole} members={members} />
    </div>
  );
}
