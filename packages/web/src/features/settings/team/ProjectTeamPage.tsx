/**
 * Project Settings → Team tab (ADR-0078 §H, #927).
 *
 * Assigns each member a team role plus the two independent facets (Scrum Master,
 * Product Owner). Methodology-gated to agile/hybrid projects by the nav (the
 * single-team-invisibility rule §F governs multi-team chrome, which this 0.3 tab
 * does not render). Editable by project Admin+ or an explicit team Admin; everyone
 * else sees the roster read-only.
 */

import { useMemo, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import { TeamMemberRow } from './TeamMemberRow';
import {
  useDefaultTeam,
  useTeamMembers,
  useUpdateTeamMember,
  type TeamFacet,
  type TeamMember,
  type TeamRole,
} from './useTeam';

const FACET_LABEL: Record<TeamFacet, string> = {
  is_scrum_master: 'Scrum Master',
  is_product_owner: 'Product Owner',
};

interface PendingReassign {
  member: TeamMember;
  facet: TeamFacet;
  holderName: string;
}

export function ProjectTeamPage() {
  const projectId = useProjectId();
  const { user } = useCurrentUser();
  const { role: myRole } = useCurrentUserRole(projectId);
  const { data: team, isLoading: teamLoading, isError: teamError } = useDefaultTeam(projectId);
  const {
    data: members = [],
    isLoading: membersLoading,
    isError: membersError,
  } = useTeamMembers(team?.id);
  const { mutate, isPending, variables, isError: saveError } = useUpdateTeamMember(team?.id);

  const [pending, setPending] = useState<PendingReassign | null>(null);

  // Edit rights: project Admin+ (inheritance) OR an explicit team-Admin row
  // (ADR-0078 §D low-consent bucket). Pessimistic while role/user load.
  const canEdit = useMemo(() => {
    if (myRole !== null && myRole >= ROLE_ADMIN) return true;
    const mine = members.find((m) => String(m.user_detail.id) === String(user?.id));
    return mine?.role === 'admin';
  }, [myRole, members, user?.id]);

  if (!projectId) return null;

  const isLoading = teamLoading || membersLoading;
  const isError = teamError || membersError;

  function applyChange(
    membershipId: string,
    changes: Partial<Pick<TeamMember, 'role' | 'is_scrum_master' | 'is_product_owner'>>,
  ) {
    mutate({ membershipId, changes });
  }

  function handleToggleFacet(member: TeamMember, facet: TeamFacet, next: boolean) {
    if (!next) {
      applyChange(member.id, { [facet]: false });
      return;
    }
    // Turning a facet on: if another member already holds it, confirm the
    // reassignment first (the server moves it; we surface the move, not block it).
    const holder = members.find((m) => m.id !== member.id && m[facet]);
    if (holder) {
      setPending({ member, facet, holderName: holder.user_detail.username });
      return;
    }
    applyChange(member.id, { [facet]: true });
  }

  function confirmReassign() {
    if (!pending) return;
    applyChange(pending.member.id, { [pending.facet]: true });
    setPending(null);
  }

  // Which facet (if any) is mid-flight for a given row, for the spinner state.
  function pendingFacetFor(membershipId: string): TeamFacet | null {
    if (!isPending || variables?.membershipId !== membershipId) return null;
    if (variables.changes.is_scrum_master !== undefined) return 'is_scrum_master';
    if (variables.changes.is_product_owner !== undefined) return 'is_product_owner';
    return null;
  }

  return (
    <div>
      <SettingsPageTitle
        title="Team"
        subtitle="Assign facilitation and ownership. Roles control who can manage the team; facets mark the Scrum Master and Product Owner — independent of role."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        {pending && (
          <div
            role="alertdialog"
            aria-label="Confirm reassignment"
            className="mb-4 flex items-center justify-between gap-3 rounded-card border border-neutral-border bg-neutral-surface-raised px-4 py-3"
          >
            <p className="text-[13px] text-neutral-text-primary">
              {pending.holderName} is currently {FACET_LABEL[pending.facet]}. Make{' '}
              {pending.member.user_detail.username} the {FACET_LABEL[pending.facet]} instead?
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={confirmReassign}
                className="h-7 rounded bg-brand-primary px-3 text-[12px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Reassign
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="h-7 rounded border border-neutral-border px-3 text-[12px] font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {saveError && (
          <p role="alert" className="mb-3 text-[13px] text-semantic-critical">
            Couldn&apos;t update the team — please try again.
          </p>
        )}

        {isLoading && (
          <div className="space-y-px" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-14 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <p role="alert" className="py-4 text-[13px] text-semantic-critical">
            Failed to load the team — please refresh.
          </p>
        )}

        {!isLoading && !isError && (
          <>
            {/* Desktop column headers. The mobile layout (< sm) labels each control
                inline per row, so these only show once the row goes horizontal.
                aria-hidden: each control already carries its own accessible name
                (the role <select> and the two facet switches), so headers here would
                only add screen-reader noise — they are a sighted-user cue (#974). */}
            {members.length > 0 && (
              <div
                aria-hidden="true"
                data-testid="team-columns"
                className="hidden items-center gap-3 px-4 pb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-text-secondary sm:flex"
              >
                <span className="flex-1">Member</span>
                <span className="w-32">Role</span>
                <span className="w-36">Scrum Master</span>
                <span className="w-36">Product Owner</span>
              </div>
            )}
            <ul className="divide-y divide-neutral-border rounded-card border border-neutral-border">
              {members.length === 0 ? (
                <li className="px-4 py-6 text-[13px] text-neutral-text-disabled">
                  No team members yet — add people in the Access tab.
                </li>
              ) : (
                members.map((member) => (
                  <TeamMemberRow
                    key={member.id}
                    member={member}
                    canEdit={canEdit}
                    pendingFacet={pendingFacetFor(member.id)}
                    onChangeRole={(membershipId: string, role: TeamRole) =>
                      applyChange(membershipId, { role })
                    }
                    onToggleFacet={handleToggleFacet}
                  />
                ))
              )}
            </ul>
            {canEdit && members.length > 0 && (
              <p className="mt-3 text-[12px] text-neutral-text-secondary">
                At most one Scrum Master and one Product Owner. Reassigning moves the facet.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
