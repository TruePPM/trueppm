import type { Project } from '@/types';

/**
 * Whether the caller holds a membership on `project` — false only for a
 * WORKSPACE-visible row they can see but not open (`myRole === null`, ADR-1434).
 *
 * `undefined` (a list shape or fixture that does not carry the role) reads as a
 * member, because every row `GET /projects/` returned before ADR-1434 was one.
 */
export function isMemberProject(project: Pick<Project, 'myRole'>): boolean {
  return project.myRole !== null;
}
