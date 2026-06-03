/**
 * One roster row: identity, team role, and the two facet switches (ADR-0078 §H).
 *
 * Presentational — the page owns the data, the reassign-confirm flow, and the
 * mutation. `canEdit` flips the whole row between interactive and read-only.
 */

import { FacetToggle } from './FacetToggle';
import type { TeamFacet, TeamMember, TeamRole } from './useTeam';

interface TeamMemberRowProps {
  member: TeamMember;
  canEdit: boolean;
  pendingFacet: TeamFacet | null;
  onChangeRole: (membershipId: string, role: TeamRole) => void;
  onToggleFacet: (member: TeamMember, facet: TeamFacet, next: boolean) => void;
}

export function TeamMemberRow({
  member,
  canEdit,
  pendingFacet,
  onChangeRole,
  onToggleFacet,
}: TeamMemberRowProps) {
  const initials = member.user_detail.username.slice(0, 2).toUpperCase();

  return (
    <li className="flex flex-col gap-3 px-4 py-3 hover:bg-neutral-surface-raised transition-colors sm:flex-row sm:items-center">
      {/* Identity */}
      <div className="flex items-center gap-3 sm:flex-1 sm:min-w-0">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-surface-sunken text-xs font-semibold text-neutral-text-secondary"
        >
          {initials}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-neutral-text-primary">
            {member.user_detail.username}
          </span>
          <span className="block truncate text-[12px] text-neutral-text-secondary">
            {member.user_detail.email}
          </span>
        </span>
      </div>

      {/* Role */}
      <div className="flex items-center gap-2 sm:w-32">
        <span className="text-[12px] text-neutral-text-secondary sm:hidden">Role</span>
        {canEdit ? (
          <select
            aria-label={`Team role for ${member.user_detail.username}`}
            value={member.role}
            onChange={(e) => onChangeRole(member.id, e.target.value as TeamRole)}
            className="h-7 rounded border border-neutral-border bg-neutral-surface text-[12px] px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        ) : (
          <span className="text-[12px] text-neutral-text-primary">{member.role_label}</span>
        )}
      </div>

      {/* Facets */}
      <div className="flex items-center gap-2 sm:w-36">
        <span className="text-[12px] text-neutral-text-secondary sm:hidden">Scrum Master</span>
        <FacetToggle
          on={member.is_scrum_master}
          ariaLabel={`Scrum Master: ${member.user_detail.username}`}
          disabled={!canEdit}
          pending={pendingFacet === 'is_scrum_master'}
          onToggle={() => onToggleFacet(member, 'is_scrum_master', !member.is_scrum_master)}
        />
      </div>
      <div className="flex items-center gap-2 sm:w-36">
        <span className="text-[12px] text-neutral-text-secondary sm:hidden">Product Owner</span>
        <FacetToggle
          on={member.is_product_owner}
          ariaLabel={`Product Owner: ${member.user_detail.username}`}
          disabled={!canEdit}
          pending={pendingFacet === 'is_product_owner'}
          onToggle={() => onToggleFacet(member, 'is_product_owner', !member.is_product_owner)}
        />
      </div>
    </li>
  );
}
