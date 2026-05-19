import { useState } from 'react';
import type { ProgramMembership } from '@/api/types';
import { ROLE_OWNER } from '@/lib/roles';
import { RolePicker } from '@/features/settings/members/RolePicker';

interface Props {
  membership: ProgramMembership;
  isSelf: boolean;
  isOwnerRole: boolean;
  /** True when this member is the only OWNER — disables leave/remove to prevent lockout. */
  isSoleOwner: boolean;
  onChangeRole: (membershipId: string, role: number) => void;
  onRemove: (membershipId: string) => void;
  isUpdatingRole: boolean;
  isRemoving: boolean;
}

/**
 * Single program-member row. Mirrors :class:`MemberRow` for projects.
 *
 * Role mutations are gated by `isOwnerRole` (the caller's role) and the
 * sole-owner guard prevents the only OWNER from leaving — both rules match
 * the project version, since the API enforces the same invariants on both
 * membership tables.
 */
export function ProgramMemberRow({
  membership,
  isSelf,
  isOwnerRole,
  isSoleOwner,
  onChangeRole,
  onRemove,
  isUpdatingRole,
  isRemoving,
}: Props) {
  const { user_detail, role, role_label } = membership;
  const initials = user_detail.username.slice(0, 2).toUpperCase();
  const isOwnerMember = role === ROLE_OWNER;

  const canEditRole = isOwnerRole && !isOwnerMember;
  const canRemove = isOwnerRole && !(isSelf && isSoleOwner);

  const [confirmLeave, setConfirmLeave] = useState(false);

  function handleRemoveClick() {
    if (isSelf) {
      setConfirmLeave(true);
    } else {
      onRemove(membership.id);
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-surface-raised transition-colors">
      <div
        aria-hidden="true"
        className="w-8 h-8 shrink-0 rounded-full bg-brand-primary/10 text-brand-primary
          text-xs font-semibold flex items-center justify-center"
      >
        {initials}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-text-primary truncate">
          {user_detail.username}
          {isSelf && (
            <span className="ml-1.5 text-xs font-normal text-neutral-text-secondary">(you)</span>
          )}
        </p>
        <p className="text-xs text-neutral-text-secondary truncate">{user_detail.email}</p>
      </div>

      <div className="shrink-0">
        {canEditRole ? (
          <RolePicker
            value={role}
            onChange={(newRole) => onChangeRole(membership.id, newRole)}
            disabled={isUpdatingRole}
            id={`program-role-${membership.id}`}
          />
        ) : (
          <span className="inline-flex items-center rounded-full border border-neutral-border bg-neutral-surface-raised px-2.5 py-0.5 text-xs font-medium text-neutral-text-secondary">
            {role_label}
          </span>
        )}
      </div>

      {canRemove && !confirmLeave && (
        <button
          type="button"
          onClick={handleRemoveClick}
          disabled={isRemoving}
          aria-label={isSelf ? 'Leave program' : `Remove ${user_detail.username}`}
          className={[
            'shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center',
            'rounded text-xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            isSelf
              ? 'text-neutral-text-secondary hover:text-neutral-text-primary'
              : 'text-semantic-critical hover:text-semantic-critical/80',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {isSelf ? 'Leave' : 'Remove'}
        </button>
      )}

      {confirmLeave && (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-neutral-text-secondary">Leave program?</span>
          <button
            type="button"
            onClick={() => {
              onRemove(membership.id);
              setConfirmLeave(false);
            }}
            disabled={isRemoving}
            className={[
              'h-7 px-2 rounded border border-semantic-critical text-xs font-medium',
              'text-semantic-critical hover:bg-semantic-critical/5 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
              'disabled:opacity-50',
            ].join(' ')}
          >
            Leave
          </button>
          <button
            type="button"
            onClick={() => setConfirmLeave(false)}
            className={[
              'h-7 px-2 rounded border border-neutral-border text-xs font-medium',
              'text-neutral-text-secondary hover:bg-neutral-surface-raised transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            ].join(' ')}
          >
            Cancel
          </button>
        </div>
      )}

      {isSelf && isSoleOwner && (
        <span
          className="shrink-0 text-xs text-neutral-text-disabled"
          title="You're the only Owner — assign another before leaving"
        >
          Can&apos;t leave
        </span>
      )}
    </li>
  );
}
