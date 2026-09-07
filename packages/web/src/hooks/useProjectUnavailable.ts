import axios from 'axios';
import { useProject } from './useProject';

/**
 * Whether the project at `projectId` resolved as unreachable for this caller.
 *
 * `GET /projects/{id}/` is queryset-scoped to the caller's own
 * `ProjectMembership` rows, so a deleted project, a stale bookmark and a
 * project the caller simply is not a member of all 404 identically (#1111,
 * #2040). A 403 can still arrive on an edge path, so both are "unavailable".
 *
 * This exists as a hook rather than as a private detail of `ProjectShell`
 * because "the project is not there" is a **route-level** fact and the chrome
 * lives outside the route: the rail, the health chip, the location switcher and
 * the status bar are all mounted by `AppShell`, above `<Outlet />`. Each of them
 * read `useProject(...).data` with an optimistic literal fallback and none read
 * its error, so on a project the caller cannot open they kept describing a
 * project that is not there — a placeholder "Project · Hybrid methodology" card,
 * an "On track" health chip and a permanent "Connecting…" (#3469). One hook so
 * all four branch on exactly the condition `ProjectShell` branches on, and
 * cannot drift apart.
 *
 * Free to call anywhere: React Query dedupes every consumer of the
 * `['project', id]` key, so this issues no request of its own.
 */
export function useProjectUnavailable(projectId: string | null | undefined): boolean {
  const { error } = useProject(projectId ?? null);
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return Boolean(projectId) && (status === 404 || status === 403);
}
