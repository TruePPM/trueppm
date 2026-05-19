import { useParams } from 'react-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProgram } from '@/hooks/useProgram';
import { useProgramMembers } from '../hooks/useProgramMembers';
import {
  useRemoveProgramMember,
  useUpdateProgramMemberRole,
} from '../hooks/useProgramMemberMutations';
import { ProgramInviteForm } from './ProgramInviteForm';
import { ProgramMemberRow } from './ProgramMemberRow';
import { ROLE_OWNER } from '@/lib/roles';

/**
 * /programs/:programId/members — manage program membership (ADR-0070).
 *
 * Mirrors the project Members tab (ADR-0061, #144). The third placement of
 * the cascading-access onboarding hint lives here, alongside the invite form,
 * because that is exactly where the gotcha is most likely to bite.
 */
export function ProgramMembersTab() {
  const params = useParams<{ programId: string }>();
  const programId = params.programId;
  const { user } = useCurrentUser();
  const { data: program } = useProgram(programId);
  const { data: members = [], isLoading, isError } = useProgramMembers(programId);
  const { mutate: updateRole, isPending: isUpdatingRole } = useUpdateProgramMemberRole(
    programId ?? '',
  );
  const { mutate: removeMember, isPending: isRemoving } = useRemoveProgramMember(programId ?? '');

  if (!programId) return null;

  const isOwnerRole = program?.my_role === ROLE_OWNER;
  const ownerCount = members.filter((m) => m.role === ROLE_OWNER).length;

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <section aria-labelledby="program-members-heading">
        <h2
          id="program-members-heading"
          className="mb-4 flex items-center gap-2 text-base font-semibold text-neutral-text-primary"
        >
          Members
          {members.length > 0 && (
            <span className="tppm-mono text-sm font-normal text-neutral-text-secondary">
              {members.length}
            </span>
          )}
          {/* Cascading-access onboarding hint — third placement (ADR-0070 §Risks). */}
          <span
            className="ml-auto text-xs font-normal text-neutral-text-secondary"
            title="Program members can view the program backlog and projects list. They are not automatically added to individual projects — invite them to each project separately."
          >
            <span aria-hidden="true">ⓘ</span>
            <span className="sr-only">
              Program members can view the program backlog and projects list. They are not
              automatically added to individual projects.
            </span>
          </span>
        </h2>

        {isLoading && (
          <div className="space-y-px">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                aria-hidden="true"
                className="h-14 animate-pulse rounded bg-neutral-surface-raised"
              />
            ))}
          </div>
        )}

        {isError && (
          <p role="alert" className="py-4 text-sm text-semantic-critical">
            Failed to load members &mdash; please refresh.
          </p>
        )}

        {!isLoading && !isError && members.length === 0 && (
          <p className="py-4 text-sm text-neutral-text-disabled">
            No members yet. Add someone below.
          </p>
        )}

        {!isLoading && !isError && members.length > 0 && (
          <ul
            aria-label="Program members"
            className="divide-y divide-neutral-border rounded border border-neutral-border bg-neutral-surface"
          >
            {members.map((m) => (
              <ProgramMemberRow
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

      {isOwnerRole && (
        <section aria-labelledby="program-invite-heading">
          <h2 id="program-invite-heading" className="mb-3 text-base font-semibold text-neutral-text-primary">
            Add a member
          </h2>
          <ProgramInviteForm programId={programId} />
        </section>
      )}
    </div>
  );
}
