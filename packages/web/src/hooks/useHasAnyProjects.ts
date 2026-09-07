import { usePrograms } from './usePrograms';
import { useProjects } from './useProjects';

/**
 * Whether this user has any project in view at all — one they hold a
 * `ProjectMembership` on, **or** one inside a program they belong to.
 *
 * `GET /projects/` is membership-scoped while `GET /programs/{id}/projects/` is
 * program-scoped, so a program Owner with no project memberships reads as a
 * brand-new zero-project user to anything that counts only the first list: the
 * rail's pinned tier and My Work both told the owner of a four-project program
 * "No projects yet — create one or load a demo" (#3469). The program's own
 * `project_count` is the cheap answer — it is already annotated on every row of
 * the member-scoped program list the shell fetches once and caches under
 * `['programs']`, so this reads it rather than fanning out one roster request
 * per program.
 *
 * This answers "does this user have somewhere to be", not "can they open it" —
 * a program project still requires project membership to open (#3439). It is
 * therefore only ever used to choose between an onboarding empty state and a
 * "nothing assigned to you" one, never to gate an affordance.
 *
 * Issues no request of its own: both queries are already mounted by the shell.
 */
export function useHasAnyProjects(): boolean {
  const { data: projects } = useProjects();
  const { data: programs } = usePrograms();
  return (
    (projects ?? []).length > 0 || (programs ?? []).some((p) => (p.project_count ?? 0) > 0)
  );
}
