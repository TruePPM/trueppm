/**
 * "Default role for new members" setting (ADR-0363, #157).
 *
 * The role a person receives when added to the project without an explicit role.
 * A convenience default — no lock, no enforcement (governance is Enterprise). The
 * PATCH is Admin+-gated server-side; the caller gates rendering to Admin+ so the
 * control never flashes for roles the server would 403. Saves on change (no
 * separate submit), mirroring the low-friction inline settings pattern.
 */
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { RolePicker } from './RolePicker';

interface Props {
  projectId: string;
}

export function DefaultMemberRoleSetting({ projectId }: Props) {
  const { data: project, isLoading } = useProject(projectId);
  const { mutate, isPending, isError } = useUpdateProject(projectId);

  return (
    <section aria-labelledby="default-role-heading">
      <h2
        id="default-role-heading"
        className="text-base font-semibold text-neutral-text-primary mb-1"
      >
        Default role for new members
      </h2>
      <p className="text-sm text-neutral-text-secondary mb-4">
        The role a person gets when added to this project without one chosen. You can
        override it per person, and change this default any time.
      </p>
      {isLoading || !project ? (
        <div className="h-8 w-48 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
      ) : (
        <div className="flex items-center gap-3">
          <RolePicker
            id="default-member-role"
            ariaLabel="Default role for new members"
            value={project.default_member_role}
            disabled={isPending}
            onChange={(role) => mutate({ default_member_role: role })}
          />
          {isPending && (
            <span className="text-xs text-neutral-text-secondary">Saving…</span>
          )}
          {isError && (
            <span role="alert" className="text-xs text-semantic-critical">
              Couldn&rsquo;t save — please try again.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
