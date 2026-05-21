import { useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProgram } from '@/hooks/useProgram';
import { useProgramMembers } from '@/features/programs/hooks/useProgramMembers';
import {
  useUpdateProgramMemberRole,
  useRemoveProgramMember,
} from '@/features/programs/hooks/useProgramMemberMutations';
import { ProgramInviteForm } from '@/features/programs/members/ProgramInviteForm';
import { RolePicker } from '@/features/settings/members/RolePicker';
import { ROLE_OWNER } from '@/lib/roles';
import type { ProgramMembership } from '@/api/types';

const GRID = '1.8fr 1.2fr 130px 170px 88px';

function RoleBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-neutral-surface-sunken text-neutral-text-secondary">
      {label}
    </span>
  );
}

function initialsFor(username: string): string {
  const parts = username.split(/[._\s-]+/).filter(Boolean);
  if (parts.length === 0) return username.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

interface RowProps {
  membership: ProgramMembership;
  isSelf: boolean;
  canManage: boolean;
  isSoleOwner: boolean;
  onChangeRole: (membershipId: string, role: number) => void;
  onRemove: (membershipId: string) => void;
  isUpdatingRole: boolean;
  isRemoving: boolean;
}

function MemberRow({
  membership,
  isSelf,
  canManage,
  isSoleOwner,
  onChangeRole,
  onRemove,
  isUpdatingRole,
  isRemoving,
}: RowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { user_detail, role, role_label } = membership;
  const isOwnerMember = role === ROLE_OWNER;
  const canEditRole = canManage && !isOwnerMember;
  const canRemove = canManage && !(isSelf && isSoleOwner);

  return (
    <div
      className="grid items-center px-4 py-2.5 text-[13px] border-b border-neutral-border/55 last:border-b-0"
      style={{ gridTemplateColumns: GRID }}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <span
          aria-hidden="true"
          className="w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-bold text-white shrink-0 bg-brand-primary"
        >
          {initialsFor(user_detail.username)}
        </span>
        <span className="font-medium text-neutral-text-primary truncate">
          {user_detail.username}
          {isSelf && (
            <span className="ml-1.5 text-xs font-normal text-neutral-text-secondary">
              (you)
            </span>
          )}
        </span>
      </span>

      <span className="text-xs text-neutral-text-secondary truncate">{user_detail.email}</span>

      <RoleBadge label={role_label} />

      <div>
        {canEditRole ? (
          <RolePicker
            value={role}
            onChange={(newRole) => onChangeRole(membership.id, newRole)}
            disabled={isUpdatingRole}
            id={`program-access-role-${membership.id}`}
          />
        ) : (
          <span
            className="text-xs text-neutral-text-secondary italic"
            title={
              isOwnerMember
                ? 'Owner role cannot be changed from here'
                : 'Owners can change member roles'
            }
          >
            —
          </span>
        )}
      </div>

      <div className="flex justify-end">
        {canRemove && !confirmRemove && (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={isRemoving}
            aria-label={isSelf ? 'Leave program' : `Remove ${user_detail.username}`}
            className="min-h-[28px] px-2 rounded text-xs font-medium text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:opacity-50"
          >
            {isSelf ? 'Leave' : 'Remove'}
          </button>
        )}
        {confirmRemove && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onRemove(membership.id);
                setConfirmRemove(false);
              }}
              disabled={isRemoving}
              className="h-7 px-2 rounded border border-semantic-critical text-xs font-semibold text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:opacity-50"
            >
              {isSelf ? 'Leave' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              className="h-7 px-2 rounded border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
          </span>
        )}
        {isSelf && isSoleOwner && (
          <span
            className="text-xs text-neutral-text-secondary"
            title="You're the only Owner — assign another before leaving"
          >
            Sole owner
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Program > Access settings page (#525).
 *
 * Reads from ``useProgramMembers`` and mutates via the three program-member
 * hooks. The table layout is intentionally denser than the program-shell
 * Members tab — settings is a manage-everything surface for admins; the shell
 * tab is the per-program identity card.
 *
 * Permission gating mirrors the shell tab: only the Owner sees the inline
 * RolePicker and the Add-member panel. Lower roles see read-only role badges
 * and no remove buttons. The API enforces the same rule server-side; this is
 * UX, not security.
 */
export function ProgramAccessPage() {
  const { programId } = useParams<{ programId: string }>();
  const { user } = useCurrentUser();
  const { data: program } = useProgram(programId);
  const { data: members = [], isLoading, isError } = useProgramMembers(programId);
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateProgramMemberRole(
    programId ?? '',
  );
  const { mutate: removeMember, isPending: isRemoving } = useRemoveProgramMember(
    programId ?? '',
  );
  const [showInvite, setShowInvite] = useState(false);

  if (!programId) return null;

  const canManage = program?.my_role === ROLE_OWNER;
  const ownerCount = members.filter((m) => m.role === ROLE_OWNER).length;

  return (
    <div>
      <SettingsPageTitle
        title="Access"
        count={members.length > 0 ? `${members.length} members` : undefined}
        subtitle="Who can see and manage this program. Program roles are separate from project roles."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => setShowInvite((v) => !v)}
              aria-expanded={showInvite}
              className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {showInvite ? 'Cancel' : '+ Add member'}
            </button>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {canManage && showInvite && (
          <section
            aria-labelledby="program-access-invite-heading"
            className="mb-6 rounded-lg border border-neutral-border bg-neutral-surface-raised p-4"
          >
            <h2
              id="program-access-invite-heading"
              className="mb-3 text-sm font-semibold text-neutral-text-primary"
            >
              Add a member
            </h2>
            <ProgramInviteForm programId={programId} />
          </section>
        )}

        <div
          className="grid items-center px-4 py-2 bg-neutral-surface-sunken border border-neutral-border rounded-t-lg text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mt-4"
          style={{ gridTemplateColumns: GRID }}
        >
          <span>Member</span>
          <span>Email</span>
          <span>Role</span>
          <span>Change role</span>
          <span />
        </div>

        <div className="bg-neutral-surface-raised border-x border-b border-neutral-border rounded-b-lg overflow-hidden">
          {isLoading && (
            <div
              aria-label="Loading members"
              role="status"
              className="px-4 py-6 text-xs text-neutral-text-secondary"
            >
              Loading…
            </div>
          )}
          {isError && (
            <div role="alert" className="px-4 py-6 text-xs text-semantic-critical">
              Failed to load members — please refresh.
            </div>
          )}
          {!isLoading && !isError && members.length === 0 && (
            <div role="status" className="px-4 py-6 text-xs text-neutral-text-secondary">
              No members yet.
            </div>
          )}
          {!isLoading &&
            !isError &&
            members.map((m) => (
              <MemberRow
                key={m.id}
                membership={m}
                isSelf={user?.id === m.user}
                canManage={canManage}
                isSoleOwner={m.role === ROLE_OWNER && ownerCount === 1}
                onChangeRole={(membershipId, role) => updateRole({ membershipId, role })}
                onRemove={(membershipId) => removeMember(membershipId)}
                isUpdatingRole={isUpdatingRole}
                isRemoving={isRemoving}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
