/**
 * Scoped display vocabulary for the shared role ordinals (#3476).
 *
 * The five OSS role ordinals (`@/lib/roles`, ADR-0072) are one axis, but their
 * *names* are scope-dependent: the same ordinal 400 is "Project Admin" on a
 * project and "Program Admin" on a program. The server already draws that
 * distinction — `ProgramSerializer.my_role_label` maps through
 * `_PROGRAM_ROLE_LABELS` while `Role.label` stays project-scoped — and the
 * program member surfaces were the ones that did not, so `/programs/:id/members`
 * offered "Project Manager / Project Admin" for a program role and disagreed with
 * the program card two clicks away, which reads the same membership as "Program
 * Admin".
 *
 * Two renderings of one fact must come from one derivation (web rule 316), and on
 * these surfaces there are exactly two: the `<select>` a manager changes the role
 * with, and the read-only badge shown where the picker is withheld. The picker
 * cannot take its options from the server — it offers roles nobody in the list
 * holds yet — so a client-side vocabulary is unavoidable; this module is that
 * vocabulary, and the badge reads it too so the two can never disagree.
 *
 * `roleLabel()` falls back to the SERVER's own string for an ordinal this map
 * does not know. That is the case that matters: the 2–99 / 101–199 / 201–299 /
 * 301–399 bands are reserved for Enterprise custom roles (ADR-0072), so an
 * ordinal outside the five is not a bug, it is the extension contract working —
 * and echoing the server's label is strictly better than inventing one or
 * rendering a bare number (web rule 301(b)/(c): the unknown branch degrades, it
 * does not lie).
 */
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER } from './roles';

/** Which container's vocabulary a role is being named in. */
export type RoleScope = 'project' | 'program';

/**
 * Roles a manager may grant through the picker, lowest first.
 *
 * OWNER is deliberately absent: the API rejects `new_role >= actor_role` for an
 * OWNER actor, so it is never a grantable option. It still has a label below,
 * because the read-only badge on an Owner row has to name it.
 */
export const GRANTABLE_ROLES: readonly number[] = [
  ROLE_VIEWER,
  ROLE_MEMBER,
  ROLE_SCHEDULER,
  ROLE_ADMIN,
];

/**
 * Ordinal → display name, per scope. Mirrors the server: `Role.label`
 * (`apps/access/models.py`) for `project`, `_PROGRAM_ROLE_LABELS`
 * (`apps/projects/serializers.py`) for `program`. Only ADMIN and OWNER differ —
 * the lower three roles describe a person, not a container, and read the same
 * either way.
 */
const ROLE_LABELS: Record<RoleScope, Readonly<Record<number, string>>> = {
  project: {
    [ROLE_VIEWER]: 'Viewer',
    [ROLE_MEMBER]: 'Team Member',
    [ROLE_SCHEDULER]: 'Resource Manager',
    [ROLE_ADMIN]: 'Project Manager',
    [ROLE_OWNER]: 'Project Admin',
  },
  program: {
    [ROLE_VIEWER]: 'Viewer',
    [ROLE_MEMBER]: 'Team Member',
    [ROLE_SCHEDULER]: 'Resource Manager',
    [ROLE_ADMIN]: 'Program Manager',
    [ROLE_OWNER]: 'Program Admin',
  },
};

/**
 * One-line description of what each grantable role may do, per scope. Rendered as
 * the `<option>`'s `title`, so it must stay a plain sentence — it is pointer-only
 * help, never the option's accessible name.
 */
const ROLE_DESCRIPTIONS: Record<RoleScope, Readonly<Record<number, string>>> = {
  project: {
    [ROLE_VIEWER]: 'Read-only access to all project data',
    [ROLE_MEMBER]: 'Can log time and update assigned tasks',
    [ROLE_SCHEDULER]: 'Can manage the team roster and assignments',
    [ROLE_ADMIN]: 'Full project control — schedule, baselines, board',
  },
  program: {
    [ROLE_VIEWER]: 'Read-only access to all program data',
    [ROLE_MEMBER]: 'Can log time and update assigned tasks',
    [ROLE_SCHEDULER]: 'Can manage the team roster and assignments',
    [ROLE_ADMIN]: 'Full program control — backlog, projects, cadence',
  },
};

/**
 * Display name for `role` in `scope`.
 *
 * `serverLabel` is the `role_label` the API sent for this membership, used as the
 * fallback for an ordinal outside the five OSS roles (an Enterprise custom role
 * in a reserved band). Pass it wherever you have it; without it an unknown
 * ordinal degrades to "Unknown role" rather than silently borrowing a
 * neighbouring role's name or leaking the raw ordinal as copy (web rule 301(c)).
 */
export function roleLabel(role: number, scope: RoleScope, serverLabel?: string | null): string {
  return ROLE_LABELS[scope][role] ?? serverLabel ?? 'Unknown role';
}

/** Pointer-only description for a grantable role, or `undefined` when none. */
export function roleDescription(role: number, scope: RoleScope): string | undefined {
  return ROLE_DESCRIPTIONS[scope][role];
}
